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
async function appApi(device, method, url, body, extraHeaders = {}) {
    const res = await fetch(BASE + url, {
        method,
        headers: {
            authorization: `Bearer ${device.credential}`,
            ...(body ? { 'content-type': 'application/json' } : {}),
            ...extraHeaders
        },
        body: body ? JSON.stringify(body) : undefined
    });
    let payload = null;
    try { payload = await res.json(); } catch (e) { /* empty body */ }
    return { status: res.status, body: payload, headers: res.headers };
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
            LIMIT_REGISTER_MAX: '100', // The suite intentionally creates isolated accounts.
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
    assert.equal(mineSync.headers.get('cache-control'), 'no-store');
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
    await appApi(device, 'POST', '/api/v1/account/main-device', { deviceId: device.deviceId });
    await appApi(device, 'POST', '/api/v1/sync/device-mode', { sessionsEnabled: true, cookiesEnabled: false });
    const setup = await appApi(device, 'GET', '/api/v1/account');
    await appApi(device, 'POST', '/api/v1/account/main-device/ready', { generation: setup.body.mainGeneration });

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
    await appApi(first, 'POST', '/api/v1/account/main-device', { deviceId: 'dev_coklu_1' });

    const localOnlySnapshot = await appApi(first, 'GET', '/api/v1/sync');
    assert.equal(localOnlySnapshot.status, 200);
    assert.equal(localOnlySnapshot.body.clients.length, 0,
        'tercih yapılmadan yerel oturum bulut envanterine girdi');

    const enabledDeviceSync = await appApi(first, 'POST', '/api/v1/sync/device-mode', {
        sessionsEnabled: true,
        cookiesEnabled: false
    });
    assert.equal(enabledDeviceSync.status, 200, JSON.stringify(enabledDeviceSync.body));
    assert.equal(enabledDeviceSync.body.sessionSyncEnabled, true);
    assert.equal(enabledDeviceSync.body.cookieSyncEnabled, false,
        'oturum eşitlemesi çerez eşitlemesini kendiliğinden açtı');
    const enabledCookieMode = await appApi(first, 'POST', '/api/v1/sync/device-mode', {
        sessionsEnabled: true,
        cookiesEnabled: true
    });
    assert.equal(enabledCookieMode.status, 200, JSON.stringify(enabledCookieMode.body));
    assert.equal(enabledCookieMode.body.cookieSyncEnabled, true);

    const enabledCookies = await appApi(first, 'POST', `/api/v1/sync/clients/${clientId}/cookies/enable`);
    assert.equal(enabledCookies.status, 200, JSON.stringify(enabledCookies.body));

    const preparedMain = await appApi(first, 'POST', '/api/v1/account/main-device/ready', { generation: enabledCookieMode.body.mainGeneration });
    assert.equal(preparedMain.status, 200);
    const firstGeneration = preparedMain.body.mainGeneration;
    const encryptedCookiePackage = Buffer.from('yalnizca-cihazda-cozulebilen-paket').toString('base64');
    const uploadedCookies = await appApi(first, 'PUT', `/api/v1/sync/clients/${clientId}/cookies`, {
        version: 2, generation: firstGeneration,
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
    const secondSyncChoice = await appApi(second, 'POST', '/api/v1/sync/device-mode', {
        sessionsEnabled: true,
        cookiesEnabled: true
    });
    assert.equal(secondSyncChoice.status, 200, JSON.stringify(secondSyncChoice.body));

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
    assert.equal(restorable.cookieSnapshot.version, 2);
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

    const changedDefault = await appApi(first, 'POST', '/api/v1/account/main-device', { deviceId: 'dev_coklu_2' });
    assert.equal(changedDefault.status, 200, JSON.stringify(changedDefault.body));
    assert.equal(changedDefault.body.defaultDeviceId, 'dev_coklu_2');
    assert.equal(changedDefault.body.isDefaultBrowser, false);
    const defaultAfterChoice = await callTool(token);
    assert.equal(defaultAfterChoice.status, 200);
    assert.equal((await defaultAfterChoice.json()).data.deviceId, 'dev_coklu_2',
        'cihaz kimliği olmayan istek kullanıcı seçimine gitmedi');

    const refused = await callTool(token, { deviceId: 'dev_hesap_disinda' });
    assert.equal(refused.status, 502);
    assert.match((await refused.json()).error, /yetkili değil/i);

    const secondGeneration = changedDefault.body.mainGeneration;
    assert.equal(changedDefault.body.mainReady, false, 'yeni ana cihaz hazırlanmadan yazabilir');
    const packageBody = { version: 2, generation: secondGeneration, iv: Buffer.from('on-iki-byte-iv').toString('base64'), ciphertext: encryptedCookiePackage };
    assert.equal((await appApi(second, 'PUT', `/api/v1/sync/clients/${clientId}/cookies`, packageBody)).status, 409);
    assert.equal((await appApi(first, 'PUT', `/api/v1/sync/clients/${clientId}/cookies`, { ...packageBody, generation: firstGeneration })).status, 403);
    assert.equal((await appApi(first, 'DELETE', `/api/v1/sync/clients/${clientId}/cookies`)).status, 403, 'yedek bulut kopyasını sildi');
    assert.equal((await appApi(first, 'POST', '/api/v1/account/main-device/ready', { generation: firstGeneration })).status, 409);
    await appApi(second, 'POST', `/api/v1/sync/clients/${clientId}/cookies/enable`);
    assert.equal((await appApi(second, 'POST', '/api/v1/account/main-device/ready', { generation: secondGeneration })).status, 200);
    assert.equal((await appApi(second, 'PUT', `/api/v1/sync/clients/${clientId}/cookies`, packageBody)).status, 200, 'yeni ana cihaz yazamadı');
    first.send({ type: 'revoke_client', clientId });
    await new Promise(r => setTimeout(r, 100));
    assert.equal((await callTool(token)).status, 200, 'yedekten silmek ana bağlantıyı iptal etti');
    assert.equal((await appApi(second, 'GET', '/api/v1/sync')).body.clients.find(c => c.clientId === clientId).cookieSnapshot.ciphertext, encryptedCookiePackage);
    first.send({ type: 'client_added', clientId, secretHash: sha256(secret), name: 'Ortak ChatGPT' });
    await new Promise(r => setTimeout(r, 100));
    const deletedCloudCookies = await appApi(second, 'DELETE', `/api/v1/sync/clients/${clientId}/cookies`, { generation: secondGeneration });
    assert.equal(deletedCloudCookies.status, 200);
    assert.equal((await appApi(second, 'PUT', `/api/v1/sync/clients/${clientId}/cookies`, packageBody)).status, 409);

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

    const selectFirst = await appApi(first, 'POST', '/api/v1/account/main-device', { deviceId: 'dev_coklu_1' });
    await appApi(first, 'POST', '/api/v1/account/main-device/ready', { generation: selectFirst.body.mainGeneration });
    first.send({ type: 'revoke_client', clientId });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await callTool(token)).status, 401, 'çoklu cihaz anahtarı iptalden sonra çalışıyor');

    first.close();
    second.close();
    reconnectRemoved.close();
});

test('şifreli mevcut token ikinci telefondan alınır ve OAuth aynı tokenı teslim eder', async (t) => {
    const secret = 'existing-bearer-secret-never-rotate';
    const clientId = 'cli_credential_share';
    const email = 'credential-share@test.com', password = 'credential-share-password';
    const first = await connectDevice('dev_credential_origin', 'credential-origin-device-secret', [{ clientId, secret, name: 'Shared AI' }]);
    t.after(() => first.close());
    const account = await appSignUp(first, email, password);
    const operator = await webSignIn(OPERATOR_EMAIL, 'operator-parolasi-uzun');
    assert.equal((await form(operator, '/admin/accounts/plan', { accountId: account.accountId, plan: 'pro' })).status, 303);
    const second = await connectDevice('dev_credential_backup', 'credential-backup-device-secret');
    t.after(() => second.close());
    assert.equal((await appApi(second, 'POST', '/api/v1/login', { email, password })).status, 200);
    const endpoint = `/api/v1/sync/clients/${clientId}/credential`;
    // Simulate the source phone encrypting the original secret with the account
    // key. The relay is given neither key nor secret in this publication request.
    const accountKey = crypto.pbkdf2Sync(password, `mcp-account-cookie-sync-v2|${account.accountId}`, 120000, 32, 'sha256');
    const transferKey = crypto.createHmac('sha256', accountKey).update('mcp-client-credential-key-v1').digest();
    const iv = crypto.randomBytes(12), hash = sha256(secret);
    const cipher = crypto.createCipheriv('aes-256-gcm', transferKey, iv);
    const aad = `credential-v1|${account.accountId.length}:${account.accountId}|${clientId.length}:${clientId}|${hash}`;
    cipher.setAAD(Buffer.from(aad));
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    const pkg = { version: 1, secretHash: hash, iv: iv.toString('base64'), ciphertext: encrypted.toString('base64'), cookieKeyRevision: 0 };
    assert.equal((await appApi(first, 'PUT', endpoint, pkg)).status, 409, 'sync-off source published automatically');
    await appApi(first, 'POST', '/api/v1/sync/device-mode', { sessionsEnabled: true, cookiesEnabled: false });
    assert.equal((await appApi(first, 'PUT', endpoint, { ...pkg, secret })).status, 400, 'plaintext field accepted');
    assert.equal((await appApi(first, 'PUT', endpoint, { ...pkg, iv: 'bad' })).status, 400);
    assert.equal((await appApi(first, 'PUT', endpoint, pkg)).status, 200);
    assert.equal((await appApi(second, 'GET', endpoint)).status, 404, 'unbound same-account device got package');
    assert.deepEqual((await appApi(second, 'GET', '/api/v1/sync')).body.credentialPackages, []);
    second.send({ type: 'client_added', clientId, secretHash: hash, name: 'Shared AI' });
    await new Promise(r => setTimeout(r, 250));
    assert.equal((await appApi(second, 'PUT', endpoint, pkg)).status, 409, 'backup replaced source package');
    const download = await appApi(second, 'GET', endpoint);
    assert.equal(download.status, 200, 'explicit retrieval required cookie or session sync');
    const received = download.body.credentialPackage;
    const bytes = Buffer.from(received.ciphertext, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', transferKey, Buffer.from(received.iv, 'base64'));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(bytes.subarray(-16));
    const restored = Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString('utf8');
    assert.equal(restored, secret);
    assert.equal(received.secret, undefined);
    assert.equal(JSON.stringify(download.body).includes(secret), false);
    const inventory = (await appApi(second, 'GET', '/api/v1/sync')).body;
    assert.equal(inventory.credentialSharingVersion, 1);
    assert.equal(inventory.credentialPackages.length, 1);
    assert.equal(inventory.clients.length, 0, 'key sharing implicitly published cloud restore inventory');
    assert.equal(inventory.defaultDeviceId, '', 'key sharing elected a main device');
    // Original browser credentials are unchanged, including when explicitly
    // routing to the secondary's already bound profile.
    assert.equal((await callTool(`${clientId}.${secret}`, { deviceId: 'dev_credential_origin' })).status, 200);
    assert.equal((await callTool(`${clientId}.${restored}`, { deviceId: 'dev_credential_backup' })).status, 200);
    const foreign = await connectDevice('dev_credential_foreign', 'credential-foreign-device-secret');
    t.after(() => foreign.close());
    await appSignUp(foreign, 'credential-foreign@test.com', 'credential-foreign-password');
    assert.equal((await appApi(foreign, 'GET', endpoint)).status, 404);
    assert.equal((await appApi(foreign, 'PUT', endpoint, pkg)).status, 409);
    assert.deepEqual((await appApi(foreign, 'GET', '/api/v1/sync')).body.credentialPackages, []);
    first.close();
    assert.equal((await appApi(second, 'GET', endpoint)).status, 200, 'source must not stay online after publication');
    second.send({ type: 'oauth_pairing_request', clientId, clientSecret: restored });
    const pairing = await second.next('oauth_pairing_code');
    assert.equal(pairing.status, 'ok');
    const redirectUri = 'http://127.0.0.1:9876/callback';
    const registration = await fetch(`${BASE}/oauth/register`, { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [redirectUri], client_name: 'Shared token test' }) });
    assert.equal(registration.status, 201);
    const oauthClient = await registration.json();
    const verifier = crypto.randomBytes(48).toString('base64url');
    const authorize = await fetch(`${BASE}/oauth/authorize`, { method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ response_type: 'code', client_id: oauthClient.client_id,
            redirect_uri: redirectUri, code: pairing.display, state: 'same-token', resource: BASE,
            code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }) });
    assert.equal(authorize.status, 303);
    const authCode = new URL(authorize.headers.get('location')).searchParams.get('code');
    const exchanged = await fetch(`${BASE}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: 'authorization_code', code: authCode, client_id: oauthClient.client_id,
            redirect_uri: redirectUri, code_verifier: verifier }) });
    assert.equal(exchanged.status, 200);
    assert.equal((await exchanged.json()).access_token, `${clientId}.${secret}`);
    assert.equal((await callTool(`${clientId}.${secret}`, { deviceId: 'dev_credential_backup' })).status, 200);
    // Storage and audit contain only the ciphertext/hash, never the shared key.
    await new Promise(r => setTimeout(r, 350));
    assert.equal(fs.readFileSync(stateFile, 'utf8').includes(secret), false);
    assert.equal(fs.readFileSync(stateFile, 'utf8').includes(accountKey.toString('base64')), false);
    assert.equal(JSON.stringify((await appApi(second, 'GET', '/api/v1/audit')).body).includes(secret), false);
    assert.equal((await appApi(second, 'POST', '/api/v1/account/password', { current: password,
        next: 'replacement-password-without-envelope', logoutOtherDevices: false })).status, 409);
    await appApi(second, 'POST', '/api/v1/logout');
    assert.equal((await appApi(second, 'GET', endpoint)).status, 403);
});

test('yedekte oluşturulan oturum ve yerel çerezler tek seferlik paketle ana cihaza devredilir', async () => {
    const email = 'yedek-devir@test.com';
    const password = 'yedek-devir-parolasi-uzun';
    const clientId = 'cli_yedek_devir';
    const secret = 'yedek-cihazda-uretilen-istemci-sirri';
    const main = await connectDevice('dev_devir_main', 'devir-main-cihaz-sirri');
    await appSignUp(main, email, password);
    const selected = await appApi(main, 'POST', '/api/v1/account/main-device', { deviceId: 'dev_devir_main' });
    await appApi(main, 'POST', '/api/v1/sync/device-mode', { sessionsEnabled: true, cookiesEnabled: true });

    const operator = await webSignIn(OPERATOR_EMAIL, 'operator-parolasi-uzun');
    const status = await (await visit(operator, '/api/status')).json();
    const account = status.accounts.find(a => a.email === email);
    assert.ok(account);
    assert.equal((await form(operator, '/admin/accounts/plan', { accountId: account.id, plan: 'pro' })).status, 303);

    const backup = await connectDevice('dev_devir_backup', 'devir-backup-cihaz-sirri', [
        { clientId, secret, name: 'Yedekteki Oturum' }
    ]);
    assert.equal((await appApi(backup, 'POST', '/api/v1/login', { email, password })).status, 200);
    await appApi(backup, 'POST', '/api/v1/sync/device-mode', { sessionsEnabled: true, cookiesEnabled: true });

    const iv = Buffer.from('on-iki-byte-iv').toString('base64');
    const ciphertext = Buffer.from('yedekteki-yerel-cerezlerin-sifreli-paketi').toString('base64');
    const published = await appApi(backup, 'POST', `/api/v1/sync/clients/${clientId}/publish`, {
        cookieSyncEnabled: true,
        cookieHandoff: { version: 2, iv, ciphertext, cookieKeyRevision: 0 }
    });
    assert.equal(published.status, 200, JSON.stringify(published.body));
    assert.equal(published.body.handoffQueued, true);

    const backupView = await appApi(backup, 'GET', '/api/v1/sync');
    assert.ok(backupView.body.clients.find(c => c.clientId === clientId));
    assert.equal(backupView.body.clients.find(c => c.clientId === clientId).cookieHandoff, null,
        'tek kullanımlık paket yedek cihaza geri açıldı');
    const mainView = await appApi(main, 'GET', '/api/v1/sync');
    const offered = mainView.body.clients.find(c => c.clientId === clientId);
    assert.equal(offered.cookieHandoff.ciphertext, ciphertext);
    assert.equal(offered.cookieSnapshot, null, 'ana cihaz uygulamadan devir paketi kalıcı yedeğe dönüştü');

    main.send({ type: 'client_added', clientId, secretHash: sha256(secret), name: 'Yedekteki Oturum' });
    await new Promise(r => setTimeout(r, 150));
    assert.equal((await appApi(main, 'POST', `/api/v1/sync/clients/${clientId}/cookies/enable`)).status, 200);
    const accepted = await appApi(main, 'POST', `/api/v1/sync/clients/${clientId}/cookies/handoff/accept`, {
        generation: selected.body.mainGeneration,
        updatedAt: offered.cookieHandoff.updatedAt
    });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    const after = (await appApi(main, 'GET', '/api/v1/sync')).body.clients.find(c => c.clientId === clientId);
    assert.equal(after.cookieHandoff, null);
    assert.equal(after.cookieSnapshot.ciphertext, ciphertext);
    assert.equal(after.cookieSnapshot.lastWriterDeviceId, 'dev_devir_main');

    assert.equal((await appApi(backup, 'PUT', `/api/v1/sync/clients/${clientId}/cookies`, {
        version: 2, generation: selected.body.mainGeneration, iv, ciphertext, cookieKeyRevision: 0
    })).status, 403, 'yedek cihaz normal ana-yazar yolundan paket yazdı');
    main.close();
    backup.close();
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


test('şifreli anahtar geçişi ve kapalı eşitlemede bulut yedeği yönetimi hesaba özeldir', async () => {
    const device = await connectDevice('dev_safety', 'device-safety-secret', [
        { clientId: 'cli_safety', secret: 'client-safety-secret', name: 'Safety' }
    ]);
    await appSignUp(device, 'safety@test.com', 'safety-password-old');
    await appApi(device, 'POST', '/api/v1/account/main-device', { deviceId: device.deviceId });
    await appApi(device, 'POST', '/api/v1/sync/device-mode', { sessionsEnabled: true, cookiesEnabled: true });
    const account = await appApi(device, 'GET', '/api/v1/account');
    await appApi(device, 'POST', '/api/v1/account/main-device/ready', { generation: account.body.mainGeneration });
    await appApi(device, 'POST', '/api/v1/sync/clients/cli_safety/cookies/enable');
    const packageBody = { generation: account.body.mainGeneration, version: 2,
        iv: Buffer.alloc(12, 1).toString('base64'), ciphertext: Buffer.alloc(48, 2).toString('base64') };
    assert.equal((await appApi(device, 'PUT', '/api/v1/sync/clients/cli_safety/cookies', packageBody)).status, 200);
    const change = { current: 'safety-password-old', next: 'safety-password-new' };
    assert.equal((await appApi(device, 'POST', '/api/v1/account/password', change)).status, 409);
    const envelope = { version: 1, iv: packageBody.iv, ciphertext: packageBody.ciphertext };
    assert.equal((await appApi(device, 'POST', '/api/v1/account/password',
        { ...change, cookieKeyEnvelope: { ...envelope, discarded: 'never-store-extra-fields' }, cookieKeyRevision: 0 })).status, 200);
    assert.deepEqual((await appApi(device, 'GET', '/api/v1/sync/key-envelope')).body, { envelope, revision: 1 });
    assert.equal((await appApi(device, 'PUT', '/api/v1/sync/clients/cli_safety/cookies', packageBody)).status, 409);
    assert.equal((await appApi(device, 'PUT', '/api/v1/sync/clients/cli_safety/cookies', { ...packageBody, cookieKeyRevision: 1 })).status, 200);
    const strongEnvelope = {
        version: 2,
        strong: { iv: Buffer.alloc(12, 3).toString('base64'), ciphertext: Buffer.alloc(48, 4).toString('base64') },
        legacy: envelope
    };
    assert.equal((await appApi(device, 'POST', '/api/v1/account/password', {
        current: 'safety-password-new', next: 'safety-password-newer',
        cookieKeyEnvelope: strongEnvelope, cookieKeyRevision: 1
    })).status, 200);
    assert.deepEqual((await appApi(device, 'GET', '/api/v1/sync/key-envelope')).body,
        { envelope, revision: 2 }, 'eski uygulama uyumlu sarmalayıcıyı almalı');
    assert.deepEqual((await appApi(device, 'GET', '/api/v1/sync/key-envelope', null,
        { 'x-cookie-key-envelope-version': '2' })).body,
        { envelope: strongEnvelope, revision: 2 }, 'güncel uygulama güçlendirilmiş sarmalayıcıyı almalı');
    assert.equal((await appApi(device, 'POST', '/api/v1/account/password', {
        current: 'safety-password-newer', next: 'unsafe-downgrade',
        cookieKeyEnvelope: envelope, cookieKeyRevision: 2
    })).status, 409, 'eski uygulama güçlü sarmalayıcıyı düşürmemeli');
    await appApi(device, 'POST', '/api/v1/sync/device-mode', { sessionsEnabled: false, cookiesEnabled: false });
    const list = await appApi(device, 'GET', '/api/v1/sync/cookie-backups');
    assert.equal(list.status, 200);
    assert.equal(list.body.backups.length, 1);
    assert.equal(list.body.backups[0].ciphertext, undefined);
    const foreign = await connectDevice('dev_safety_other', 'device-safety-secret-other');
    await appSignUp(foreign, 'safety-other@test.com', 'safety-other-password');
    assert.deepEqual((await appApi(foreign, 'GET', '/api/v1/sync/cookie-backups')).body.backups, []);
    assert.equal((await appApi(foreign, 'DELETE', '/api/v1/sync/cookie-backups', { backups: list.body.backups })).status, 409);
    assert.equal((await appApi(device, 'DELETE', '/api/v1/sync/cookie-backups', { backups: list.body.backups })).status, 200);
    assert.deepEqual((await appApi(device, 'GET', '/api/v1/sync/cookie-backups')).body.backups, []);
    assert.equal((await appApi(device, 'GET', '/api/v1/account')).body.sessionSyncEnabled, false);
    device.close(); foreign.close();
});
