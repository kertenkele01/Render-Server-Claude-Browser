'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const WebSocket = require('ws');
const {openStore} = require('../lib/store');
const management = require('../lib/device-management');
const ROOT = path.join(__dirname, '..');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const ACCOUNT_KEY=Buffer.alloc(32,7);
function accountProof(domain,payload,key=ACCOUNT_KEY) {
    const subkey=crypto.createHmac('sha256',key).update('mcp-device-management-proof-v2').digest();
    return crypto.createHmac('sha256',subkey).update(domain+'|'+payload).digest('base64');
}
function keys() {
    const pair = crypto.generateKeyPairSync('ec', {namedCurve:'prime256v1'});
    return {publicKey:pair.publicKey.export({format:'der', type:'spki'}).toString('base64'),
        sign:payload => crypto.sign('sha256', Buffer.from(payload), pair.privateKey).toString('base64')};
}
function policy(accountId, main, backup, revision, read=true, renew=true, becomeMain=true) {
    const payload = JSON.stringify({version:1, accountId, mainDeviceId:main.id, mainPublicKey:main.keys.publicKey,
        targetDeviceId:backup.id, targetPublicKey:backup.keys.publicKey, revision,
        canReadTokens:read, canRenewTokens:renew, canBecomeMain:becomeMain});
    return {payload, signature:main.keys.sign(payload), accountProof:accountProof('policy',payload)};
}
function independent(a,main,backup,clientId,p,previousHash,previousRevision=0,newSecret=crypto.randomBytes(32).toString('hex')) {
    const hash=sha(newSecret), iv=crypto.randomBytes(12);
    const key=crypto.createHmac('sha256',ACCOUNT_KEY).update('mcp-client-credential-key-v1').digest();
    const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
    cipher.setAAD(Buffer.from(`credential-v1|${a.id.length}:${a.id}|${clientId.length}:${clientId}|${hash}`));
    const ciphertext=Buffer.concat([cipher.update(newSecret),cipher.final(),cipher.getAuthTag()]);
    const payload=JSON.stringify({version:2,accountId:a.id,clientId,originDeviceId:main.id,requesterId:backup.id,publicKey:backup.keys.publicKey,
        previousHash,secretHash:hash,previousRevision,revision:previousRevision+1,cookieKeyRevision:0,
        nonce:'rotate_'+crypto.randomUUID().replaceAll('-',''),authority:'backup',policy:p});
    return {request:{payload,signature:backup.keys.sign(payload),accountProof:accountProof('rotation',payload),
        credentialPackage:{iv:iv.toString('base64'),ciphertext:ciphertext.toString('base64')}},newSecret,hash};
}
function decrypt(pkg,accountId,clientId) {
    const key=crypto.createHmac('sha256',ACCOUNT_KEY).update('mcp-client-credential-key-v1').digest();
    const data=Buffer.from(pkg.ciphertext,'base64'), cipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(pkg.iv,'base64'));
    cipher.setAAD(Buffer.from(`credential-v1|${accountId.length}:${accountId}|${clientId.length}:${clientId}|${pkg.secretHash}`));
    cipher.setAuthTag(data.subarray(-16)); return Buffer.concat([cipher.update(data.subarray(0,-16)),cipher.final()]).toString();
}

test('device policies are signed, scoped, immutable-key bound and atomically selected', async () => {
    for (const databaseUrl of ['', ...(process.env.TEST_DATABASE_URL ? [process.env.TEST_DATABASE_URL] : [])]) {
        const stateFile = path.join(os.tmpdir(), `backup-policy-${crypto.randomUUID()}.json`);
        let store = await openStore({stateFile,databaseUrl});
        try {
            const a = await store.createAccount({email:`${crypto.randomUUID()}@test.invalid`, passwordHash:'test',passwordSalt:'test'});
            const b = await store.createAccount({email:`${crypto.randomUUID()}@test.invalid`, passwordHash:'test',passwordSalt:'test'});
            const main = {id:crypto.randomUUID(), keys:keys()}, backup = {id:crypto.randomUUID(), keys:keys()}, foreign={id:crypto.randomUUID(), keys:keys()};
            for (const d of [main,backup,foreign]) {
                await store.upsertDevice({id:d.id,secretHash:sha(d.id),name:'Test'});
                await store.setDeviceAccount(d.id,d === foreign ? b.id : a.id);
                assert.equal(await store.setDeviceManagementKey(d.id,d.keys.publicKey),true);
            }
            await store.setAccountDefaultDevice(a.id,main.id);
            assert.equal(await store.setDeviceManagementKey(backup.id,keys().publicKey),false);
            const p = policy(a.id,main,backup,1,false,false,false);
            assert.equal(await store.setBackupPolicy(a.id,backup.id,backup.id,p),false);
            assert.equal(await store.setBackupPolicy(a.id,main.id,foreign.id,p),false);
            assert.equal(await store.setBackupPolicy(a.id,main.id,backup.id,{...p,signature:backup.keys.sign(p.payload)}),false);
            assert.equal(await store.setBackupPolicy(a.id,main.id,backup.id,p),true);
            assert.equal(await store.setBackupPolicy(a.id,main.id,backup.id,p),false,'old revision was replayed');
            assert.equal(await store.setAccountDefaultDevice(a.id,backup.id,backup.id),null);
            assert.equal(await store.setAccountDefaultDevice(a.id,backup.id,main.id),null);
            assert.equal(await store.setBackupPolicy(a.id,main.id,backup.id,policy(a.id,main,backup,2)),true);
            assert.ok(await store.setAccountDefaultDevice(a.id,backup.id,backup.id));
            assert.equal(await store.setBackupPolicy(a.id,main.id,backup.id,policy(a.id,main,backup,3)),false,'old main retained policy-writing rights');
            await store.close(); store = await openStore({stateFile,databaseUrl});
            assert.equal((await store.getDevice(backup.id)).managementPublicKey,backup.keys.publicKey);
            assert.equal(management.permissions(await store.getDevice(backup.id)).canRenewTokens,true);
            const clientId=crypto.randomUUID();
            await store.upsertClient({id:clientId,deviceId:main.id,secretHash:sha('old'),name:'Test'});
            await store.upsertClient({id:clientId,deviceId:backup.id,secretHash:sha('old'),name:'Test'});
            const change=independent(a,main,backup,clientId,(await store.getDevice(backup.id)).backupPolicy,sha('old'));
            assert.equal((await store.commitCredentialRotation(a.id,backup.id,change.request)).status,'ok');
            await store.close(); store=await openStore({stateFile,databaseUrl});
            assert.equal((await store.commitCredentialRotation(a.id,backup.id,change.request)).status,'ok','restart lost idempotency');
            assert.equal((await store.getClient(clientId)).credentialRevision,1);
            assert.equal(await store.upsertClient({id:clientId,deviceId:main.id,secretHash:sha('old'),name:'Test'}),null,'origin overwrote an independently rotated hash');
            await store.setDeviceAccount(backup.id,null);
            assert.equal((await store.getDevice(backup.id)).backupPolicy,null,'grant survived account removal');
        } finally { await store.close(); if(fs.existsSync(stateFile)) fs.unlinkSync(stateFile); }
    }
});

let port = 41950;
async function relay(run) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'backup-management-'));
    const stateFile = path.join(dir,'state.json');
    const main={id:'origin-test',keys:keys()}, backup={id:'backup-test',keys:keys()}, foreign={id:'foreign-test',keys:keys()};
    const secret='existing-credential-for-tests', newSecret='renewed-credential-for-tests', clientId='client-backup-test';
    const store=await openStore({stateFile});
    const a=await store.createAccount({email:'owner@test.invalid',passwordHash:'test',passwordSalt:'test'});
    await store.setAccountPlan(a.id,'pro'); // Two active phones are intentional in these permission tests.
    const b=await store.createAccount({email:'foreign@test.invalid',passwordHash:'test',passwordSalt:'test'});
    for(const d of [main,backup,foreign]) {
        d.credential=d.id+'.device-secret-for-test';
        await store.upsertDevice({id:d.id,secretHash:sha('device-secret-for-test'),name:d.id});
        await store.setDeviceAccount(d.id,d === foreign ? b.id : a.id);
        await store.setDeviceManagementKey(d.id,d.keys.publicKey);
    }
    await store.upsertClient({id:clientId,deviceId:main.id,secretHash:sha(secret),name:'AI Test'});
    await store.upsertClient({id:clientId,deviceId:backup.id,secretHash:sha(secret),name:'AI Test'});
    await store.setDeviceSyncEnabled(main.id,a.id,true);
    await store.setAccountDefaultDevice(a.id,main.id);
    await store.markMainReady(a.id,main.id,(await store.getAccountById(a.id)).mainGeneration);
    await store.publishDeviceClients(a.id,main.id);
    await store.writeCredentialPackage({clientId,accountId:a.id,sourceDeviceId:main.id,version:1,
        secretHash:sha(secret),iv:Buffer.alloc(12).toString('base64'),ciphertext:Buffer.alloc(48).toString('base64'),cookieKeyRevision:0,updatedAt:100});
    await store.close();
    const number=++port, base=`http://127.0.0.1:${number}`, sockets=[];
    const child=spawn(process.execPath,['-e',`process.loadEnvFile=undefined; require(${JSON.stringify(path.join(ROOT,'server.js'))})`],
        {cwd:dir,windowsHide:true,env:{...process.env,DATABASE_URL:'',BRIDGE_STATE_FILE:stateFile,PORT:String(number),
            PUBLIC_ORIGIN:'',RENDER_EXTERNAL_URL:'',TRUSTED_PROXIES:'',NODE_OPTIONS:''},stdio:['ignore','pipe','pipe']});
    let errorText=''; child.stderr.on('data',b=>{errorText+=b;});
    try {
        await new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>reject(new Error('startup timeout')),10000);
            child.stdout.on('data',b=>{if(b.toString().includes('listening on port')){clearTimeout(timer);resolve();}});
            child.once('exit',code=>{clearTimeout(timer);reject(new Error(`server exited ${code}: ${errorText}`));});
        });
        async function phone(d, onRotation) {
            const ws=new WebSocket(`ws://127.0.0.1:${number}`); sockets.push(ws); ws.on('error',()=>{});
            await once(ws,'open');
            const ack=once(ws,'message');
            ws.send(JSON.stringify({type:'register',deviceId:d.id,deviceSecret:'device-secret-for-test',managementPublicKey:d.keys.publicKey,
                clients:d === foreign ? [] : [{clientId,secretHash:sha(secret),name:'AI Test'}]}));
            assert.equal(JSON.parse((await ack)[0]).type,'register_ack');
            ws.on('message',raw=>{const m=JSON.parse(raw); if(m.type==='credential_rotation_request')onRotation?.(m,ws);});
            return ws;
        }
        async function api(d,url,body,method='POST') {
            return fetch(base+url,{method,headers:{authorization:'Bearer '+d.credential,'content-type':'application/json'},
                ...(body === undefined ? {} : {body:JSON.stringify(body)}),signal:AbortSignal.timeout(8000)});
        }
        function request(previousHash=sha(secret)) {
            const payload=JSON.stringify({version:1,accountId:a.id,clientId,requesterId:backup.id,previousHash,
                nonce:'rotation_'+crypto.randomUUID().replaceAll('-',''),expiresAt:Date.now()+60000});
            return {payload,signature:backup.keys.sign(payload)};
        }
        await run({a,main,backup,foreign,clientId,secret,newSecret,phone,api,request,stateFile,base});
    } finally {
        sockets.forEach(ws=>ws.terminate());
        if(child.exitCode===null){const exit=once(child,'exit');child.kill();await exit;}
        for(const file of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,file)); fs.rmdirSync(dir);
    }
}

test('backup rotation requires owner policy and a signed device request; repeats never rotate twice', async () => {
    await relay(async ({a,main,backup,foreign,clientId,secret,newSecret,phone,api,request,stateFile})=>{
        let rotations=0;
        await phone(main,(frame,ws)=>{
            rotations++;
            assert.equal(management.validSignature(backup.keys.publicKey,frame.payload,frame.signature),true);
            const r=JSON.parse(frame.payload);
            ws.send(JSON.stringify({type:'client_added',clientId,secretHash:sha(newSecret),name:'AI Test'}));
            const payload=JSON.stringify({nonce:r.nonce,accountId:a.id,clientId,requesterId:backup.id,previousHash:r.previousHash,
                secretHash:sha(newSecret),credentialPackage:{iv:Buffer.alloc(12).toString('base64'),ciphertext:Buffer.alloc(48).toString('base64')}});
            ws.send(JSON.stringify({type:'credential_rotation_response',nonce:r.nonce,payload,signature:main.keys.sign(payload)}));
        });
        await phone(backup); await phone(foreign);
        const route=`/api/v1/clients/${clientId}/rotate`, body=request();
        assert.equal((await api(backup,route,body)).status,403);
        const p=policy(a.id,main,backup,1);
        assert.equal((await api(backup,`/api/v1/devices/${backup.id}/permissions`,p,'PUT')).status,409);
        assert.equal((await api(main,`/api/v1/devices/${backup.id}/permissions`,p,'PUT')).status,200);
        assert.equal((await api(foreign,route,body)).status,403);
        assert.equal((await api(backup,route,{...body,signature:foreign.keys.sign(body.payload)})).status,400);
        const responses=await Promise.all([api(backup,route,body),api(backup,route,body)]);
        assert.deepEqual(responses.map(r=>r.status),[200,200]);
        const results=await Promise.all(responses.map(r=>r.json()));
        assert.deepEqual(results[0],results[1]);
        assert.equal((await api(backup,route,body)).status,200,'completed operation could not be safely retrieved');
        assert.equal((await api(main,`/api/v1/devices/${backup.id}/permissions`,policy(a.id,main,backup,2,true,false),'PUT')).status,200);
        assert.equal((await api(backup,route,body)).status,200,'renewal revocation prevented retrieval of an already completed result');
        assert.equal(rotations,1);
        assert.equal(JSON.stringify(results).includes(newSecret),false);
        await new Promise(resolve=>setTimeout(resolve,400)); // File driver batches durable writes.
        const data=JSON.parse(fs.readFileSync(stateFile));
        assert.equal(Object.values(data.clients)[0].deviceId,main.id,'credential origin was transferred');
        assert.equal(Object.values(data.clients)[0].secretHash,sha(newSecret));
        assert.equal(JSON.stringify(data).includes(newSecret),false);
        assert.equal((await api(backup,route,request())).status,409,'stale hash dispatched a second rotation');
    });
});

test('revoking token retrieval while rotation is pending blocks result disclosure and retries', async () => {
    await relay(async ({a,main,backup,clientId,newSecret,phone,api,request})=>{
        let receive;
        const incoming=new Promise(resolve=>{receive=resolve;});
        await phone(main,(frame,ws)=>receive({frame,ws})); await phone(backup);
        assert.equal((await api(main,`/api/v1/devices/${backup.id}/permissions`,policy(a.id,main,backup,1),'PUT')).status,200);
        const body=request(), pending=api(backup,`/api/v1/clients/${clientId}/rotate`,body);
        const {frame,ws}=await incoming;
        assert.equal((await api(main,`/api/v1/devices/${backup.id}/permissions`,policy(a.id,main,backup,2,false,false),'PUT')).status,200);
        const r=JSON.parse(frame.payload);
        ws.send(JSON.stringify({type:'client_added',clientId,secretHash:sha(newSecret),name:'AI Test'}));
        const payload=JSON.stringify({nonce:r.nonce,accountId:a.id,clientId,requesterId:backup.id,
            previousHash:r.previousHash,secretHash:sha(newSecret),credentialPackage:{iv:'opaque',ciphertext:'encrypted-result'}});
        ws.send(JSON.stringify({type:'credential_rotation_response',nonce:r.nonce,payload,signature:main.keys.sign(payload)}));
        const response=await pending;
        assert.equal(response.status,409);
        assert.equal(JSON.stringify(await response.json()).includes('encrypted-result'),false);
        assert.equal((await api(backup,`/api/v1/clients/${clientId}/rotate`,body)).status,403);
    });
});

test('token read, OAuth and main-selection opt-outs are enforced independently of sync', async () => {
    await relay(async ({a,main,backup,clientId,phone,api,request})=>{
        await phone(main); const backupSocket=await phone(backup);
        const p=policy(a.id,main,backup,1,false,false,false);
        assert.equal((await api(main,`/api/v1/devices/${backup.id}/permissions`,p,'PUT')).status,200);
        assert.equal((await api(backup,`/api/v1/sync/clients/${clientId}/credential`,undefined,'GET')).status,403);
        const sync=await (await api(backup,'/api/v1/sync',undefined,'GET')).json();
        assert.deepEqual(sync.credentialPackages,[]);
        assert.equal(sync.devices.find(d=>d.deviceId===backup.id).canReadTokens,false);
        assert.equal((await api(backup,`/api/v1/clients/${clientId}/rotate`,request())).status,403);
        assert.equal((await api(backup,'/api/v1/account/main-device',{deviceId:backup.id})).status,403);
        const next=new Promise(resolve=>backupSocket.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='oauth_pairing_code')resolve(m);}));
        backupSocket.send(JSON.stringify({type:'oauth_pairing_request',clientId,clientSecret:'existing-credential-for-tests'}));
        assert.equal((await next).status,'rejected');
        assert.equal((await api(main,`/api/v1/devices/${backup.id}/permissions`,policy(a.id,main,backup,2,true,false,true),'PUT')).status,200);
        assert.equal((await api(backup,`/api/v1/sync/clients/${clientId}/credential`,undefined,'GET')).status,200);
        assert.equal((await api(backup,`/api/v1/clients/${clientId}/rotate`,request())).status,403);
        assert.equal((await api(backup,'/api/v1/account/main-device',{deviceId:backup.id})).status,200);
    });
});

test('rotation reports an offline credential origin without changing registry state', async () => {
    await relay(async ({a,main,backup,clientId,api,request,stateFile})=>{
        assert.equal((await api(main,`/api/v1/devices/${backup.id}/permissions`,policy(a.id,main,backup,1),'PUT')).status,200);
        const old=Object.values(JSON.parse(fs.readFileSync(stateFile)).clients)[0].secretHash;
        const response=await api(backup,`/api/v1/clients/${clientId}/rotate`,request());
        assert.equal(response.status,409);
        assert.equal((await response.json()).error,'credential_origin_offline');
        assert.equal(Object.values(JSON.parse(fs.readFileSync(stateFile)).clients)[0].secretHash,old);
    });
});

test('an authorized backup renews without the origin, and continues after the main device is removed', async () => {
    await relay(async ({a,main,backup,clientId,secret,api,stateFile,base})=>{
        const p=policy(a.id,main,backup,1);
        assert.equal((await api(main,`/api/v1/devices/${backup.id}/permissions`,p,'PUT')).status,200);
        const first=independent(a,main,backup,clientId,p,sha(secret));
        const route=`/api/v1/clients/${clientId}/rotate`;
        const response=await api(backup,route,first.request);
        assert.equal(response.status,200);
        const state=(await response.json()).credentialState;
        assert.equal(state.credentialRevision,1);
        assert.equal(state.originDeviceId,main.id);
        assert.equal(state.credentialRotation.accountProof,accountProof('rotation',state.credentialRotation.payload));
        assert.equal((await api(backup,route,first.request)).status,200);
        const mcp=token=>fetch(base+'/mcp',{method:'POST',headers:{authorization:'Bearer '+clientId+'.'+token,'content-type':'application/json'},
            body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}}})});
        assert.equal((await mcp(secret)).status,401,'old Bearer still authenticated after rotation');
        assert.equal((await mcp(first.newSecret)).status,200,'new Bearer was not applied to authentication');
        const get=await api(backup,`/api/v1/sync/clients/${clientId}/credential`,undefined,'GET');
        assert.equal(decrypt((await get.json()).credentialPackage,a.id,clientId),first.newSecret);
        assert.equal((await api(backup,`/api/v1/devices/${main.id}`,undefined,'DELETE')).status,200);
        const second=independent(a,main,backup,clientId,p,first.hash,1);
        assert.equal((await api(backup,route,second.request)).status,200);
        const data=JSON.parse(fs.readFileSync(stateFile));
        assert.equal(data.clients[clientId].credentialRevision,2);
        assert.equal(data.clients[clientId].deviceId,main.id);
        assert.equal(JSON.stringify(data).includes(second.newSecret),false);
        const shared=(await (await api(backup,`/api/v1/sync/clients/${clientId}/credential`,undefined,'GET')).json()).credentialPackage;
        assert.equal(decrypt(shared,a.id,clientId),second.newSecret);
    });
});

test('concurrent independent rotations commit once and a stale origin reconnect cannot restore its old hash', async () => {
    await relay(async ({a,main,backup,clientId,secret,phone,api,stateFile})=>{
        const p=policy(a.id,main,backup,1);
        await api(main,`/api/v1/devices/${backup.id}/permissions`,p,'PUT');
        const first=independent(a,main,backup,clientId,p,sha(secret)), second=independent(a,main,backup,clientId,p,sha(secret));
        const responses=await Promise.all([api(backup,`/api/v1/clients/${clientId}/rotate`,first.request),api(backup,`/api/v1/clients/${clientId}/rotate`,second.request)]);
        assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
        const winner=responses[0].status===200?first:second;
        await phone(main); // Announces the origin's original, now stale hash.
        const current=(await (await api(main,`/api/v1/sync/clients/${clientId}/credential`,undefined,'GET')).json()).credentialState;
        assert.equal(current.secretHash,winner.hash);
        assert.equal(current.credentialRevision,1);
        assert.equal(JSON.parse(fs.readFileSync(stateFile)).clients[clientId].secretHash,winner.hash);
    });
});

test('independent rotation checks the current grant, binding, signature and key revision', async () => {
    await relay(async ({a,main,backup,foreign,clientId,secret,api})=>{
        const p=policy(a.id,main,backup,1);
        await api(main,`/api/v1/devices/${backup.id}/permissions`,p,'PUT');
        const r=independent(a,main,backup,clientId,p,sha(secret));
        const route=`/api/v1/clients/${clientId}/rotate`;
        assert.equal((await api(foreign,route,r.request)).status,403);
        assert.equal((await api(backup,route,{...r.request,signature:foreign.keys.sign(r.request.payload)})).status,400);
        const oldKey=JSON.stringify({...JSON.parse(r.request.payload),cookieKeyRevision:1});
        assert.equal((await api(backup,route,{...r.request,payload:oldKey,signature:backup.keys.sign(oldKey),accountProof:accountProof('rotation',oldKey)})).status,409);
        const revoked=policy(a.id,main,backup,2,true,false);
        await api(main,`/api/v1/devices/${backup.id}/permissions`,revoked,'PUT');
        assert.equal((await api(backup,route,r.request)).status,403);
        const reread=(await (await api(backup,`/api/v1/sync/clients/${clientId}/credential`,undefined,'GET')).json()).credentialPackage;
        assert.equal(reread.secretHash,sha(secret));
    });
});
