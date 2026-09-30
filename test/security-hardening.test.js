'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const dns = require('node:dns').promises;
const https = require('node:https');
const { createHash } = require('node:crypto');
const WebSocket = require('ws');
const oauth = require('../lib/oauth');
const ROOT = path.join(__dirname, '..');
const sha = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const client = id => ({clientId:id, secretHash:sha('fixture-client-secret'), name:'Fixture'});

function frame(ws, type) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error(`Missing ${type}`)), 6000);
        const listener = raw => {
            const message = JSON.parse(raw);
            if (message.type === type) finish(null, message);
        };
        const closed = () => finish(new Error(`Closed before ${type}`));
        const finish = (error, message) => {
            clearTimeout(timer); ws.off('message',listener); ws.off('close',closed);
            if (error) reject(error); else resolve(message);
        };
        ws.on('message',listener); ws.once('close',closed);
    });
}

async function withRelay({env={},seed={},instrument=''}={},run) {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-hardening-'));
    const stateFile=path.join(dir,'state.json');
    fs.writeFileSync(stateFile,JSON.stringify({version:13,...seed}));
    const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
    const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
    const source=`process.loadEnvFile=undefined;
        const moduleStore=require(${JSON.stringify(path.join(ROOT,'lib/store'))});
        const originalOpen=moduleStore.openStore;
        moduleStore.openStore=async (...args)=>{const store=await originalOpen(...args);${instrument};return store};
        require(${JSON.stringify(path.join(ROOT,'server.js'))});`;
    const child=spawn(process.execPath,['-e',source],{cwd:dir,windowsHide:true,
        env:{...process.env,DATABASE_URL:'',BRIDGE_STATE_FILE:stateFile,PORT:String(port),NODE_OPTIONS:'',
            PUBLIC_ORIGIN:'',RENDER_EXTERNAL_URL:'',TRUSTED_PROXIES:'',ALLOWED_ORIGINS:'',
            GOOGLE_PLAY_SERVICE_ACCOUNT_JSON:'',GOOGLE_APPLICATION_CREDENTIALS:'',...env},
        stdio:['ignore','pipe','pipe','ipc']});
    const sockets=[];let errors='';
    child.stderr.on('data',b=>{errors+=b.toString()});
    try {
        await new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>reject(new Error('startup timeout: '+errors)),10000);
            child.stdout.on('data',b=>{if(b.toString().includes('listening on port')) {clearTimeout(timer);resolve()}});
            child.once('exit',code=>{clearTimeout(timer);reject(new Error(`exit ${code}: ${errors}`))});
        });
        async function socket() {
            const ws=new WebSocket(`ws://127.0.0.1:${port}`);sockets.push(ws);
            ws.on('error',()=>{});await once(ws,'open');return ws;
        }
        async function phone(id,clients=[],secret='fixture-device-secret') {
            const ws=await socket();const next=frame(ws,'register_ack');
            ws.send(JSON.stringify({type:'register',deviceId:id,deviceSecret:secret,clients}));
            return {ws,ack:await next};
        }
        async function rejectedPhone(id,clients=[]) {
            const ws=await socket();const next=frame(ws,'register_nack');
            ws.send(JSON.stringify({type:'register',deviceId:id,deviceSecret:'fixture-device-secret',clients}));
            return next;
        }
        const request=(url,options={})=>fetch(`http://127.0.0.1:${port}${url}`,{
            ...options,signal:AbortSignal.timeout(5000)});
        await run({phone,rejectedPhone,socket,request,child,stateFile,
            state:()=>JSON.parse(fs.readFileSync(stateFile,'utf8'))});
    } finally {
        sockets.forEach(ws=>ws.terminate());
        if(child.exitCode===null) {const ended=once(child,'exit');child.kill();await ended;}
        for(const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir,name));
        fs.rmdirSync(dir);
    }
}

test('successful registrations do not reset the WebSocket IP budget',async()=>{
    await withRelay({env:{LIMIT_WEBSOCKET_MAX:'2'}},async h=>{
        await h.phone('dev-one');await h.phone('dev-two');
        await assert.rejects(h.socket(),/429/);
    });
});

for(const setting of ['LIMIT_DEVICE_ENROLL_MAX','LIMIT_DEVICE_ENROLL_GLOBAL_MAX','MAX_REGISTERED_DEVICES']) {
    test(`${setting} bounds new identities and preserves existing reconnects`,async()=>{
        await withRelay({env:{[setting]:'2'}},async h=>{
            await h.phone('dev-one');await h.phone('dev-two');
            assert.equal((await h.rejectedPhone('dev-three')).type,'register_nack');
            assert.equal((await h.phone('dev-one')).ack.type,'register_ack');
            await delay(300);
            assert.deepEqual(Object.keys(h.state().devices).sort(),['dev-one','dev-two']);
        });
    });
}

test('the global open-socket cap includes authenticated phones and releases on close',async()=>{
    await withRelay({env:{MAX_WS_CONNECTIONS_GLOBAL:'2'}},async h=>{
        const first=await h.phone('dev-one');await h.phone('dev-two');
        await assert.rejects(h.socket(),/429/);
        const closed=once(first.ws,'close');first.ws.close();await closed;
        assert.equal((await h.phone('dev-three')).ack.type,'register_ack');
    });
});

test('bulk unclaimed registration deduplicates identities and limits later additions',async()=>{
    await withRelay({env:{MAX_UNCLAIMED_CLIENTS:'2'}},async h=>{
        const p=await h.phone('dev-one',[client('cli-one'),client('cli-one'),client('cli-two'),client('cli-three')]);
        assert.deepEqual(p.ack.clientLimitRejected,['cli-three']);
        const rejected=frame(p.ws,'client_limit_rejected');
        p.ws.send(JSON.stringify({type:'client_added',...client('cli-four')}));
        assert.equal((await rejected).clientId,'cli-four');
        await delay(300);
        assert.deepEqual(Object.keys(h.state().clients).sort(),['cli-one','cli-two']);
    });
});

test('queued client additions cannot both consume the last unclaimed slot',async()=>{
    await withRelay({env:{MAX_UNCLAIMED_CLIENTS:'2'}},async h=>{
        const p=await h.phone('dev-one',[client('cli-one')]);
        const rejected=frame(p.ws,'client_limit_rejected');
        p.ws.send(JSON.stringify({type:'client_added',...client('cli-two')}));
        p.ws.send(JSON.stringify({type:'client_added',...client('cli-three')}));
        assert.equal((await rejected).clientId,'cli-three');
        await delay(300);
        assert.deepEqual(Object.keys(h.state().clients).sort(),['cli-one','cli-two']);
    });
});

test('the global client ceiling applies across phones without deleting existing clients',async()=>{
    await withRelay({env:{MAX_REGISTERED_CLIENTS:'3'}},async h=>{
        await h.phone('dev-one',[client('cli-one'),client('cli-two')]);
        const p=await h.phone('dev-two',[client('cli-three'),client('cli-four')]);
        assert.deepEqual(p.ack.clientLimitRejected,['cli-four']);
        assert.deepEqual((await h.phone('dev-one',[client('cli-one'),client('cli-two')])).ack.clientLimitRejected,[]);
        await delay(300);assert.equal(Object.keys(h.state().clients).length,3);
    });
});

test('a legacy unclaimed phone keeps all existing routes above a lowered ceiling',async()=>{
    const seed={devices:{'dev-legacy':{id:'dev-legacy',accountId:null,secretHash:sha('fixture-device-secret')}},clients:{},clientDevices:{}};
    for(const id of ['cli-one','cli-two','cli-three']) {
        seed.clients[id]={id,deviceId:'dev-legacy',accountId:null,secretHash:sha('fixture-client-secret')};
        seed.clientDevices[`${id}|dev-legacy`]={clientId:id,deviceId:'dev-legacy'};
    }
    await withRelay({seed,env:{MAX_UNCLAIMED_CLIENTS:'2'}},async h=>{
        const p=await h.phone('dev-legacy',['cli-one','cli-two','cli-three','cli-four'].map(client));
        assert.deepEqual(p.ack.clientLimitRejected,['cli-four']);
        await delay(300);assert.equal(Object.keys(h.state().clients).length,3);
    });
});

test('concurrent first enrolments cannot overwrite the device secret',async()=>{
    await withRelay({},async h=>{
        const a=await h.socket(),b=await h.socket();
        const read=ws=>new Promise(resolve=>ws.once('message',raw=>resolve(JSON.parse(raw))));
        const responses=Promise.all([read(a),read(b)]);
        a.send(JSON.stringify({type:'register',deviceId:'dev-race',deviceSecret:'first-device-secret'}));
        b.send(JSON.stringify({type:'register',deviceId:'dev-race',deviceSecret:'second-device-secret'}));
        const frames=await responses;
        assert.deepEqual(frames.map(f=>f.type).sort(),['register_ack','register_nack']);
        const winner=frames[0].type==='register_ack'?'first-device-secret':'second-device-secret';
        const loser=winner==='first-device-secret'?'second-device-secret':'first-device-secret';
        assert.equal((await h.request('/api/v1/account',{headers:{authorization:`Bearer dev-race.${winner}`}})).status,200);
        assert.equal((await h.request('/api/v1/account',{headers:{authorization:`Bearer dev-race.${loser}`}})).status,401);
    });
});

function accountSeed(status='suspended',missing=false) {
    return {accounts:missing?{}:{'account-fixture':{id:'account-fixture',status,plan:'free',defaultDeviceId:'dev-account'}},
        devices:{'dev-account':{id:'dev-account',accountId:'account-fixture',secretHash:sha('fixture-device-secret')}},
        clients:{'cli-account':{id:'cli-account',deviceId:'dev-account',accountId:'account-fixture',secretHash:sha('fixture-client-secret')}},
        clientDevices:{'cli-account|dev-account':{clientId:'cli-account',deviceId:'dev-account'}}};
}
const rpc=h=>h.request('/mcp',{method:'POST',headers:{authorization:'Bearer cli-account.fixture-client-secret','content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'browser_list_tabs',arguments:{}}})});

test('a suspended account stays blocked throughout delayed registry refreshes',async()=>{
    const instrument=`const read=store.getAccountById.bind(store);
        store.getAccountById=async (...args)=>{process.send({type:'account-read'});await new Promise(r=>setTimeout(r,250));return read(...args)};`;
    await withRelay({seed:accountSeed(),instrument},async h=>{
        assert.equal((await rpc(h)).status,403);
        const reading=once(h.child,'message');
        const opening=h.phone('dev-account',[client('cli-account')]);
        await reading;
        for(let i=0;i<4;i++) assert.equal((await rpc(h)).status,403);
        await opening;
        assert.equal((await rpc(h)).status,403);
    });
});

test('a failed refresh retains the complete previous snapshot',async()=>{
    const instrument=`const read=store.getAccountById.bind(store);let reads=0;
        store.getAccountById=async (...args)=>{if(++reads>1)throw new Error('fixture read failure');return read(...args)};`;
    await withRelay({seed:accountSeed(),instrument},async h=>{
        const ws=await h.socket();const failure=frame(ws,'bridge_error');
        ws.send(JSON.stringify({type:'register',deviceId:'dev-account',deviceSecret:'fixture-device-secret',clients:[client('cli-account')]}));
        await failure;assert.equal((await rpc(h)).status,403);
    });
});

test('account-owned credentials fail closed when account metadata is missing',async()=>{
    await withRelay({seed:accountSeed('active',true)},async h=>{
        const response=await rpc(h);assert.equal(response.status,503);
        assert.equal((await response.json()).error,'account_unavailable');
        assert.equal(response.headers.get('retry-after'),'5');
    });
});

test('registry capacities use durable counts even after publication fails',async()=>{
    const instrument=`const read=store.getAccountById.bind(store);let reads=0;
        store.getAccountById=async (...args)=>{if(++reads>1)throw new Error('fixture read failure');return read(...args)};`;
    await withRelay({seed:accountSeed(),instrument,
        env:{MAX_REGISTERED_DEVICES:'2',MAX_REGISTERED_CLIENTS:'2'}},async h=>{
        const ws=await h.socket();const failure=frame(ws,'bridge_error');
        ws.send(JSON.stringify({type:'register',deviceId:'dev-new',deviceSecret:'fixture-device-secret',clients:[client('cli-new')]}));
        await failure;
        assert.match((await h.rejectedPhone('dev-over-capacity')).reason,/kapasitesi dolu/);
        const retry=await h.socket();const secondFailure=frame(retry,'bridge_error');
        retry.send(JSON.stringify({type:'register',deviceId:'dev-new',deviceSecret:'fixture-device-secret',clients:[client('cli-new'),client('cli-over-capacity')]}));
        await secondFailure;await delay(300);
        assert.equal(Object.keys(h.state().devices).length,2);
        assert.equal(Object.keys(h.state().clients).length,2);
    });
});

test('OAuth authorization rate limiting runs before metadata fetching',async()=>{
    await withRelay({env:{LIMIT_METADATA_MAX:'2'}},async h=>{
        const statuses=[];
        for(let i=0;i<3;i++) statuses.push((await h.request('/oauth/authorize')).status);
        assert.deepEqual(statuses,[400,400,429]);
        assert.equal((await h.request('/oauth/authorize',{method:'POST'})).status,429);
    });
});

test('CIMD blocks private and special IP ranges including mapped IPv6 before HTTPS',async t=>{
    const addresses=['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1',
        '198.18.0.1','192.0.2.1','0.0.0.0','224.0.0.1','::1','::','fd00::1','fe80::1',
        '::ffff:127.0.0.1','::ffff:7f00:1','::ffff:192.168.1.1','::ffff:c0a8:101',
        '64:ff9b::7f00:1','2002:7f00:1::1','2001:db8::1'];
    let address;let calls=0;
    t.mock.method(dns,'lookup',async()=>[{address,family:net.isIP(address)}]);
    t.mock.method(https,'request',()=>{calls++;throw new Error('network must be blocked')});
    for(address of addresses) assert.match((await oauth.resolveClientMetadata('https://fixture.example/client.json')).error,/genel bir internet/);
    assert.equal(calls,0);
    assert.match((await oauth.resolveClientMetadata('https://[::ffff:127.0.0.1]/client.json')).error,/genel bir internet/);
    assert.equal(calls,0);
});

function mockMetadata(t,{body,status=200,address='8.8.8.8'}={}) {
    const chosen={address,family:net.isIP(address)};let destroyed=0;let requests=0;
    t.mock.method(dns,'lookup',async()=>[chosen]);
    t.mock.method(https,'request',(_url,options,callback)=>{
        requests++;options.lookup('fixture.example',{all:true},(error,result)=>{
            assert.ifError(error);assert.deepEqual(result,[chosen]);
        });
        options.lookup('fixture.example',{},(error,ip,family)=>{
            assert.ifError(error);assert.equal(ip,address);assert.equal(family,chosen.family);
        });
        const req=new EventEmitter();req.destroy=()=>{destroyed++};
        req.end=()=>queueMicrotask(()=>{
            const res=new EventEmitter();res.statusCode=status;callback(res);
            if(body!==undefined){res.emit('data',Buffer.from(body));res.emit('end')}
        });return req;
    });
    return {requests:()=>requests,destroyed:()=>destroyed};
}
const document=JSON.stringify({client_id:'https://fixture.example/client.json',client_name:'Fixture',
    redirect_uris:['https://fixture.example/callback'],token_endpoint_auth_method:'none'});

test('public CIMD metadata still succeeds and pins every DNS lookup form',async t=>{
    const mock=mockMetadata(t,{body:document,address:'::ffff:8.8.8.8'});
    const result=await oauth.resolveClientMetadata('https://fixture.example/client.json');
    assert.equal(result.record.name,'Fixture');assert.equal(mock.requests(),1);
});

test('CIMD caps the encoded UTF-8 body bytes and does not follow redirects',async t=>{
    const mock=mockMetadata(t,{body:'é'.repeat(40000)});
    assert.match((await oauth.resolveClientMetadata('https://fixture.example/client.json')).error,/çok büyük/);
    assert.equal(mock.destroyed(),1);
    t.mock.restoreAll();
    const redirect=mockMetadata(t,{status:302});
    assert.match((await oauth.resolveClientMetadata('https://fixture.example/client.json')).error,/HTTP 302/);
    assert.equal(redirect.requests(),1);assert.equal(redirect.destroyed(),1);
});

test('CIMD bounds concurrent DNS reads and never connects after a total timeout',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    const resolves=[];let requests=0;
    t.mock.method(dns,'lookup',()=>new Promise(resolve=>resolves.push(resolve)));
    t.mock.method(https,'request',()=>{requests++;throw new Error('late connection')});
    const pending=Array.from({length:16},()=>oauth.resolveClientMetadata('https://fixture.example/client.json'));
    assert.match((await oauth.resolveClientMetadata('https://fixture.example/client.json')).error,/Çok fazla/);
    await Promise.resolve();t.mock.timers.tick(5000);
    const results=await Promise.all(pending);results.forEach(result=>assert.match(result.error,/süresi doldu/));
    resolves.forEach(resolve=>resolve([{address:'8.8.8.8',family:4}]));
    await Promise.resolve();await Promise.resolve();assert.equal(requests,0);
    t.mock.restoreAll();
    mockMetadata(t,{body:document});
    assert.equal((await oauth.resolveClientMetadata('https://fixture.example/client.json')).record.name,'Fixture');
});

test('the total metadata deadline includes body transfer and destroys slow requests',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    const mock=mockMetadata(t);
    const pending=oauth.resolveClientMetadata('https://fixture.example/client.json');
    await Promise.resolve();await Promise.resolve();await Promise.resolve();
    t.mock.timers.tick(5000);
    assert.match((await pending).error,/süresi doldu/);
    assert.equal(mock.destroyed(),1);
});
