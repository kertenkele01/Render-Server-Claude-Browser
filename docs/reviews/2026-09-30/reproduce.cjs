'use strict';
// Bounded checks against a disposable loopback relay. No real credentials,
// external hosts, production state or load-test traffic are used.
// Default mode documents the original vulnerable baseline; --fixed verifies
// the repaired behavior without overwriting the original evidence.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const dns = require('node:dns').promises;
const https = require('node:https');
const { EventEmitter, once } = require('node:events');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const ROOT = path.resolve(__dirname, '../../..');
const EXPECT_FIXED = process.argv.includes('--fixed');
const sha = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function unusedPort() {
    const s = net.createServer();
    s.listen(0, '127.0.0.1'); await once(s, 'listening');
    const port = s.address().port; await new Promise(resolve => s.close(resolve));
    return port;
}

async function relayCheck() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-audit-20260930-'));
    const stateFile = path.join(dir, 'state.json');
    const storeModule = require(path.join(ROOT, 'lib/store'));
    const store = await storeModule.openStore({ stateFile, databaseUrl: '' });
    const account = await store.createAccount({email:'audit-suspended@example.invalid', passwordHash:'fixture',passwordSalt:'fixture'});
    await store.upsertDevice({id:'audit-suspended', accountId:account.id, secretHash:sha('audit-device-secret'),name:'Audit fixture'});
    await store.upsertClient({id:'audit-client',deviceId:'audit-suspended',secretHash:sha('audit-client-secret'),name:'Audit fixture'});
    await store.setAccountStatus(account.id, 'suspended');
    await store.close();
    const port = await unusedPort();
    // A delay on a read simulates asynchronous database I/O; the file driver's
    // immediately fulfilled promises otherwise hide the production window.
    const source = `process.loadEnvFile=undefined;
      const m=require(${JSON.stringify(path.join(ROOT,'lib/store'))});
      const original=m.openStore;
      m.openStore=async (...args)=>{const s=await original(...args);const read=s.getAccountById.bind(s);
        s.getAccountById=async (...a)=>{await new Promise(r=>setTimeout(r,250));return read(...a)};return s};
      require(${JSON.stringify(path.join(ROOT,'server.js'))});`;
    const child = spawn(process.execPath,['-e',source],{cwd:dir,windowsHide:true,
        env:{...process.env,DATABASE_URL:'',BRIDGE_STATE_FILE:stateFile,PORT:String(port),
            PUBLIC_ORIGIN:'',RENDER_EXTERNAL_URL:'',TRUSTED_PROXIES:'',ALLOWED_ORIGINS:'',
            LIMIT_WEBSOCKET_MAX:EXPECT_FIXED?'8':'2',LIMIT_REGISTER_MAX:'2',NODE_OPTIONS:'',
            MAX_UNCLAIMED_CLIENTS:'10',
            GOOGLE_PLAY_SERVICE_ACCOUNT_JSON:'',GOOGLE_APPLICATION_CREDENTIALS:''},
        stdio:['ignore','pipe','pipe']});
    let logs=''; const sockets=[]; const forwarded=[];
    child.stdout.on('data',b=>{logs+=b.toString()});
    child.stderr.on('data',()=>{});
    const base=`http://127.0.0.1:${port}`;
    const credential={authorization:'Bearer audit-client.audit-client-secret'};
    async function connect() {
        const ws=new WebSocket(`ws://127.0.0.1:${port}`); sockets.push(ws);
        ws.on('error',()=>{});
        ws.on('message',raw=>{const frame=JSON.parse(raw);
            if(frame.type==='list_tabs' && frame.messageId) {
                forwarded.push(frame.type);
                ws.send(JSON.stringify({type:'response',messageId:frame.messageId,status:'success',data:{tabs:[]}}));
            }
        });
        await once(ws,'open'); return ws;
    }
    async function register(id,clients=[]) {
        const ws=await connect(); const ack=once(ws,'message');
        ws.send(JSON.stringify({type:'register',deviceId:id,deviceSecret:'audit-device-secret',clients}));
        const frame=JSON.parse((await ack)[0]); assert.equal(frame.type,'register_ack'); return ws;
    }
    async function rpc() {
        const res=await fetch(base+'/mcp',{method:'POST',headers:{...credential,'content-type':'application/json'},
            body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',
                params:{name:'browser_list_tabs',arguments:{deviceId:'audit-suspended'}}}),signal:AbortSignal.timeout(3000)});
        return {status:res.status,body:await res.json()};
    }
    try {
        const started=Date.now();
        while(!logs.includes('listening on port')) {
            if(child.exitCode!==null||Date.now()-started>12000) throw new Error('relay startup failed');
            await delay(20);
        }
        const before=await rpc(); assert.equal(before.status,403);
        const previous=logs.lastIndexOf('[Registry]');
        const opening=register('audit-suspended',[{clientId:'audit-client',secretHash:sha('audit-client-secret')}]);
        const windowStart=Date.now();
        while(logs.lastIndexOf('[Registry]')<=previous) {
            if(Date.now()-windowStart>4000) throw new Error('cache refresh window missed');
            await delay(3);
        }
        // Registry logging is after the delayed read, so trigger another refresh
        // and probe during its clear/read interval instead.
        await opening;
        const second=register('audit-suspended',[{clientId:'audit-client',secretHash:sha('audit-client-secret')}]);
        await delay(65);
        const during=await rpc();
        await second;
        const after=await rpc();
        assert.equal(during.status,EXPECT_FIXED?403:200); assert.equal(after.status,403);
        assert.equal(forwarded.length,EXPECT_FIXED?0:1);
        if (!EXPECT_FIXED) assert.equal(during.body.result.isError,undefined);

        const bulk=Array.from({length:120},(_,i)=>({clientId:'audit-bulk-'+i,secretHash:sha('audit-bulk-secret-'+i)}));
        for(let i=0;i<6;i++) await register('audit-unclaimed-'+i,i===0?bulk:[]);
        if (EXPECT_FIXED) await assert.rejects(register('audit-unclaimed-blocked'),/429/);
        await delay(350);
        const saved=JSON.parse(fs.readFileSync(stateFile,'utf8'));
        assert.equal(Object.values(saved.devices).filter(d=>d.id.startsWith('audit-unclaimed-')).length,6);
        const bulkClientsPersisted=Object.values(saved.clients).filter(c=>c.id.startsWith('audit-bulk-')).length;
        assert.equal(bulkClientsPersisted,EXPECT_FIXED?10:120);
        return {suspensionCache:{before:before.status,during: during.status,after:after.status,
            databaseReadDelayMs:250,method:'browser_list_tabs',forwardedToFakeDevice:forwarded.length,
            note:'Simulated database latency, not a PostgreSQL run or real browser action'},
            registrationLimits:{configuredWebSocketLimit:EXPECT_FIXED?8:2,successfulRegistrations:6,
                nextHandshakeBlocked:EXPECT_FIXED,bulkClientsPersisted,accountsRequired:false,serverCrashed:false}};
    } finally {
        sockets.forEach(ws=>ws.terminate());
        if(child.exitCode===null) {const ended=once(child,'exit');child.kill();await ended;}
        // Delete only explicitly created files in this isolated temp directory.
        for(const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir,name));
        fs.rmdirSync(dir);
    }
}

async function ssrfCheck() {
    const oauth=require(path.join(ROOT,'lib/oauth'));
    const originalLookup=dns.lookup, originalRequest=https.request;
    let checkedAddress, networkRequest=false;
    try {
        dns.lookup=async()=>[{address:'::ffff:127.0.0.1',family:6}];
        https.request=(_url,options)=>{
            networkRequest=true;
            options.lookup('audit.example.invalid',{all:true},(_err,list)=>{checkedAddress=list[0].address});
            const req=new EventEmitter();
            req.setTimeout=()=>req; req.destroy=()=>req;
            req.end=()=>queueMicrotask(()=>req.emit('error',new Error('blocked-by-audit')));
            return req;
        };
        await oauth.resolveClientMetadata('https://audit.example.invalid/client.json');
        assert.equal(networkRequest,!EXPECT_FIXED);
        assert.equal(checkedAddress,EXPECT_FIXED?undefined:'::ffff:127.0.0.1');
    } finally {dns.lookup=originalLookup;https.request=originalRequest;}
    const listener=net.createServer(socket=>socket.end());
    listener.listen(0,'127.0.0.1');await once(listener,'listening');
    const socket=net.connect({host:'::ffff:127.0.0.1',port:listener.address().port,family:6});
    try {await once(socket,'connect'); return {filterAllowedMappedLoopback:!EXPECT_FIXED,
        mappedAddressReachedLocalListener:true,externalRequestMade:false,
        note:'DNS and HTTPS mocked; mapped-address connectivity checked with local TCP only'};
    } finally {socket.destroy();await new Promise(resolve=>listener.close(resolve));}
}

(async()=>{
    const result={date:'2026-09-30',mode:EXPECT_FIXED?'fixed':'baseline',relay:await relayCheck(),ssrf:await ssrfCheck()};
    const file=EXPECT_FIXED?'fixed-reproduction-results.json':'reproduction-results.json';
    fs.writeFileSync(path.join(__dirname,file),JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify(result,null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
