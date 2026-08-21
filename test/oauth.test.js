'use strict';

/**
 * OAuth 2.1 tests.
 *
 * The whole flow is driven end to end against a real relay and a real
 * WebSocket, because the interesting failures are all at the seams: a phone
 * offering a code for a client that is not its own, a code redeemed twice, a
 * verifier that does not match, a redirect_uri that was never registered.
 *
 * The claim worth defending hardest is the one that keeps this feature honest:
 * **the token the relay issues is the credential the phone already minted.** If
 * that ever stops being true, the relay has started storing something it
 * promised not to, and the last assertion in the happy-path test is what
 * notices.
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
const PORT = 41801;
const BASE = `http://127.0.0.1:${PORT}`;

let child;
let stateFile;

// --- helpers ---------------------------------------------------------------

function sha256(v) {
    return crypto.createHash('sha256').update(String(v)).digest('hex');
}

function base64url(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A PKCE pair the way a real client makes one. */
function newPkce() {
    const verifier = base64url(crypto.randomBytes(48));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    return { verifier, challenge };
}

/** A fake phone that registers, then answers whatever it is asked. */
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
            if (payload.messageId && payload.type && payload.clientId) {
                ws.send(JSON.stringify({
                    type: 'response',
                    messageId: payload.messageId,
                    status: 'success',
                    data: { url: 'https://example.com/', markdown: 'merhaba' }
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

async function registerOAuthClient(redirectUris = ['http://127.0.0.1:9876/callback']) {
    const res = await fetch(`${BASE}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            client_name: 'Claude Code (test)',
            redirect_uris: redirectUris,
            grant_types: ['authorization_code'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none'
        })
    });
    return { status: res.status, body: await res.json() };
}

/** Asks the phone to offer a pairing code and waits for the relay's answer. */
async function pairingCodeFor(device, clientId, secret) {
    device.send({ type: 'oauth_pairing_request', clientId, clientSecret: secret });
    return device.next('oauth_pairing_code');
}

/** Posts the pairing form exactly as the browser would. */
function submitAuthorize(fields) {
    return fetch(`${BASE}/oauth/authorize`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString()
    });
}

async function exchange(fields) {
    const res = await fetch(`${BASE}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(fields)
    });
    return { status: res.status, body: await res.json() };
}

/** Runs one MCP command with whatever credential we were handed. */
function callTool(token) {
    return fetch(`${BASE}/tools/browser_get_markdown`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({})
    });
}

// --- lifecycle -------------------------------------------------------------

test.before(async () => {
    stateFile = path.join(os.tmpdir(), `bridge-oauth-test-${Date.now()}.json`);
    child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(PORT),
            DATABASE_URL: '',
            BRIDGE_STATE_FILE: stateFile,
            ALLOW_REGISTRATION: 'true',
            // The pairing limit is per IP and every test here shares one.
            LIMIT_PAIRING_MAX: '200'
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

// --- discovery -------------------------------------------------------------

test('kimliksiz istek OAuth sunucusunu işaret eder', async () => {
    // A bare 401 tells a client nothing. The pointer in WWW-Authenticate is the
    // entire reason an MCP client can start this flow on its own.
    const res = await callTool('yok.yok');
    assert.equal(res.status, 401);

    const challenge = res.headers.get('www-authenticate') || '';
    assert.match(challenge, /^Bearer /);
    assert.match(challenge, /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource"/);
});

test('keşif belgeleri yayınlanıyor', async () => {
    const prm = await fetch(`${BASE}/.well-known/oauth-protected-resource`);
    assert.equal(prm.status, 200);
    const resource = await prm.json();
    assert.equal(resource.resource, BASE);
    assert.deepEqual(resource.authorization_servers, [BASE]);

    // The path-suffixed form is what a client whose endpoint is /sse looks for
    // first (RFC 9728 §3.1).
    const suffixed = await fetch(`${BASE}/.well-known/oauth-protected-resource/sse`);
    assert.equal(suffixed.status, 200);

    const asm = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
    assert.equal(asm.status, 200);
    const meta = await asm.json();
    assert.equal(meta.issuer, BASE);
    assert.equal(meta.authorization_endpoint, `${BASE}/oauth/authorize`);
    assert.equal(meta.token_endpoint, `${BASE}/oauth/token`);
    assert.equal(meta.registration_endpoint, `${BASE}/oauth/register`);
    assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(meta.token_endpoint_auth_methods_supported, ['none']);

    // Scopes are deliberately absent: permissions live on the phone and an
    // OAuth scope could not affect any of them. Advertising one would promise a
    // control that does nothing.
    assert.equal(meta.scopes_supported, undefined, 'kapsam ilan edilmemeli');
});

// --- registration ----------------------------------------------------------

test('istemci kendini kaydedebilir', async () => {
    const { status, body } = await registerOAuthClient();
    assert.equal(status, 201);
    assert.match(body.client_id, /^mcp_[0-9a-f]{32}$/);
    assert.equal(body.token_endpoint_auth_method, 'none');
    assert.equal(body.client_secret, undefined, 'genel istemciye sır verilmemeli');
});

test('güvensiz redirect_uri reddedilir', async () => {
    // http off the loopback interface means the code travels in clear text.
    const remote = await registerOAuthClient(['http://ornek.com/callback']);
    assert.equal(remote.status, 400);
    assert.equal(remote.body.error, 'invalid_redirect_uri');

    const scripted = await registerOAuthClient(['javascript:alert(1)']);
    assert.equal(scripted.status, 400);

    // https anywhere, and http on loopback, are both fine.
    assert.equal((await registerOAuthClient(['https://claude.ai/api/mcp/auth_callback'])).status, 201);
    assert.equal((await registerOAuthClient(['http://localhost:1/cb'])).status, 201);
});

test('istemci sırrı taşıyan akışlar reddedilir', async () => {
    const res = await fetch(`${BASE}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            redirect_uris: ['http://127.0.0.1:9876/callback'],
            token_endpoint_auth_method: 'client_secret_post'
        })
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_client_metadata');
});

// --- the happy path --------------------------------------------------------

test('telefondaki kodla tam akış çalışır ve jeton komut çalıştırır', async () => {
    const secret = 'istemci-sirri-uzun-yeterince-1';
    const device = await connectDevice('dev_oauth', 'cihaz-sirri-16-karakter', [
        { clientId: 'cli_oauth', secret, name: 'Claude Code' }
    ]);

    const registered = await registerOAuthClient();
    const pkce = newPkce();

    // 1. The phone offers a code for one of its own clients.
    const offer = await pairingCodeFor(device, 'cli_oauth', secret);
    assert.equal(offer.status, 'ok');
    assert.equal(offer.code.length, 8);
    assert.match(offer.display, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);

    // 2. The browser lands on the page and it renders the asking client's name.
    const query = new URLSearchParams({
        response_type: 'code',
        client_id: registered.body.client_id,
        redirect_uri: 'http://127.0.0.1:9876/callback',
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        state: 'durum-123',
        resource: BASE
    });
    const page = await fetch(`${BASE}/oauth/authorize?${query}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Claude Code \(test\)/);
    // The page's whole surface is one code field. No credential is ever typed
    // into a browser here — that is the reason this flow was chosen over one
    // that signs the user in on the web.
    assert.doesNotMatch(html, /type="password"/i, 'sayfada parola alanı olmamalı');
    assert.doesNotMatch(html, /name="(password|email)"/i, 'sayfa kimlik bilgisi toplamamalı');

    // 3. The user types the code. Lowercase and a stray hyphen on purpose:
    //    this is copied off one screen onto another by a human.
    const submitted = await submitAuthorize({
        response_type: 'code',
        client_id: registered.body.client_id,
        redirect_uri: 'http://127.0.0.1:9876/callback',
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        state: 'durum-123',
        resource: BASE,
        code: offer.display.toLowerCase()
    });
    assert.equal(submitted.status, 302);

    const location = new URL(submitted.headers.get('location'));
    assert.equal(location.origin + location.pathname, 'http://127.0.0.1:9876/callback');
    assert.equal(location.searchParams.get('state'), 'durum-123', 'state geri dönmeli');
    const authCode = location.searchParams.get('code');
    assert.ok(authCode, 'yetkilendirme kodu dönmedi');

    // 4. The exchange.
    const token = await exchange({
        grant_type: 'authorization_code',
        code: authCode,
        client_id: registered.body.client_id,
        redirect_uri: 'http://127.0.0.1:9876/callback',
        code_verifier: pkce.verifier
    });
    assert.equal(token.status, 200);
    assert.equal(token.body.token_type, 'Bearer');

    // The load-bearing assertion. The relay hands back the credential the phone
    // minted — it does not invent one, which is why it still stores nothing but
    // a hash and why a relay compromise gains nothing new.
    assert.equal(token.body.access_token, `cli_oauth.${secret}`);

    // No expiry is claimed, because there is none to claim.
    assert.equal(token.body.expires_in, undefined);
    assert.equal(token.body.refresh_token, undefined);

    // 5. And it drives the browser.
    const call = await callTool(token.body.access_token);
    assert.equal(call.status, 200);

    device.close();
});

// --- the seams -------------------------------------------------------------

test('kod tek kullanımlık', async () => {
    const secret = 'istemci-sirri-tek-kullanim-1';
    const device = await connectDevice('dev_tek', 'cihaz-sirri-16-karakter', [
        { clientId: 'cli_tek', secret, name: 'Tek kullanım' }
    ]);
    const registered = await registerOAuthClient();
    const pkce = newPkce();
    const offer = await pairingCodeFor(device, 'cli_tek', secret);

    const fields = {
        response_type: 'code',
        client_id: registered.body.client_id,
        redirect_uri: 'http://127.0.0.1:9876/callback',
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        state: '',
        resource: BASE,
        code: offer.code
    };

    assert.equal((await submitAuthorize(fields)).status, 302);

    // A code that survived its own use would let anyone who saw it on screen
    // pair a second client of their own.
    const second = await submitAuthorize(fields);
    assert.equal(second.status, 400);
    assert.match(await second.text(), /geçersiz ya da süresi dolmuş/i);

    device.close();
});

test('yanlış code_verifier jetona dönüşmez', async () => {
    const secret = 'istemci-sirri-pkce-testi-11';
    const device = await connectDevice('dev_pkce', 'cihaz-sirri-16-karakter', [
        { clientId: 'cli_pkce', secret, name: 'PKCE' }
    ]);
    const registered = await registerOAuthClient();
    const pkce = newPkce();
    const offer = await pairingCodeFor(device, 'cli_pkce', secret);

    const submitted = await submitAuthorize({
        response_type: 'code',
        client_id: registered.body.client_id,
        redirect_uri: 'http://127.0.0.1:9876/callback',
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        state: '',
        resource: BASE,
        code: offer.code
    });
    const authCode = new URL(submitted.headers.get('location')).searchParams.get('code');

    const stolen = await exchange({
        grant_type: 'authorization_code',
        code: authCode,
        client_id: registered.body.client_id,
        redirect_uri: 'http://127.0.0.1:9876/callback',
        code_verifier: newPkce().verifier
    });
    assert.equal(stolen.status, 400);
    assert.equal(stolen.body.error, 'invalid_grant');

    device.close();
});

test('PKCE olmadan yetkilendirme yapılmaz', async () => {
    const registered = await registerOAuthClient();
    const query = new URLSearchParams({
        response_type: 'code',
        client_id: registered.body.client_id,
        redirect_uri: 'http://127.0.0.1:9876/callback',
        state: 'abc'
    });
    const res = await fetch(`${BASE}/oauth/authorize?${query}`, { redirect: 'manual' });

    // The address is verified by now, so the protocol error goes to the client
    // rather than being rendered at a stranger.
    assert.equal(res.status, 302);
    const location = new URL(res.headers.get('location'));
    assert.equal(location.searchParams.get('error'), 'invalid_request');
    assert.match(location.searchParams.get('error_description'), /PKCE/);
});

test('kayıtsız redirect_uri yönlendirme almaz', async () => {
    const registered = await registerOAuthClient();
    const query = new URLSearchParams({
        response_type: 'code',
        client_id: registered.body.client_id,
        redirect_uri: 'https://saldirgan.example/al',
        code_challenge: newPkce().challenge,
        code_challenge_method: 'S256'
    });
    const res = await fetch(`${BASE}/oauth/authorize?${query}`, { redirect: 'manual' });

    // Redirecting to prove a redirect is wrong is how open redirectors are
    // built. The error is rendered here instead.
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('location'), null);
});

test('cihaz başkasının istemcisi için kod üretemez', async () => {
    const mine = 'istemci-sirri-benim-olan-12';
    const owner = await connectDevice('dev_sahip', 'cihaz-sirri-16-karakter', [
        { clientId: 'cli_sahip', secret: mine, name: 'Sahibi' }
    ]);
    const stranger = await connectDevice('dev_yabanci', 'cihaz-sirri-16-karakter', []);

    // The registry decides, not the message: a bug on one phone must not become
    // a way to hand out another phone's credential.
    stranger.send({ type: 'oauth_pairing_request', clientId: 'cli_sahip', clientSecret: mine });
    const refused = await stranger.next('oauth_pairing_code');
    assert.equal(refused.status, 'rejected');

    // And the right phone with the wrong secret gets the same answer.
    owner.send({ type: 'oauth_pairing_request', clientId: 'cli_sahip', clientSecret: 'yanlis-sir' });
    const badSecret = await owner.next('oauth_pairing_code');
    assert.equal(badSecret.status, 'rejected');

    owner.close();
    stranger.close();
});

test('iptal jetonu gerçekten öldürür', async () => {
    const secret = 'istemci-sirri-iptal-icin-13';
    const device = await connectDevice('dev_iptal', 'cihaz-sirri-16-karakter', [
        { clientId: 'cli_iptal', secret, name: 'İptal edilecek' }
    ]);

    const token = `cli_iptal.${secret}`;
    assert.equal((await callTool(token)).status, 200);

    const revoked = await fetch(`${BASE}/oauth/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token })
    });
    assert.equal(revoked.status, 200);

    // The phone is told, so its own list does not disagree with what the relay
    // will honour.
    const notice = await device.next('client_revoked');
    assert.equal(notice.clientId, 'cli_iptal');

    assert.equal((await callTool(token)).status, 401, 'iptal edilen jeton hâlâ çalışıyor');

    // RFC 7009 §2.2: an unknown token is still a success, or the endpoint
    // becomes an oracle.
    const unknown = await fetch(`${BASE}/oauth/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'yok.yok' })
    });
    assert.equal(unknown.status, 200);

    device.close();
});
