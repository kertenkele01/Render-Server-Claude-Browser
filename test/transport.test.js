'use strict';

/**
 * Transport tests.
 *
 * The relay speaks two: the legacy HTTP+SSE pair (`GET /sse` + `POST /message`)
 * and Streamable HTTP (`POST /mcp`). Streamable HTTP is what current MCP
 * clients try first, and its absence was not a degraded experience — it was
 * "cannot connect to server", reported before the 401 that would have pointed
 * the client at OAuth.
 *
 * Both transports share one dispatcher, so the thing worth testing is that they
 * genuinely agree: the same JSON-RPC call must produce the same answer whether
 * it arrives on a POST or is pushed down an SSE channel.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 41803;
const BASE = `http://127.0.0.1:${PORT}`;

const DEVICE_ID = 'dev_transport';
const DEVICE_SECRET = 'cihaz-sirri-16-karakter';
const CLIENT_ID = 'cli_transport';
const CLIENT_SECRET = 'istemci-sirri-tasima-testi-1';
const TOKEN = `${CLIENT_ID}.${CLIENT_SECRET}`;

let child;
let stateFile;
let device;

function sha256(v) {
    return crypto.createHash('sha256').update(String(v)).digest('hex');
}

/** A fake phone that answers every command with the same payload. */
function connectDevice() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
        ws.on('open', () => {
            ws.send(JSON.stringify({
                type: 'register',
                deviceId: DEVICE_ID,
                deviceSecret: DEVICE_SECRET,
                deviceName: 'Test telefonu',
                clients: [{ clientId: CLIENT_ID, secretHash: sha256(CLIENT_SECRET), name: 'Taşıma testi' }]
            }));
        });
        ws.on('message', (raw) => {
            const payload = JSON.parse(raw.toString());
            if (payload.type === 'register_ack') return resolve({ ws, close: () => ws.close() });
            if (payload.type === 'register_nack') return reject(new Error(payload.reason));
            if (payload.messageId && payload.clientId) {
                ws.send(JSON.stringify({
                    type: 'response',
                    messageId: payload.messageId,
                    status: 'success',
                    data: { url: 'https://example.com/', markdown: 'merhaba dünya' }
                }));
            }
        });
        ws.on('error', reject);
        setTimeout(() => reject(new Error('cihaz kaydı zaman aşımına uğradı')), 6000);
    });
}

/** One JSON-RPC call over Streamable HTTP, the way a current client makes it. */
async function rpc(body, token = TOKEN) {
    const res = await fetch(`${BASE}/mcp`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2025-06-18',
            authorization: `Bearer ${token}`
        },
        body: JSON.stringify(body)
    });
    let payload = null;
    try { payload = await res.json(); } catch (e) { /* 202 has no body */ }
    return { status: res.status, body: payload };
}

/**
 * The same call over the legacy pair: open the channel, POST to the endpoint it
 * announces, read the answer off the stream.
 */
function rpcOverSse(body) {
    return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const timer = setTimeout(() => {
            controller.abort();
            reject(new Error('SSE yanıtı gelmedi'));
        }, 8000);

        fetch(`${BASE}/sse`, {
            headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' },
            signal: controller.signal
        }).then(async (res) => {
            assert.equal(res.status, 200, 'SSE kanalı açılmadı');
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let posted = false;

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                if (!posted) {
                    const match = buffer.match(/event: endpoint\ndata: (\S+)\n/);
                    if (match) {
                        posted = true;
                        const endpoint = new URL(match[1]);
                        // The announced host is the relay's own view of itself;
                        // in a test that is the loopback address we dialled.
                        fetch(`${BASE}${endpoint.pathname}${endpoint.search}`, {
                            method: 'POST',
                            headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
                            body: JSON.stringify(body)
                        }).catch(reject);
                    }
                }

                const answer = buffer.match(/event: message\ndata: (.+)\n/);
                if (answer) {
                    clearTimeout(timer);
                    controller.abort();
                    return resolve(JSON.parse(answer[1]));
                }
            }
            clearTimeout(timer);
            reject(new Error('akış yanıtsız kapandı'));
        }).catch((e) => {
            if (e.name === 'AbortError') return;
            clearTimeout(timer);
            reject(e);
        });
    });
}

// --- lifecycle -------------------------------------------------------------

test.before(async () => {
    stateFile = path.join(os.tmpdir(), `bridge-transport-test-${Date.now()}.json`);
    child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(PORT),
            DATABASE_URL: '',
            BRIDGE_STATE_FILE: stateFile,
            ALLOW_REGISTRATION: 'true'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('sunucu açılmadı')), 15000);
        child.stdout.on('data', (chunk) => {
            if (chunk.includes('listening on port')) {
                clearTimeout(timer);
                resolve();
            }
        });
        child.on('exit', (code) => reject(new Error(`sunucu ${code} ile çıktı`)));
    });

    device = await connectDevice();
});

test.after(() => {
    if (device) device.close();
    if (child) child.kill();
    try { fs.unlinkSync(stateFile); } catch (e) {}
});

// --- Streamable HTTP -------------------------------------------------------

test('kimliksiz POST /mcp OAuth sunucusunu işaret eder', async () => {
    // The failure this whole endpoint exists to fix: a current client POSTs,
    // gets a 404 from a relay that only spoke SSE, and reports "cannot connect"
    // without ever seeing an authentication challenge.
    const res = await fetch(`${BASE}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });
    assert.equal(res.status, 401, 'POST /mcp 404 dönüyor — istemci "bağlanamadı" der');
    assert.match(
        res.headers.get('www-authenticate') || '',
        /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource"/
    );
});

test('el sıkışma Streamable HTTP üzerinde tamamlanır', async () => {
    const init = await rpc({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'test-client', version: '1.0' }
        }
    });
    assert.equal(init.status, 200);
    assert.equal(init.body.jsonrpc, '2.0');
    assert.equal(init.body.id, 1);
    assert.equal(init.body.result.protocolVersion, '2025-06-18', 'sürüm yankılanmalı');
    assert.equal(init.body.result.serverInfo.name, 'mcp-android-bridge');
    assert.ok(init.body.result.capabilities.tools, 'araç yeteneği bildirilmeli');

    // A notification carries no id and must not produce a body.
    const note = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(note.status, 202);
    assert.equal(note.body, null);
});

test('araç listesi ve araç çağrısı POST yanıtında döner', async () => {
    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal(list.status, 200);
    const names = list.body.result.tools.map((t) => t.name);
    assert.ok(names.includes('browser_get_markdown'));
    assert.ok(names.includes('browser_select_option'), 'form araçları listelenmeli');
    assert.ok(names.includes('browser_pick_date'));

    const call = await rpc({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'browser_get_markdown', arguments: {} }
    });
    assert.equal(call.status, 200);
    assert.equal(call.body.id, 3);
    const text = call.body.result.content[0].text;
    assert.match(text, /merhaba dünya/, 'cihazın yanıtı istemciye ulaşmadı');
});

test('bilinmeyen araç JSON-RPC hatası döner', async () => {
    const res = await rpc({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'browser_yok_boyle_bir_sey', arguments: {} }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.error.code, -32601);
});

test('sunucu kaynaklı akış sunulmadığı açıkça söylenir', async () => {
    // Saying 405 is not a limitation to hide: a client that opens a stream here
    // would hold a socket that never carries anything.
    const res = await fetch(`${BASE}/mcp`, {
        headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' }
    });
    assert.equal(res.status, 405);
    assert.match(res.headers.get('allow') || '', /POST/);

    const ended = await fetch(`${BASE}/mcp`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${TOKEN}` }
    });
    assert.equal(ended.status, 200);
});

// --- the two transports must agree ----------------------------------------

test('eski ve yeni taşıma aynı yanıtı verir', async () => {
    const request = { jsonrpc: '2.0', id: 99, method: 'tools/list' };

    const overPost = await rpc(request);
    const overStream = await rpcOverSse(request);

    // One dispatcher serves both. If these ever drift, a client's answer would
    // depend on which transport it happened to negotiate.
    assert.deepEqual(
        overStream.result.tools.map((t) => t.name),
        overPost.body.result.tools.map((t) => t.name)
    );
    assert.equal(overStream.id, 99);
});
