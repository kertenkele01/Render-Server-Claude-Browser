'use strict';

/**
 * Control-plane tests.
 *
 * These run the real relay against a temporary file store, drive it over HTTP
 * and a real WebSocket, and assert the things that are expensive to be wrong
 * about: that one account cannot see another's devices, that a claim code is
 * single-use, that a revoked client stops working immediately, and that the
 * audit trail never learns a full URL.
 *
 * No test framework: `node:test` ships with the runtime, and a relay whose only
 * job is routing should not need a dependency to prove it routes.
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
const PORT = 41799;
const BASE = `http://127.0.0.1:${PORT}`;

let child;
let stateFile;

// --- helpers ---------------------------------------------------------------

function sha256(v) {
    return crypto.createHash('sha256').update(String(v)).digest('hex');
}

/** A cookie jar just big enough for one browser-shaped client. */
function newJar() {
    const jar = new Map();
    return {
        header() {
            return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
        },
        absorb(res) {
            const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
            raw.forEach((line) => {
                const [pair] = line.split(';');
                const idx = pair.indexOf('=');
                if (idx <= 0) return;
                const key = pair.slice(0, idx).trim();
                const value = pair.slice(idx + 1).trim();
                if (!value) jar.delete(key);
                else jar.set(key, value);
            });
        },
        get(name) { return jar.get(name); }
    };
}

async function visit(jar, url, options = {}) {
    const res = await fetch(BASE + url, {
        redirect: 'manual',
        ...options,
        headers: { cookie: jar.header(), ...(options.headers || {}) }
    });
    jar.absorb(res);
    return res;
}

async function form(jar, url, fields) {
    const body = new URLSearchParams({ ...fields, _csrf: jar.get('bridge_csrf') || '' });
    return visit(jar, url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString()
    });
}

/** Registers, logs in, and hands back a jar holding a live panel session. */
async function signIn(email, password) {
    const jar = newJar();
    await visit(jar, '/register');
    const created = await form(jar, '/auth/register', { email, password });
    assert.equal(created.status, 303, 'kayıt başarısız');
    await visit(jar, '/login');
    const logged = await form(jar, '/auth/login', { email, password });
    assert.equal(logged.status, 303, 'giriş başarısız');
    return jar;
}

/** A fake phone: registers over the WebSocket and answers commands. */
function connectDevice(deviceId, deviceSecret, clients = []) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
        const inbox = [];
        const waiters = [];

        ws.on('open', () => {
            ws.send(JSON.stringify({
                type: 'register',
                deviceId,
                deviceSecret,
                deviceName: 'Test telefonu',
                clients: clients.map((c) => ({
                    clientId: c.clientId,
                    secretHash: sha256(c.secret),
                    name: c.name
                }))
            }));
        });

        ws.on('message', (raw) => {
            const payload = JSON.parse(raw.toString());
            if (payload.type === 'register_ack') {
                resolve({
                    ws,
                    ack: payload,
                    next(type) {
                        const found = inbox.findIndex((m) => m.type === type);
                        if (found >= 0) return Promise.resolve(inbox.splice(found, 1)[0]);
                        return new Promise((res, rej) => {
                            const timer = setTimeout(() => rej(new Error(`'${type}' mesajı gelmedi`)), 4000);
                            waiters.push({ type, res, timer });
                        });
                    },
                    send(message) { ws.send(JSON.stringify(message)); },
                    close() { ws.close(); }
                });
                return;
            }
            if (payload.type === 'register_nack') {
                reject(new Error(payload.reason));
                return;
            }
            // Answer any command so the MCP side sees a complete round trip.
            if (payload.messageId && payload.type && payload.clientId) {
                ws.send(JSON.stringify({
                    type: 'response',
                    messageId: payload.messageId,
                    status: 'success',
                    data: { url: 'https://example.com/gizli/yol?token=sir', markdown: 'merhaba' }
                }));
            }
            const waiting = waiters.findIndex((w) => w.type === payload.type);
            if (waiting >= 0) {
                const w = waiters.splice(waiting, 1)[0];
                clearTimeout(w.timer);
                w.res(payload);
            } else {
                inbox.push(payload);
            }
        });

        ws.on('error', reject);
        setTimeout(() => reject(new Error('cihaz kaydı zaman aşımına uğradı')), 6000);
    });
}

// --- lifecycle -------------------------------------------------------------

test.before(async () => {
    stateFile = path.join(os.tmpdir(), `bridge-test-${Date.now()}.json`);
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
});

test.after(() => {
    if (child) child.kill();
    try { fs.unlinkSync(stateFile); } catch (e) {}
});

// --- tests -----------------------------------------------------------------

test('panel oturum ister', async () => {
    const jar = newJar();
    const res = await visit(jar, '/');
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/login');

    const api = await visit(jar, '/api/status');
    assert.equal(api.status, 401, '/api/status oturumsuz veri döndürdü');
});

test('zayıf parola ve bozuk e-posta reddedilir', async () => {
    const jar = newJar();
    await visit(jar, '/register');

    const short = await form(jar, '/auth/register', { email: 'a@b.com', password: 'kisa' });
    assert.equal(short.status, 400);
    assert.match(await short.text(), /en az 12 karakter/);

    const bad = await form(jar, '/auth/register', { email: 'bozuk', password: 'yeterince-uzun-parola' });
    assert.equal(bad.status, 400);
});

test('CSRF alanı olmadan giriş kabul edilmez', async () => {
    const jar = newJar();
    await visit(jar, '/login');
    const res = await visit(jar, '/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'email=x@y.com&password=bir-parola-daha'
    });
    assert.equal(res.status, 401);
    assert.match(await res.text(), /Form doğrulaması/);
});

test('yanlış parola hesabın varlığını sızdırmaz', async () => {
    await signIn('sizinti@test.com', 'cok-guclu-parola-1');

    const jar = newJar();
    await visit(jar, '/login');
    const known = await form(jar, '/auth/login', { email: 'sizinti@test.com', password: 'yanlis-parola-x' });
    const unknown = await form(jar, '/auth/login', { email: 'yok@test.com', password: 'yanlis-parola-x' });

    assert.equal(known.status, unknown.status);
    const a = await known.text();
    const b = await unknown.text();
    assert.match(a, /E-posta veya parola hatalı/);
    assert.match(b, /E-posta veya parola hatalı/);
});

test('claim kodu cihazı hesaba bağlar ve tek kullanımlıktır', async () => {
    const jar = await signIn('sahip@test.com', 'cok-guclu-parola-2');
    const device = await connectDevice('test_dev_claim', 'cihaz-sirri-16-karakter');

    assert.equal(device.ack.claimed, false, 'yeni cihaz bağlı görünmemeli');

    device.send({ type: 'request_claim_code' });
    const claim = await device.next('claim_code');
    assert.equal(claim.status, 'ok');
    assert.ok(claim.code && claim.code.length === 8);

    const ok = await form(jar, '/devices/claim', { code: claim.code });
    assert.equal(ok.status, 303);
    assert.match(ok.headers.get('location'), /ok=/);

    // Same code again: consumed.
    const again = await form(jar, '/devices/claim', { code: claim.code });
    assert.match(again.headers.get('location'), /err=/);

    const status = await visit(jar, '/api/status');
    const body = await status.json();
    assert.equal(body.devices.length, 1);
    assert.equal(body.devices[0].id, 'test_dev_claim');
    assert.equal(body.devices[0].online, true);

    device.close();
});

test('bir hesap diğerinin cihazını hiçbir uçta göremez', async () => {
    const mine = await signIn('bir@test.com', 'cok-guclu-parola-3');
    const theirs = await signIn('iki@test.com', 'cok-guclu-parola-4');

    const device = await connectDevice('test_dev_izole', 'cihaz-sirri-16-karakter');
    device.send({ type: 'request_claim_code' });
    const claim = await device.next('claim_code');
    await form(mine, '/devices/claim', { code: claim.code });

    const minePayload = await (await visit(mine, '/api/status')).json();
    const theirsPayload = await (await visit(theirs, '/api/status')).json();

    assert.ok(minePayload.devices.some((d) => d.id === 'test_dev_izole'));
    assert.equal(theirsPayload.devices.length, 0, 'başka hesabın cihazı göründü');
    assert.equal(theirsPayload.clients.length, 0);

    const theirsPanel = await (await visit(theirs, '/')).text();
    assert.ok(!theirsPanel.includes('test_dev_izole'), 'panel başka hesabın cihazını gösterdi');

    device.close();
});

test('yanlış cihaz sırrı ile kayıt reddedilir', async () => {
    await connectDevice('test_dev_sir', 'dogru-sir-16-karakterlik').then((d) => d.close());
    await assert.rejects(
        () => connectDevice('test_dev_sir', 'yanlis-sir-16-karakter'),
        /eşleşmiyor/
    );
});

test('istemci anahtarı çalışır, iptalden sonra çalışmaz', async () => {
    const jar = await signIn('istemci@test.com', 'cok-guclu-parola-5');
    const secret = 'istemci-sirri-uzun-yeterince';
    const device = await connectDevice('test_dev_mcp', 'cihaz-sirri-16-karakter', [
        { clientId: 'cli_test_1', secret, name: 'Test istemcisi' }
    ]);
    device.send({ type: 'request_claim_code' });
    const claim = await device.next('claim_code');
    await form(jar, '/devices/claim', { code: claim.code });

    const credential = `cli_test_1.${secret}`;
    const call = () => fetch(`${BASE}/tools/browser_get_markdown`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
        body: JSON.stringify({})
    });

    const before = await call();
    assert.equal(before.status, 200, 'geçerli anahtar reddedildi');

    const revoked = await form(jar, '/clients/revoke', { clientId: 'cli_test_1' });
    assert.equal(revoked.status, 303);

    const after = await call();
    assert.equal(after.status, 401, 'iptal edilen anahtar hâlâ çalışıyor');

    device.close();
});

test('kimlik bilgisi sorgu dizesinden kabul edilmez', async () => {
    const res = await fetch(`${BASE}/tools/browser_get_markdown?token=cli_test_1.istemci-sirri-uzun-yeterince`);
    assert.equal(res.status, 401, 'sorgu dizesindeki anahtar kabul edildi');
});

test('başarısız kimlik denemeleri sınırlanır', async () => {
    let sawLimit = false;
    for (let i = 0; i < 40; i++) {
        const res = await fetch(`${BASE}/tools/browser_get_markdown`, {
            headers: { authorization: 'Bearer cli_yok.yanlis-sir' }
        });
        if (res.status === 429) { sawLimit = true; break; }
    }
    assert.ok(sawLimit, 'anahtar taramasına sınır uygulanmadı');
});

test('denetim kaydı tam adres veya içerik tutmaz', async () => {
    const jar = await signIn('denetim@test.com', 'cok-guclu-parola-6');
    const secret = 'denetim-sirri-uzun-yeterince';
    const device = await connectDevice('test_dev_log', 'cihaz-sirri-16-karakter', [
        { clientId: 'cli_log_1', secret, name: 'Kayıt istemcisi' }
    ]);
    device.send({ type: 'request_claim_code' });
    const claim = await device.next('claim_code');
    await form(jar, '/devices/claim', { code: claim.code });

    await fetch(`${BASE}/tools/browser_get_markdown`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer cli_log_1.${secret}` },
        body: JSON.stringify({})
    });

    const csv = await (await visit(jar, '/audit/export')).text();
    assert.ok(csv.includes('cli_log_1'), 'kayıt hiç yazılmamış');
    assert.ok(!csv.includes('/gizli/yol'), 'tam adres kayda düştü');
    assert.ok(!csv.includes('token=sir'), 'sorgu dizesi kayda düştü');
    assert.ok(!csv.includes(secret), 'istemci sırrı kayda düştü');
    assert.ok(!csv.includes('merhaba'), 'sayfa içeriği kayda düştü');

    device.close();
});

test('parola değişimi diğer oturumları kapatır', async () => {
    const first = await signIn('oturum@test.com', 'cok-guclu-parola-7');
    const second = newJar();
    await visit(second, '/login');
    await form(second, '/auth/login', { email: 'oturum@test.com', password: 'cok-guclu-parola-7' });

    assert.equal((await visit(second, '/api/status')).status, 200);

    const changed = await form(first, '/account/password', {
        current: 'cok-guclu-parola-7',
        next: 'bambaska-bir-parola-8'
    });
    assert.match(changed.headers.get('location'), /ok=/);

    assert.equal((await visit(second, '/api/status')).status, 401, 'eski oturum hâlâ geçerli');
    assert.equal((await visit(first, '/api/status')).status, 200, 'parolayı değiştiren oturum düştü');
});
