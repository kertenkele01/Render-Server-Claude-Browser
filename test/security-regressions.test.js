'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const express = require('express');
const { protectAsyncRoutes, errorResponse } = require('../lib/http-safety');
const { operationCache } = require('../lib/command-safety');
const oauth = require('../lib/oauth');
const ROOT = path.join(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
let port = 41910;

async function withRelay(settings, run) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-security-'));
    const stateFile = path.join(dir, 'state.json');
    const number = ++port;
    const base = `http://127.0.0.1:${number}`;
    const child = spawn(process.execPath, ['-e', `process.loadEnvFile = undefined; require(${JSON.stringify(path.join(ROOT, 'server.js'))})`], {
        cwd: dir, windowsHide: true, env: { ...process.env, DATABASE_URL: '',
            BRIDGE_STATE_FILE: stateFile, PORT: String(number), TRUSTED_PROXIES: '', PUBLIC_ORIGIN: '', RENDER_EXTERNAL_URL:'',
            ALLOWED_ORIGINS: '', ADMIN_EMAILS: 'reserved@example.invalid',
            ALLOW_REGISTRATION: 'true', LIMIT_REGISTER_MAX: '100',
            MAX_WS_PAYLOAD_BYTES: '1048576', COMMAND_TIMEOUT_MS: '1500',
            NODE_OPTIONS: '', ...settings }, stdio: ['ignore', 'pipe', 'pipe']
    });
    const sockets = [];
    const timers = [];
    let errorText = '';
    child.stderr.on('data', b => { errorText += b; });
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('relay startup timeout')), 12000);
            child.stdout.on('data', raw => {
                if (raw.toString().includes('listening on port')) { clearTimeout(timer); resolve(); }
            });
            child.once('exit', code => { clearTimeout(timer); reject(new Error(`relay exited ${code}: ${errorText}`)); });
        });
        async function socket() {
            const ws = new WebSocket(`ws://127.0.0.1:${number}`);
            ws.on('error', () => {});
            sockets.push(ws);
            await once(ws, 'open');
            return ws;
        }
        async function phone(answer = true) {
            const ws = await socket();
            const received = [];
            const ack = once(ws, 'message');
            ws.send(JSON.stringify({type: 'register', deviceId: 'dev-sec', deviceSecret: 'device-security-secret',
                clients: [null, { clientId: 'cli-sec', secretHash: sha('client-security-secret'), name: 'Security' }]}));
            const registered = JSON.parse((await ack)[0]);
            assert.equal(registered.type, 'register_ack');
            ws.on('message', raw => {
                const frame = JSON.parse(raw);
                received.push(frame);
                if (!answer || !frame.messageId || frame.type === 'cancel_command') return;
                timers.push(setTimeout(() => {
                    if (ws.readyState === 1) ws.send(JSON.stringify({type:'response', messageId:frame.messageId,
                        status:'success', data:{action:frame.type, markdown:'safe', url:'https://example.com/'}}));
                }, 150));
            });
            return {ws, received, ack: registered};
        }
        async function post(url, body, headers = {}) {
            return fetch(base + url, {method:'POST', headers:{'content-type':'application/json', ...headers},
                body:JSON.stringify(body), signal:AbortSignal.timeout(6000)});
        }
        async function rpc(args = {}, name = 'browser_click') {
            return (await post('/mcp', {jsonrpc:'2.0', id:1, method:'tools/call', params:{name, arguments:args}},
                {authorization:'Bearer cli-sec.client-security-secret'})).json();
        }
        const alive = async () => {
            assert.equal(child.exitCode, null, errorText);
            assert.equal((await fetch(base + '/healthz')).status, 200);
        };
        await run({base, phone, socket, post, rpc, alive, stateFile});
    } finally {
        timers.forEach(clearTimeout);
        sockets.forEach(ws => ws.terminate());
        if (child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
        for (const file of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, file));
        fs.rmdirSync(dir);
    }
}

test('unauthenticated malformed WebSocket frames and cookies cannot crash the relay', async () => {
    await withRelay({}, async ({socket, phone, rpc, base, alive}) => {
        const ws = await socket();
        for (const frame of ['null', '[]', '"text"', '1', '{', '{}']) ws.send(frame);
        await delay(100);
        await alive();
        assert.equal((await fetch(base + '/login', {headers:{cookie:'bridge_session=%; arbitrary=%ZZ'}})).status, 200);
        await phone();
        assert.equal((await rpc({}, 'browser_list_tabs')).result.isError, undefined);
        await alive();
    });
});

test('MCP and REST reject every reserved control field before forwarding', async () => {
    await withRelay({}, async ({phone, rpc, post, alive}) => {
        const device = await phone();
        for (const key of ['type','messageId','clientId','clientSecret','deviceSecret','role','timeoutMs','maxResponseBytes']) {
            const args = {[key]:'client_revoked'};
            assert.equal((await rpc(args, 'browser_list_tabs')).error.code, -32602, key);
            assert.equal((await post('/tools/browser_get_markdown', args,
                {authorization:'Bearer cli-sec.client-security-secret'})).status, 400, key);
        }
        assert.equal((await rpc([], 'browser_list_tabs')).error.code, -32602);
        await delay(100);
        assert.equal(device.received.length, 0, 'invalid arguments reached the phone');
        const result = await rpc({selector:'12'}, 'browser_click');
        assert.equal(result.result.isError, undefined);
        const frame = device.received[0];
        assert.equal(frame.type, 'click');
        assert.equal(frame.clientId, 'cli-sec');
        assert.equal(frame.clientSecret, 'client-security-secret');
        assert.equal(frame.timeoutMs, 1000);
        assert.equal(frame.maxResponseBytes, 1048576);
        assert.equal(device.ack.maxResponseBytes, 1048576);
        await alive();
    });
});

test('reserved operator address cannot be captured through public signup', async () => {
    await withRelay({}, async ({phone, post, stateFile}) => {
        await phone();
        const response = await post('/api/v1/register', {email:'reserved@example.invalid', password:'test-reserved-password-932'},
            {authorization:'Bearer dev-sec.device-security-secret'});
        assert.equal(response.status, 403);
        assert.equal((await response.json()).error, 'operator_signup_reserved');
        await delay(400);
        const accounts = Object.values(JSON.parse(fs.readFileSync(stateFile)).accounts);
        assert.equal(accounts.some(a => a.isAdmin || a.email === 'reserved@example.invalid'), false);
    });
});

test('caller-supplied forwarded IP cannot reset the direct connection rate limit', async () => {
    await withRelay({LIMIT_REGISTER_MAX:'2'}, async ({post}) => {
        const body = {redirect_uris:['http://127.0.0.1/callback']};
        const statuses = [];
        for (const ip of ['192.0.2.1','192.0.2.1','192.0.2.1','192.0.2.2']) {
            statuses.push((await post('/oauth/register', body, {'x-forwarded-for':ip})).status);
        }
        assert.deepEqual(statuses, [201,201,429,429]);
    });
});

test('trusted proxy chain resolves the rightmost untrusted address', async () => {
    await withRelay({LIMIT_REGISTER_MAX:'2', TRUSTED_PROXIES:'loopback'}, async ({post}) => {
        const body = {redirect_uris:['http://127.0.0.1/callback']};
        const statuses = [];
        for (const forwarded of ['192.0.2.1, 198.51.100.1','192.0.2.2, 198.51.100.1','192.0.2.3, 198.51.100.1','192.0.2.4, 198.51.100.2']) {
            statuses.push((await post('/oauth/register', body, {'x-forwarded-for':forwarded})).status);
        }
        assert.deepEqual(statuses, [201,201,429,201]);
    });
});

test('identified operations deduplicate concurrent calls, reject conflicts and cancel on timeout', async () => {
    await withRelay({}, async ({phone, rpc}) => {
        const device = await phone();
        const args = {selector:'12', operationId:'operation_123'};
        const results = await Promise.all([rpc(args), rpc(args)]);
        assert.deepEqual(results[0], results[1]);
        assert.equal(device.received.filter(m => m.type === 'click').length, 1);
        assert.equal((await rpc({...args, selector:'13'})).result.isError, true);
        assert.equal(device.received.filter(m => m.type === 'click').length, 1);
    });
    await withRelay({}, async ({phone, rpc}) => {
        const device = await phone(false);
        const args = {selector:'12', operationId:'timeout_operation_123'};
        const result = await rpc(args);
        assert.equal(result.result.isError, true);
        assert.match(result.result.content[0].text, /command_outcome_unknown/);
        await delay(100);
        const cancel = device.received.find(m => m.type === 'cancel_command');
        assert.ok(cancel);
        assert.equal(cancel.clientId, 'cli-sec');
        assert.equal(cancel.clientSecret, 'client-security-secret');
        assert.equal((await rpc(args)).result.isError, true);
        assert.equal(device.received.filter(m => m.type === 'click').length, 1, 'uncertain operation was dispatched twice');
    });
});

test('OAuth requires the registered query, refuses fragments/userinfo, allows only loopback port variation', () => {
    assert.equal(oauth.redirectMatches('https://example.com/cb?tenant=a', 'https://example.com/cb?tenant=b'), false);
    assert.equal(oauth.redirectMatches('https://example.com/cb', 'https://example.com/cb#changed'), false);
    assert.equal(oauth.redirectMatches('https://example.com/cb', 'https://user@example.com/cb'), false);
    assert.equal(oauth.redirectMatches('https://example.com/cb?a=1', 'https://example.com/cb?a=1'), true);
    assert.equal(oauth.redirectMatches('http://127.0.0.1:9000/cb?a=1', 'http://127.0.0.1:9001/cb?a=1'), true);
    assert.equal(oauth.redirectMatches('http://127.0.0.1:9000/cb?a=1', 'http://127.0.0.1:9001/cb?a=2'), false);
});

test('every async HTTP handler has an error boundary without leaking secret errors', async () => {
    const app = express();
    protectAsyncRoutes(app);
    app.get('/reject', async () => { throw new Error('secret-password-do-not-log'); });
    app.get('/alive', (_req, res) => res.send('ok'));
    app.use(errorResponse);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const response = await fetch(base + '/reject');
        assert.equal(response.status, 500);
        assert.equal((await response.text()).includes('secret-password'), false);
        assert.equal((await fetch(base + '/alive')).status, 200);
    } finally { await new Promise(resolve => server.close(resolve)); }
});

test('operation cache retains uncertain outcomes and has bounded admission', async () => {
    const cache = operationCache(20, 1);
    let calls = 0;
    const first = cache.run('credential|id', 'fingerprint', () => { calls++; throw new Error('uncertain'); });
    await assert.rejects(first, /uncertain/);
    await assert.rejects(cache.run('credential|id', 'fingerprint', () => { calls++; }), /uncertain/);
    await assert.rejects(cache.run('credential|other', 'fingerprint', () => {}), /operation_cache_full/);
    assert.equal(calls, 1);
    await delay(30);
    assert.equal(await cache.run('credential|other', 'fingerprint', () => 'new'), 'new');
});

test('operator provisioning CLI reads a hidden password and requires explicit promotion', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-operator-'));
    const stateFile = path.join(dir, 'state.json');
    const password = 'operator-test-password-9234';
    const env = {...process.env, DATABASE_URL:'', BRIDGE_STATE_FILE:stateFile,
        ADMIN_EMAILS:'reserved@example.invalid', NODE_OPTIONS:''};
    async function provision(args, input) {
        const child = spawn(process.execPath, [path.join(ROOT, 'scripts/provision-operator.cjs'), ...args],
            {cwd:dir, windowsHide:true, env, stdio:['pipe','pipe','pipe']});
        let output = '';
        let sent = false;
        child.stdout.on('data', raw => { output += raw; });
        child.stderr.on('data', raw => {
            output += raw;
            if (input && !sent && output.includes('parolası:')) { sent = true; child.stdin.end(input + '\n'); }
        });
        child.stdin.on('error', () => {});
        if (!input) child.stdin.end();
        const timer = setTimeout(() => child.kill(), 15000);
        try { return {code:(await once(child, 'exit'))[0], output}; }
        finally { clearTimeout(timer); }
    }
    try {
        const result = await provision(['reserved@example.invalid'], password);
        assert.equal(result.code, 0, result.output);
        assert.equal(result.output.includes(password), false);
        const account = Object.values(JSON.parse(fs.readFileSync(stateFile)).accounts)[0];
        assert.equal(account.isAdmin, true);
        assert.equal(account.email, 'reserved@example.invalid');
        assert.equal(fs.readFileSync(stateFile, 'utf8').includes(password), false);
        assert.equal((await provision(['reserved@example.invalid'], password)).code, 1);
        assert.equal((await provision(['reserved@example.invalid', '--promote-existing'])).code, 0);
        assert.equal((await provision(['unreserved@example.invalid'], password)).code, 1);
    } finally {
        for (const file of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, file));
        fs.rmdirSync(dir);
    }
});

test('configured public origin preserves HTTPS metadata without trusting forwarded headers', () => {
    const previous = process.env.PUBLIC_ORIGIN;
    const previousRender = process.env.RENDER_EXTERNAL_URL;
    try {
        process.env.RENDER_EXTERNAL_URL = 'https://render-service.onrender.com';
        delete process.env.PUBLIC_ORIGIN;
        assert.equal(require('../lib/network').publicOrigin(), 'https://render-service.onrender.com');
        process.env.PUBLIC_ORIGIN = 'https://bridge.example.invalid';
        const req = {secure:false, headers:{host:'evil.invalid', 'x-forwarded-proto':'http'},
            socket:{remoteAddress:'203.0.113.1'}};
        assert.equal(oauth.originOf(req), 'https://bridge.example.invalid');
        assert.equal(require('../lib/auth').isSecureRequest(req), true);
        for (const bad of ['http://public.example.com', 'https://user:secret@bridge.example.com',
            'https://bridge.example.com/path', 'https://bridge.example.com/?q=1']) {
            process.env.PUBLIC_ORIGIN = bad;
            assert.throws(() => require('../lib/network').publicOrigin());
        }
    } finally {
        if (previous === undefined) delete process.env.PUBLIC_ORIGIN;
        else process.env.PUBLIC_ORIGIN = previous;
        if (previousRender === undefined) delete process.env.RENDER_EXTERNAL_URL;
        else process.env.RENDER_EXTERNAL_URL = previousRender;
    }
});
