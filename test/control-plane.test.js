'use strict';

/**
 * Control-plane tests.
 *
 * These run the real relay against a temporary file store, drive it over HTTP
 * and a real WebSocket, and assert the things that are expensive to be wrong
 * about: that signing up from the app binds the phone and nothing else, that
 * one account cannot see another's anything, that a suspended account stops
 * working immediately, and that the audit trail never learns a full URL.
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
const OPERATOR_EMAIL = 'operator@test.com';

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

/** Registers on the web and signs in. Only the operator needs this path. */
async function webSignIn(email, password) {
    const jar = newJar();
    await visit(jar, '/register');
    const created = await form(jar, '/auth/register', { email, password });
    // Helpers may reuse the same operator later in this file. A duplicate
    // registration is deliberately a generic 400; the following real login is
    // what proves the supplied account is usable.
    assert.ok([303, 400].includes(created.status), 'web kaydı başarısız');
    await visit(jar, '/login');
    const logged = await form(jar, '/auth/login', { email, password });
    assert.equal(logged.status, 303, 'web girişi başarısız');
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
                    /** The credential the app uses against /api/v1. */
                    credential: `${deviceId}.${deviceSecret}`,
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

/** Calls the app API the way the Android client does. */
async function appApi(device, method, url, body) {
    const res = await fetch(BASE + url, {
        method,
        headers: {
            authorization: `Bearer ${device.credential}`,
            ...(body ? { 'content-type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
    });
    let payload = null;
    try { payload = await res.json(); } catch (e) { /* empty body */ }
    return { status: res.status, body: payload };
}

/** Signs a phone up from the app — the normal user's entire onboarding. */
async function appSignUp(device, email, password) {
    const res = await appApi(device, 'POST', '/api/v1/register', { email, password });
    assert.equal(res.status, 201, `uygulamadan kayıt başarısız: ${JSON.stringify(res.body)}`);
    return res.body;
}

/** Runs one MCP command through the REST fallback. */
function callTool(credential, args = {}) {
    return fetch(`${BASE}/tools/browser_get_markdown`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
        body: JSON.stringify(args)
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
            ALLOW_REGISTRATION: 'true',
            ADMIN_EMAILS: OPERATOR_EMAIL
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

// --- the app is the whole user experience ----------------------------------

test('uygulamadan kayıt cihazı kendiliğinden bağlar', async () => {
    const device = await connectDevice('dev_kayit', 'cihaz-sirri-16-karakter');
    assert.equal(device.ack.claimed, false);

    const before = await appApi(device, 'GET', '/api/v1/account');
    assert.equal(before.status, 200);
    assert.equal(before.body.linked, false, 'kayıt öncesi bağlı görünüyor');

    const account = await appSignUp(device, 'kayit@test.com', 'cok-guclu-parola-1');
    assert.equal(account.linked, true, 'kayıt cihazı bağlamadı');
    assert.equal(account.email, 'kayit@test.com');
    assert.equal(account.counts.devices, 1);
    assert.ok(account.quota.commandsPerDay > 0);
    assert.ok(!('passwordHash' in account), 'hesap özetinde parola özeti var');

    device.close();
});

test('uygulamadan giriş ikinci cihazı plan sınırına takar', async () => {
    const first = await connectDevice('dev_giris_1', 'cihaz-sirri-16-karakter');
    await appSignUp(first, 'giris@test.com', 'cok-guclu-parola-2');

    const second = await connectDevice('dev_giris_2', 'cihaz-sirri-16-karakter');
    const denied = await appApi(second, 'POST', '/api/v1/login', {
        email: 'giris@test.com', password: 'cok-guclu-parola-2'
    });
    assert.equal(denied.status, 409, 'ücretsiz plan ikinci cihazı kabul etti');
    assert.equal(denied.body.error, 'device_limit');

    // Freeing the first slot lets the second phone in.
    await appApi(first, 'POST', '/api/v1/logout');
    const ok = await appApi(second, 'POST', '/api/v1/login', {
        email: 'giris@test.com', password: 'cok-guclu-parola-2'
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.linked, true);

    first.close();
    second.close();
});

test('bir cihaz başka bir hesaba giriş yapamaz', async () => {
    const device = await connectDevice('dev_carpisma', 'cihaz-sirri-16-karakter');
    await appSignUp(device, 'sahip1@test.com', 'cok-guclu-parola-3');

    const other = await connectDevice('dev_carpisma_2', 'cihaz-sirri-16-karakter');
    await appSignUp(other, 'sahip2@test.com', 'cok-guclu-parola-4');
    other.close();

    const res = await appApi(device, 'POST', '/api/v1/login', {
        email: 'sahip2@test.com', password: 'cok-guclu-parola-4'
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'device_linked_elsewhere');

    device.close();
});

test('yanlış parola hesabın varlığını sızdırmaz', async () => {
    const device = await connectDevice('dev_sizinti', 'cihaz-sirri-16-karakter');
    await appSignUp(device, 'sizinti@test.com', 'cok-guclu-parola-5');
    await appApi(device, 'POST', '/api/v1/logout');

    const known = await appApi(device, 'POST', '/api/v1/login', {
        email: 'sizinti@test.com', password: 'yanlis-parola-x'
    });
    const unknown = await appApi(device, 'POST', '/api/v1/login', {
        email: 'yok@test.com', password: 'yanlis-parola-x'
    });

    assert.equal(known.status, unknown.status);
    assert.equal(known.body.message, unknown.body.message);

    device.close();
});

test('zayıf parola ve bozuk e-posta reddedilir', async () => {
    const device = await connectDevice('dev_zayif', 'cihaz-sirri-16-karakter');

    const short = await appApi(device, 'POST', '/api/v1/register', { email: 'a@b.com', password: 'kisa' });
    assert.equal(short.status, 400);
    assert.match(short.body.message, /en az 12 karakter/);

    const bad = await appApi(device, 'POST', '/api/v1/register', { email: 'bozuk', password: 'yeterince-uzun-parola' });
    assert.equal(bad.status, 400);

    device.close();
});

test('uygulama API cihaz kimliği ister', async () => {
    const res = await fetch(`${BASE}/api/v1/account`, {
        headers: { authorization: 'Bearer sahte_cihaz.sahte-sir' }
    });
    assert.ok(res.status === 401 || res.status === 429, `beklenmeyen durum: ${res.status}`);

    const none = await fetch(`${BASE}/api/v1/account`);
    assert.ok(none.status === 401 || none.status === 429);
});

test('parola uygulamadan değiştirilebilir', async () => {
    const device = await connectDevice('dev_parola', 'cihaz-sirri-16-karakter');
    await appSignUp(device, 'parola@test.com', 'cok-guclu-parola-6');

    const operator = await webSignIn(OPERATOR_EMAIL, 'operator-parolasi-uzun');
    const status = await (await visit(operator, '/api/status')).json();
    const passwordAccount = status.accounts.find((a) => a.email === 'parola@test.com');
    assert.ok(passwordAccount);
    assert.equal((await form(operator, '/admin/accounts/plan', {
        accountId: passwordAccount.id, plan: 'pro'
    })).status, 303);

    const otherDevice = await connectDevice('dev_parola_2', 'cihaz-sirri-parola-iki');
    assert.equal((await appApi(otherDevice, 'POST', '/api/v1/login', {
        email: 'parola@test.com', password: 'cok-guclu-parola-6'
    })).status, 200);

    const wrong = await appApi(device, 'POST', '/api/v1/account/password', {
        current: 'yanlis-parola', next: 'yeni-parola-yeterince-uzun'
    });
    assert.equal(wrong.status, 401);

    const ok = await appApi(device, 'POST', '/api/v1/account/password', {
        current: 'cok-guclu-parola-6', next: 'yeni-parola-yeterince-uzun', logoutOtherDevices: true
    });
    assert.equal(ok.status, 200);

    const otherAfterChange = await appApi(otherDevice, 'GET', '/api/v1/account');
    assert.equal(otherAfterChange.status, 200);
    assert.equal(otherAfterChange.body.linked, false, 'parola değişiminden sonra diğer cihaz bağlı kaldı');

    await appApi(device, 'POST', '/api/v1/logout');
    const relog = await appApi(device, 'POST', '/api/v1/login', {
        email: 'parola@test.com', password: 'yeni-parola-yeterince-uzun'
    });
    assert.equal(relog.status, 200);

    device.close();
    otherDevice.close();
});

// --- isolation -------------------------------------------------------------

test('bir hesap diğerinin verisini hiçbir uçtan göremez', async () => {
    const mine = await connectDevice('dev_izole_1', 'cihaz-sirri-16-karakter');
    await appSignUp(mine, 'izole1@test.com', 'cok-guclu-parola-7');

    const theirs = await connectDevice('dev_izole_2', 'cihaz-sirri-16-karakter');
    await appSignUp(theirs, 'izole2@test.com', 'cok-guclu-parola-8');

    const mineView = await appApi(mine, 'GET', '/api/v1/account');
    const theirsView = await appApi(theirs, 'GET', '/api/v1/account');

    assert.equal(mineView.body.email, 'izole1@test.com');
    assert.equal(theirsView.body.email, 'izole2@test.com');
    assert.equal(mineView.body.deviceId, 'dev_izole_1');
    assert.equal(theirsView.body.deviceId, 'dev_izole_2');

    const mineAudit = await appApi(mine, 'GET', '/api/v1/audit');
    assert.ok(mineAudit.body.events.every((e) => e.deviceId !== 'dev_izole_2'),
        'başka hesabın olayı denetim kaydında göründü');

    const mineSync = await appApi(mine, 'GET', '/api/v1/sync');
    assert.deepEqual(mineSync.body.devices.map((d) => d.deviceId), ['dev_izole_1']);
    assert.ok(mineSync.body.clients.every((c) => !c.deviceIds.includes('dev_izole_2')),
        'başka hesabın istemci bağı senkronizasyon görünümünde göründü');

    mine.close();
    theirs.close();
});

test('yanlış cihaz sırrı ile kayıt reddedilir', async () => {
    await connectDevice('dev_sir', 'dogru-sir-16-karakterlik').then((d) => d.close());
    await assert.rejects(
        () => connectDevice('dev_sir', 'yanlis-sir-16-karakter'),
        /eşleşmiyor/
    );
});

// --- MCP path --------------------------------------------------------------

test('istemci anahtarı çalışır, telefondan iptal edilince durur', async () => {
    const secret = 'istemci-sirri-uzun-yeterince';
    const device = await connectDevice('dev_mcp', 'cihaz-sirri-16-karakter', [
        { clientId: 'cli_mcp_1', secret, name: 'Test istemcisi' }
    ]);
    await appSignUp(device, 'mcp@test.com', 'cok-guclu-parola-9');

    const before = await callTool(`cli_mcp_1.${secret}`);
    assert.equal(before.status, 200, 'geçerli anahtar reddedildi');

    // Revocation is a phone-side action: the owner removes the client there.
    device.send({ type: 'revoke_client', clientId: 'cli_mcp_1' });
    await new Promise((r) => setTimeout(r, 300));

    const after = await callTool(`cli_mcp_1.${secret}`);
    assert.equal(after.status, 401, 'iptal edilen anahtar hâlâ çalışıyor');

    device.close();
});

test('aynı AI anahtarı aynı hesaptaki iki yetkili cihaza açıkça yönlendirilebilir', async () => {
    const secret = 'ortak-istemci-sirri-uzun-yeterince';
    const clientId = 'cli_coklu_cihaz';
    const email = 'coklu-cihaz@test.com';
    const password = 'coklu-cihaz-parolasi-uzun';

    const first = await connectDevice('dev_coklu_1', 'cihaz-sirri-coklu-bir', [
        { clientId, secret, name: 'Ortak ChatGPT' }
    ]);
    await appSignUp(first, email, password);

    const enabledCookies = await appApi(first, 'POST', `/api/v1/sync/clients/${clientId}/cookies/enable`);
    assert.equal(enabledCookies.status, 200, JSON.stringify(enabledCookies.body));

    const encryptedCookiePackage = Buffer.from('yalnizca-cihazda-cozulebilen-paket').toString('base64');
    const uploadedCookies = await appApi(first, 'PUT', `/api/v1/sync/clients/${clientId}/cookies`, {
        version: 1,
        iv: Buffer.from('on-iki-byte-iv').toString('base64'),
        ciphertext: encryptedCookiePackage
    });
    assert.equal(uploadedCookies.status, 200, JSON.stringify(uploadedCookies.body));

    // The free plan deliberately has one device. Promote this account through
    // the real operator path so the test also proves account boundaries remain
    // in force while a second phone is attached.
    const operator = await webSignIn(OPERATOR_EMAIL, 'operator-parolasi-uzun');
    const status = await (await visit(operator, '/api/status')).json();
    const account = status.accounts.find((a) => a.email === email);
    assert.ok(account, 'çoklu cihaz hesabı operatör görünümünde yok');
    const promoted = await form(operator, '/admin/accounts/plan', {
        accountId: account.id, plan: 'pro'
    });
    assert.equal(promoted.status, 303);

    const second = await connectDevice('dev_coklu_2', 'cihaz-sirri-coklu-iki');
    const login = await appApi(second, 'POST', '/api/v1/login', { email, password });
    assert.equal(login.status, 200, `ikinci cihaz hesaba bağlanamadı: ${JSON.stringify(login.body)}`);

    const syncBeforeRestore = await appApi(second, 'GET', '/api/v1/sync');
    assert.equal(syncBeforeRestore.status, 200);
    assert.deepEqual(
        new Set(syncBeforeRestore.body.devices.map((d) => d.deviceId)),
        new Set(['dev_coklu_1', 'dev_coklu_2'])
    );
    const restorable = syncBeforeRestore.body.clients.find((c) => c.clientId === clientId);
    assert.ok(restorable, 'hesaptaki AI bağlantısı yeni telefona sunulmadı');
    assert.equal(restorable.secretHash, sha256(secret));
    assert.equal(restorable.secret, undefined, 'düz metin token senkronizasyon API’sine sızdı');
    assert.deepEqual(restorable.deviceIds, ['dev_coklu_1']);
    assert.equal(restorable.cookieSnapshot.version, 1);
    assert.equal(restorable.cookieSnapshot.ciphertext, encryptedCookiePackage);
    assert.equal(JSON.stringify(restorable).includes('yalnizca-cihazda'), false,
        'çerez paketinin düz metni senkronizasyon görünümüne sızdı');

    const secondaryUpload = await appApi(second, 'PUT', `/api/v1/sync/clients/${clientId}/cookies`, {
        version: 1,
        iv: Buffer.from('on-iki-byte-iv').toString('base64'),
        ciphertext: Buffer.from('ikincil-cihaz-paketi-yazamamali').toString('base64')
    });
    assert.equal(secondaryUpload.status, 403, 'ikincil cihaz kaynak çerez paketini değiştirebildi');

    // A restored phone announces the same hash. The plaintext token is still
    // never stored by the relay, and each phone verifies it independently.
    second.send({
        type: 'client_added',
        clientId,
        secretHash: sha256(secret),
        name: 'Ortak ChatGPT'
    });
    await new Promise((r) => setTimeout(r, 250));

    const token = `${clientId}.${secret}`;
    const listedResponse = await fetch(`${BASE}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
            jsonrpc: '2.0', id: 77, method: 'tools/call',
            params: { name: 'browser_list_devices', arguments: {} }
        })
    });
    assert.equal(listedResponse.status, 200);
    const listedRpc = await listedResponse.json();
    const listed = JSON.parse(listedRpc.result.content[0].text);
    assert.deepEqual(
        new Set(listed.devices.map((d) => d.deviceId)),
        new Set(['dev_coklu_1', 'dev_coklu_2'])
    );
    assert.equal(listed.devices.find((d) => d.deviceId === 'dev_coklu_1').isDefault, true);
    assert.ok(listed.devices.every((d) => d.online), 'bağlı telefon çevrimdışı listelendi');

    const defaultCall = await callTool(token);
    assert.equal(defaultCall.status, 200);
    assert.equal((await defaultCall.json()).data.deviceId, 'dev_coklu_1', 'mevcut varsayılan cihaz değişti');

    const selectedCall = await callTool(token, { deviceId: 'dev_coklu_2' });
    assert.equal(selectedCall.status, 200);
    assert.equal((await selectedCall.json()).data.deviceId, 'dev_coklu_2', 'açık cihaz seçimi uygulanmadı');

    const refused = await callTool(token, { deviceId: 'dev_hesap_disinda' });
    assert.equal(refused.status, 502);
    assert.match((await refused.json()).error, /yetkili değil/i);

    const deletedCloudCookies = await appApi(second, 'DELETE', `/api/v1/sync/clients/${clientId}/cookies`);
    assert.equal(deletedCloudCookies.status, 200);
    const uploadWhileDisabled = await appApi(first, 'PUT', `/api/v1/sync/clients/${clientId}/cookies`, {
        version: 1,
        iv: Buffer.from('on-iki-byte-iv').toString('base64'),
        ciphertext: encryptedCookiePackage
    });
    assert.equal(uploadWhileDisabled.status, 409, 'silinen bulut kopyası kaynak telefon tarafından kendiliğinden geri oluşturuldu');
    assert.equal((await appApi(first, 'POST', `/api/v1/sync/clients/${clientId}/cookies/enable`)).status, 200);

    const removedSecondary = await appApi(first, 'DELETE', '/api/v1/devices/dev_coklu_2');
    assert.equal(removedSecondary.status, 200, JSON.stringify(removedSecondary.body));
    const afterDeviceRemoval = await appApi(first, 'GET', '/api/v1/sync');
    assert.deepEqual(afterDeviceRemoval.body.devices.map((d) => d.deviceId), ['dev_coklu_1']);
    const reconnectRemoved = await connectDevice('dev_coklu_2', 'cihaz-sirri-coklu-iki', [
        { clientId, secret, name: 'Ortak ChatGPT' }
    ]);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await callTool(token, { deviceId: 'dev_coklu_2' })).status, 502,
        'hesaptan çıkarılan telefon yeniden bağlanabildi');

    first.send({ type: 'revoke_client', clientId });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await callTool(token)).status, 401, 'çoklu cihaz anahtarı iptalden sonra çalışıyor');

    first.close();
    second.close();
    reconnectRemoved.close();
});

test('askıya alınan hesabın anahtarları anında durur', async () => {
    const operator = await webSignIn(OPERATOR_EMAIL, 'operator-parolasi-uzun');

    const secret = 'askiya-sirri-uzun-yeterince';
    const device = await connectDevice('dev_askiya', 'cihaz-sirri-16-karakter', [
        { clientId: 'cli_askiya', secret, name: 'Askı istemcisi' }
    ]);
    await appSignUp(device, 'askiya@test.com', 'cok-guclu-parola-10');

    assert.equal((await callTool(`cli_askiya.${secret}`)).status, 200);

    const status = await (await visit(operator, '/api/status')).json();
    const target = status.accounts.find((a) => a.email === 'askiya@test.com');
    assert.ok(target, 'operatör listesinde hesap yok');

    const suspended = await form(operator, '/admin/accounts/status', {
        accountId: target.id, status: 'suspended'
    });
    assert.equal(suspended.status, 303);

    const after = await callTool(`cli_askiya.${secret}`);
    assert.equal(after.status, 403, 'askıya alınan hesabın anahtarı çalışmaya devam etti');

    device.close();
});

test('kısayol aracı röleden yönlendirilir', async () => {
    const secret = 'kisayol-sirri-uzun-yeterince';
    const device = await connectDevice('dev_kisayol', 'cihaz-sirri-16-karakter', [
        { clientId: 'cli_kisayol', secret, name: 'Kısayol istemcisi' }
    ]);
    await appSignUp(device, 'kisayol@test.com', 'cok-guclu-parola-12');

    const res = await fetch(`${BASE}/tools/browser_list_shortcuts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer cli_kisayol.${secret}` },
        body: JSON.stringify({})
    });
    assert.equal(res.status, 200, 'kısayol aracı yönlendirilmedi');

    device.close();
});

test('kimlik bilgisi sorgu dizesinden kabul edilmez', async () => {
    const res = await fetch(`${BASE}/tools/browser_get_markdown?token=cli_mcp_1.istemci-sirri-uzun-yeterince`);
    assert.equal(res.status, 401, 'sorgu dizesindeki anahtar kabul edildi');
});

test('başarısız kimlik denemeleri sınırlanır', async () => {
    let sawLimit = false;
    for (let i = 0; i < 40; i++) {
        const res = await callTool(`cli_yok_${i}.yanlis-sir`);
        if (res.status === 429) { sawLimit = true; break; }
    }
    assert.ok(sawLimit, 'anahtar taramasına sınır uygulanmadı');
});

test('denetim kaydı tam adres veya içerik tutmaz', async () => {
    const secret = 'denetim-sirri-uzun-yeterince';
    const device = await connectDevice('dev_log', 'cihaz-sirri-16-karakter', [
        { clientId: 'cli_log_1', secret, name: 'Kayıt istemcisi' }
    ]);
    await appSignUp(device, 'denetim@test.com', 'cok-guclu-parola-11');

    await callTool(`cli_log_1.${secret}`);
    await new Promise((r) => setTimeout(r, 300));

    const audit = await appApi(device, 'GET', '/api/v1/audit');
    const dump = JSON.stringify(audit.body);
    assert.ok(dump.includes('cli_log_1'), 'kayıt hiç yazılmamış');
    assert.ok(!dump.includes('/gizli/yol'), 'tam adres kayda düştü');
    assert.ok(!dump.includes('token=sir'), 'sorgu dizesi kayda düştü');
    assert.ok(!dump.includes(secret), 'istemci sırrı kayda düştü');
    assert.ok(!dump.includes('merhaba'), 'sayfa içeriği kayda düştü');

    device.close();
});

// --- the panel is operators only -------------------------------------------

test('panel oturum ister', async () => {
    const jar = newJar();
    const res = await visit(jar, '/');
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/login');
    assert.equal((await visit(jar, '/api/status')).status, 401);
});

test('operatör olmayan hesap panelde yönetim göremez', async () => {
    const jar = await webSignIn('sadecekullanici@test.com', 'kullanici-parolasi-uzun');

    const page = await visit(jar, '/');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Her şey uygulamada/);
    assert.ok(!html.includes('Röle geneli'), 'operatör olmayan hesaba toplamlar gösterildi');

    const api = await visit(jar, '/api/status');
    assert.equal(api.status, 403);
    assert.equal((await api.json()).error, 'not_operator');
});

test('operatör toplamları ve hesap listesini görür', async () => {
    const jar = await webSignIn(OPERATOR_EMAIL + '.x', 'olmayan-operator-parolasi');
    // The above is a normal account; the real operator signs in separately.
    const operator = newJar();
    await visit(operator, '/login');
    const logged = await form(operator, '/auth/login', {
        email: OPERATOR_EMAIL, password: 'operator-parolasi-uzun'
    });
    assert.equal(logged.status, 303);

    const html = await (await visit(operator, '/')).text();
    assert.match(html, /Röle geneli/);
    assert.match(html, /Hesaplar/);

    const status = await (await visit(operator, '/api/status')).json();
    assert.ok(status.totals.accounts >= 2);
    assert.ok(Array.isArray(status.accounts));
    assert.ok(status.accounts.every((a) => !('passwordHash' in a)), 'hesap listesi parola özeti sızdırdı');
    assert.ok(!JSON.stringify(status).includes('gizli/yol'), 'operatör görünümüne denetim ayrıntısı sızdı');

    assert.equal(jar instanceof Object, true);
});

test('CSRF alanı olmadan panel girişi kabul edilmez', async () => {
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
