'use strict';

/**
 * OAuth 2.1 for MCP clients.
 *
 * Claude Code and the other current MCP clients no longer expect a human to
 * paste a bearer key into a config file; they expect to discover an
 * authorization server, register themselves, and be handed a token. This module
 * is that layer — and it is deliberately **only** that layer.
 *
 * The rule everything else in this project follows still holds here: the device
 * is the authority and the relay only routes. So OAuth does not mint anything.
 * The token this server issues *is* the client credential the phone already
 * created — `<clientId>.<secret>`, the same string a user used to copy by hand.
 * Three consequences, all of them the point:
 *
 * - `authenticate()` does not change. An OAuth-issued token and a hand-pasted
 *   key are the same bytes, verified the same way, forwarded to the phone the
 *   same way, and checked there against the phone's own registry.
 * - The relay stores nothing new. It still keeps only `sha256(secret)`; the
 *   plaintext lives in memory for the few minutes between the phone offering a
 *   pairing code and the client redeeming it, and is dropped the moment the
 *   token endpoint answers.
 * - A relay compromise gains exactly what it gained before — no more. There is
 *   no path here by which the relay can issue a credential the phone would
 *   accept, because only the phone can announce a `secretHash`.
 *
 * What OAuth genuinely buys, then, is discovery and delivery: no clipboard, no
 * config editing, and a revocation endpoint that actually revokes.
 *
 * Scopes are **not** advertised. The permissions that decide what a client may
 * do (`read`, `navigate`, `interact`, `execute_js`, `clear_data`,
 * `sensitive_fields`) live on the phone, are set by its owner, and are checked
 * there on every command. An OAuth scope string could not affect any of them,
 * and a control that does nothing is worse than no control — it tells the user
 * that turning it off achieved something.
 */

const { createHash, randomBytes, timingSafeEqual } = require('crypto');

// ---------------------------------------------------------------------------
// Lifetimes
// ---------------------------------------------------------------------------

/** Long enough to walk from the phone to the keyboard, short enough that a
 *  code left on screen is not a standing invitation. */
const PAIRING_TTL_MS = 5 * 60 * 1000;

/** An authorization code is redeemed by a program, not a person: it is handed
 *  over in the redirect and exchanged immediately. A minute is generous. */
const AUTH_CODE_TTL_MS = 60 * 1000;

/** How long a dynamically registered client is remembered without being used. */
const REGISTRATION_IDLE_MS = 180 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Pairing codes
// ---------------------------------------------------------------------------

/**
 * Crockford base32, which excludes I, L, O and U.
 *
 * The exclusions are the reason to use it rather than digits: a code is read off
 * one screen and typed into another, and `0`/`O` and `1`/`I`/`l` are where that
 * goes wrong. Crockford also defines the *decoding* side of those confusions, so
 * a user who types the lookalike still succeeds instead of being told the code
 * is wrong.
 *
 * Eight characters is 32^8 ≈ 1.1e12. Six digits would have been 1e6, which a
 * rate limit can defend but only just; the extra two characters cost nothing to
 * type and remove the question.
 */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;

function newPairingCode() {
    // Rejection-free: 32 divides 256 evenly, so masking the low 5 bits is
    // uniform and no byte has to be thrown away.
    const bytes = randomBytes(CODE_LENGTH);
    let out = '';
    for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[bytes[i] & 31];
    return out;
}

/** `ABCD2345` -> `ABCD-2345`, which is how it is shown and read aloud. */
function formatPairingCode(code) {
    const raw = String(code || '');
    if (raw.length !== CODE_LENGTH) return raw;
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/**
 * Accepts what a person actually types: any casing, hyphens or spaces
 * anywhere, and the Crockford lookalikes.
 */
function normalisePairingCode(input) {
    return String(input || '')
        .toUpperCase()
        .replace(/[^0-9A-Z]/g, '')
        .replace(/[IL]/g, '1')
        .replace(/O/g, '0');
}

function isWellFormedCode(code) {
    if (code.length !== CODE_LENGTH) return false;
    for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return false;
    return true;
}

// ---------------------------------------------------------------------------
// Constant-time comparison
// ---------------------------------------------------------------------------

function safeEquals(a, b) {
    const bufA = Buffer.from(String(a || ''), 'utf8');
    const bufB = Buffer.from(String(b || ''), 'utf8');
    if (bufA.length !== bufB.length || bufA.length === 0) return false;
    return timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

function base64url(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * S256 only.
 *
 * OAuth 2.1 removes `plain`, and accepting it here would mean a challenge that
 * travels in the same redirect as the code it is supposed to protect.
 */
function verifyPkce(verifier, challenge, method) {
    if (String(method || 'S256') !== 'S256') return false;
    const value = String(verifier || '');
    // RFC 7636 §4.1
    if (value.length < 43 || value.length > 128) return false;
    if (!/^[A-Za-z0-9\-._~]+$/.test(value)) return false;
    return safeEquals(base64url(createHash('sha256').update(value).digest()), String(challenge || ''));
}

// ---------------------------------------------------------------------------
// Short-lived state
// ---------------------------------------------------------------------------

/**
 * Everything here is in memory on purpose.
 *
 * A pairing entry holds a **plaintext client secret**, which is the one thing
 * this relay has always refused to write down. Keeping it in a process that
 * forgets it on restart, and dropping it the moment it is used, is what lets
 * that promise survive the arrival of OAuth. The cost is that a restart during
 * those five minutes makes the user press the button again, which is the right
 * side of that trade.
 */
function createEphemeralStore(ttlMs, sweepMs = 60 * 1000) {
    const entries = new Map();

    function sweep() {
        const now = Date.now();
        for (const [key, value] of entries) {
            if (value.expiresAt <= now) entries.delete(key);
        }
    }

    const timer = setInterval(sweep, sweepMs);
    if (timer.unref) timer.unref();

    return {
        put(key, value) {
            entries.set(key, { ...value, expiresAt: Date.now() + ttlMs });
            return entries.get(key);
        },
        /** Reads and deletes: every code in this file is single-use. */
        take(key) {
            const found = entries.get(key);
            if (!found) return null;
            entries.delete(key);
            if (found.expiresAt <= Date.now()) return null;
            return found;
        },
        peek(key) {
            const found = entries.get(key);
            if (!found) return null;
            if (found.expiresAt <= Date.now()) {
                entries.delete(key);
                return null;
            }
            return found;
        },
        delete(key) { entries.delete(key); },
        /** Drops every entry belonging to one device — used when it disconnects. */
        dropWhere(predicate) {
            let removed = 0;
            for (const [key, value] of entries) {
                if (predicate(value)) { entries.delete(key); removed++; }
            }
            return removed;
        },
        get size() { return entries.size; },
        stop() { clearInterval(timer); }
    };
}

// ---------------------------------------------------------------------------
// Redirect URIs
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

function parseRedirect(value) {
    try {
        return new URL(String(value));
    } catch (e) {
        return null;
    }
}

/**
 * What a client is allowed to register as a landing place.
 *
 * `http` is refused except on the loopback interface, because a code delivered
 * over plain http on the open network is a code an observer also has. Loopback
 * is the exception RFC 8252 carves out for exactly this case: a native client
 * that opens a browser and listens on a local port.
 */
function redirectUriProblem(value) {
    const url = parseRedirect(value);
    if (!url) return 'redirect_uri geçerli bir URL değil.';
    if (url.hash) return 'redirect_uri fragment içeremez.';

    const scheme = url.protocol.replace(/:$/, '').toLowerCase();
    if (scheme === 'javascript' || scheme === 'data' || scheme === 'file') {
        return `redirect_uri şeması kabul edilmiyor: ${scheme}.`;
    }
    if (scheme === 'http' && !LOOPBACK_HOSTS.has(url.hostname)) {
        return 'http yalnızca 127.0.0.1 veya localhost için kabul edilir; diğer adresler https olmalı.';
    }
    return null;
}

function isLoopback(url) {
    return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Exact match, with one documented exception: a loopback client cannot know in
 * advance which port the OS will give it, so RFC 8252 §7.3 says the port is not
 * part of the comparison. Everything else — scheme, host, path — is.
 */
function redirectMatches(registered, requested) {
    const a = parseRedirect(registered);
    const b = parseRedirect(requested);
    if (!a || !b) return false;
    if (a.protocol !== b.protocol) return false;
    if (a.hostname.toLowerCase() !== b.hostname.toLowerCase()) return false;
    if (a.pathname !== b.pathname) return false;
    if (isLoopback(a) && isLoopback(b)) return true;
    return a.port === b.port;
}

// ---------------------------------------------------------------------------
// Dynamic client registration (RFC 7591)
// ---------------------------------------------------------------------------

/**
 * Validates a registration request and returns the record to store.
 *
 * Every client here is **public**: an MCP client is a program on the user's own
 * machine, so it cannot keep a client secret, and pretending otherwise would
 * add a secret that leaks by construction. PKCE is what protects the exchange
 * instead, and it is required rather than optional.
 */
function validateRegistration(body) {
    const redirectUris = Array.isArray(body && body.redirect_uris) ? body.redirect_uris : null;
    if (!redirectUris || redirectUris.length === 0) {
        return { error: 'invalid_redirect_uri', message: 'redirect_uris zorunlu ve en az bir adres içermeli.' };
    }
    if (redirectUris.length > 10) {
        return { error: 'invalid_redirect_uri', message: 'En fazla 10 redirect_uri kabul edilir.' };
    }
    for (const uri of redirectUris) {
        const problem = redirectUriProblem(uri);
        if (problem) return { error: 'invalid_redirect_uri', message: problem };
    }

    const grantTypes = Array.isArray(body.grant_types) && body.grant_types.length
        ? body.grant_types
        : ['authorization_code'];
    for (const grant of grantTypes) {
        if (grant !== 'authorization_code') {
            return {
                error: 'invalid_client_metadata',
                message: `Desteklenmeyen grant_type: ${grant}. Yalnızca authorization_code var — bu röle yenileme jetonu vermez çünkü verdiği jeton zaten süresizdir.`
            };
        }
    }

    const authMethod = String(body.token_endpoint_auth_method || 'none');
    if (authMethod !== 'none') {
        return {
            error: 'invalid_client_metadata',
            message: 'token_endpoint_auth_method yalnızca "none" olabilir: MCP istemcileri kullanıcının kendi makinesinde çalışır ve bir istemci sırrını saklayamaz. Değişim PKCE ile korunuyor.'
        };
    }

    return {
        record: {
            id: 'mcp_' + randomBytes(16).toString('hex'),
            name: String(body.client_name || 'MCP istemcisi').substring(0, 80),
            redirectUris: redirectUris.map(String),
            createdAt: Date.now(),
            lastUsedAt: Date.now()
        }
    };
}

function registrationResponse(record) {
    return {
        client_id: record.id,
        client_id_issued_at: Math.floor(record.createdAt / 1000),
        client_name: record.name,
        redirect_uris: record.redirectUris,
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none'
    };
}

// ---------------------------------------------------------------------------
// Metadata documents
// ---------------------------------------------------------------------------

/** The public origin, taken from the proxy headers Render actually sets. */
function originOf(req) {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const proto = forwardedProto || (req.secure ? 'https' : 'http');
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    return `${proto}://${host}`;
}

/**
 * RFC 9728. This is the document a client finds first — from the
 * `WWW-Authenticate` header on a 401 — and it exists to answer one question:
 * which authorization server may issue tokens for this resource.
 */
function protectedResourceMetadata(origin) {
    return {
        resource: origin,
        authorization_servers: [origin],
        bearer_methods_supported: ['header'],
        resource_name: 'Android Tarayıcı MCP Köprüsü',
        resource_documentation: `${origin}/`
    };
}

/**
 * RFC 8414.
 *
 * `scopes_supported` is absent on purpose — see the note at the top of this
 * file. `revocation_endpoint` is present because it does something real: it
 * removes the client from the registry, so the key stops routing, and tells the
 * phone so its own list does not disagree.
 */
function authorizationServerMetadata(origin) {
    return {
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`,
        revocation_endpoint: `${origin}/oauth/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        revocation_endpoint_auth_methods_supported: ['none'],
        service_documentation: `${origin}/`
    };
}

// ---------------------------------------------------------------------------
// The one page a user sees
// ---------------------------------------------------------------------------

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * The whole web surface of this feature: one input.
 *
 * The app is meant to be the entire user experience, and a browser page is the
 * one thing OAuth genuinely requires. So the page asks for the least it can —
 * a code the phone already produced — and never for a password. Nothing here
 * grants anything either: the credential was minted on the device before this
 * page was ever opened.
 */
function renderAuthorizePage({ clientName, hidden, error, notice }) {
    const fields = Object.entries(hidden || {})
        .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`)
        .join('\n            ');
    // Some hosted OAuth browsers submit only the field the user interacted
    // with and discard hidden controls. Keep the authorization context in the
    // form target as well, so `client_id`, redirect_uri, state and PKCE survive
    // those clients. The POST handler validates the same values either way;
    // this is redundant transport, not a second source of authority.
    const actionQuery = new URLSearchParams(
        Object.entries(hidden || {}).map(([key, value]) => [key, String(value)])
    ).toString();
    const formAction = actionQuery ? `/oauth/authorize?${actionQuery}` : '/oauth/authorize';

    return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Bağlantıyı onayla</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f5f6f8; --card: #ffffff; --ink: #16181d; --muted: #5c6270;
    --line: #dfe2e8; --accent: #2f6df6; --accent-ink: #ffffff;
    --bad-bg: #fdecec; --bad-ink: #9a1f1f; --bad-line: #f3c6c6;
    --good-bg: #eaf4ec; --good-ink: #1f6b34; --good-line: #c3e2cc;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #101216; --card: #191c22; --ink: #eceef2; --muted: #9aa1b0;
      --line: #2b303a; --accent: #5a8cff; --accent-ink: #0d1016;
      --bad-bg: #33191b; --bad-ink: #ffb4b4; --bad-line: #5a2a2d;
      --good-bg: #16291d; --good-ink: #a6e0b8; --good-line: #2c4a36;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 24px; background: var(--bg); color: var(--ink);
    font: 15px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .card {
    width: 100%; max-width: 440px; background: var(--card);
    border: 1px solid var(--line); border-radius: 14px; padding: 28px;
  }
  h1 { margin: 0 0 6px; font-size: 20px; letter-spacing: -0.01em; }
  .sub { margin: 0 0 22px; color: var(--muted); font-size: 14px; }
  .who { font-weight: 600; color: var(--ink); }
  label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 8px; }
  input[type=text] {
    width: 100%; padding: 14px 16px; font-size: 22px; letter-spacing: 0.18em;
    text-align: center; text-transform: uppercase; font-family: ui-monospace, Menlo, Consolas, monospace;
    border: 1px solid var(--line); border-radius: 10px; background: var(--bg); color: var(--ink);
  }
  input[type=text]:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  button {
    width: 100%; margin-top: 16px; padding: 13px 16px; font-size: 15px; font-weight: 600;
    border: 0; border-radius: 10px; background: var(--accent); color: var(--accent-ink); cursor: pointer;
  }
  .msg { padding: 12px 14px; border-radius: 10px; font-size: 13.5px; margin-bottom: 18px; }
  .bad { background: var(--bad-bg); color: var(--bad-ink); border: 1px solid var(--bad-line); }
  .good { background: var(--good-bg); color: var(--good-ink); border: 1px solid var(--good-line); }
  ol { margin: 22px 0 0; padding-left: 20px; color: var(--muted); font-size: 13.5px; }
  li { margin-bottom: 6px; }
  .foot { margin-top: 22px; padding-top: 16px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12.5px; }
</style>
</head>
<body>
  <main class="card">
    <h1>Bağlantıyı onayla</h1>
    <p class="sub"><span class="who">${escapeHtml(clientName || 'Bir MCP istemcisi')}</span> telefonunuzdaki tarayıcıya bağlanmak istiyor.</p>

    ${error ? `<div class="msg bad">${escapeHtml(error)}</div>` : ''}
    ${notice ? `<div class="msg good">${escapeHtml(notice)}</div>` : ''}

    <form method="post" action="${escapeHtml(formAction)}" autocomplete="off">
            ${fields}
      <label for="code">Telefondaki bağlantı kodu</label>
      <input id="code" name="code" type="text" inputmode="text" autocapitalize="characters"
             spellcheck="false" autocomplete="one-time-code" placeholder="ABCD-2345"
             maxlength="9" pattern="[0-9A-Za-z]{4}-?[0-9A-Za-z]{4}"
             title="8 karakterlik kod (ör. D2J5-QT5R)" required autofocus>
      <button type="submit">Bağlan</button>
    </form>

    <ol>
      <li>Telefonda uygulamayı açın.</li>
      <li><strong>Ayarlar → MCP → Oturumlar</strong>'a gidin.</li>
      <li>Kullanmak istediğiniz istemci kartında <strong>“OAuth bağlantı kodu”</strong>na dokunun.</li>
      <li>Ekranda çıkan kodu buraya yazın. Kod 5 dakika geçerlidir ve bir kez kullanılır.</li>
    </ol>

    <p class="foot">Bu sayfa parola istemez ve hiçbir yetki vermez. Erişim anahtarını
    telefonunuz üretir; bu adım yalnızca onu istemciye teslim eder. İzinleri
    istediğiniz zaman aynı istemci kartından değiştirebilir veya erişimi
    kaldırabilirsiniz.</p>
  </main>
  <script>
    // The phone displays four-plus-four. Keep the browser field identical so
    // the user never has to decide whether the dash belongs to the code. Both
    // typing eight plain characters and pasting the phone's formatted value
    // settle on the same D2J5-QT5R shape; the server still normalises too, so
    // this is usability rather than a security boundary.
    (function () {
      var field = document.getElementById('code');
      if (!field) return;
      function format() {
        var raw = field.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8);
        field.value = raw.length > 4 ? raw.slice(0, 4) + '-' + raw.slice(4) : raw;
      }
      field.addEventListener('input', format);
      field.addEventListener('paste', function () { setTimeout(format, 0); });
      format();
    })();
  </script>
</body>
</html>`;
}

module.exports = {
    PAIRING_TTL_MS,
    AUTH_CODE_TTL_MS,
    REGISTRATION_IDLE_MS,
    CODE_LENGTH,
    CODE_ALPHABET,
    newPairingCode,
    formatPairingCode,
    normalisePairingCode,
    isWellFormedCode,
    safeEquals,
    base64url,
    verifyPkce,
    createEphemeralStore,
    redirectUriProblem,
    redirectMatches,
    validateRegistration,
    registrationResponse,
    originOf,
    protectedResourceMetadata,
    authorizationServerMetadata,
    renderAuthorizePage,
    escapeHtml
};
