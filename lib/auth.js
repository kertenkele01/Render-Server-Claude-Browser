'use strict';

/**
 * Account credentials and browser sessions for the control panel.
 *
 * This is a separate identity system from the MCP credential. An account owns
 * devices; a device mints client keys. Holding a panel session never lets you
 * drive a browser — the phone still verifies the client secret itself — and
 * holding a client key never gets you into the panel.
 */

const { randomBytes, scrypt, timingSafeEqual, createHash } = require('crypto');
const { promisify } = require('util');

const scryptAsync = promisify(scrypt);

// N=2^15 keeps a login around 100ms on the small instances this relay runs on.
// Raising it is cheap to do later; the salt and hash are stored side by side so
// a rehash-on-login pass can upgrade accounts without a reset.
const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = 'bridge_session';
const CSRF_COOKIE = 'bridge_csrf';

const MIN_PASSWORD_LENGTH = 12;

function sha256(value) {
    return createHash('sha256').update(String(value)).digest('hex');
}

function safeEquals(a, b) {
    const bufA = Buffer.from(String(a || ''), 'utf8');
    const bufB = Buffer.from(String(b || ''), 'utf8');
    if (bufA.length !== bufB.length || bufA.length === 0) return false;
    return timingSafeEqual(bufA, bufB);
}

async function hashPassword(password) {
    const salt = randomBytes(16).toString('hex');
    const derived = await scryptAsync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
    return { passwordHash: derived.toString('hex'), passwordSalt: salt };
}

async function verifyPassword(password, passwordHash, passwordSalt) {
    if (!passwordHash || !passwordSalt) return false;
    let derived;
    try {
        derived = await scryptAsync(password, passwordSalt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
    } catch (e) {
        return false;
    }
    const stored = Buffer.from(passwordHash, 'hex');
    if (stored.length !== derived.length) return false;
    return timingSafeEqual(stored, derived);
}

/** Rejects the passwords that show up in every breach list without a dictionary. */
function passwordProblem(password) {
    const value = String(password || '');
    if (value.length < MIN_PASSWORD_LENGTH) {
        return `Parola en az ${MIN_PASSWORD_LENGTH} karakter olmalı.`;
    }
    if (value.length > 200) return 'Parola çok uzun.';
    if (/^(.)\1+$/.test(value)) return 'Parola tek bir karakterin tekrarı olamaz.';
    return null;
}

function normaliseEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function emailProblem(email) {
    const value = normaliseEmail(email);
    if (!value) return 'E-posta adresi gerekli.';
    if (value.length > 254) return 'E-posta adresi çok uzun.';
    // Deliberately permissive: the only authority on whether an address works
    // is delivery, and this relay does not send mail yet.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'E-posta adresi geçersiz görünüyor.';
    return null;
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

function parseCookies(req) {
    const header = req.headers.cookie || '';
    const out = {};
    header.split(';').forEach((part) => {
        const idx = part.indexOf('=');
        if (idx <= 0) return;
        const key = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        if (key) out[key] = decodeURIComponent(value);
    });
    return out;
}

/**
 * `Secure` is decided from the request rather than hardcoded: a cookie marked
 * Secure is simply dropped over plain http, which would make the panel
 * impossible to use on a local `npm start` while silently "working".
 */
function isSecureRequest(req) {
    if (req.secure) return true;
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    return proto === 'https';
}

function setSessionCookie(req, res, token) {
    const parts = [
        `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
        'HttpOnly',
        'SameSite=Lax',
        'Path=/',
        `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
    ];
    if (isSecureRequest(req)) parts.push('Secure');
    appendCookie(res, parts.join('; '));
}

function setCsrfCookie(req, res, token) {
    // Readable by the page on purpose: this is the double-submit half that the
    // form echoes back. It is not a credential on its own.
    const parts = [
        `${CSRF_COOKIE}=${encodeURIComponent(token)}`,
        'SameSite=Lax',
        'Path=/',
        `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
    ];
    if (isSecureRequest(req)) parts.push('Secure');
    appendCookie(res, parts.join('; '));
}

function clearAuthCookies(req, res) {
    const secure = isSecureRequest(req) ? '; Secure' : '';
    appendCookie(res, `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
    appendCookie(res, `${CSRF_COOKIE}=; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}

function appendCookie(res, value) {
    const existing = res.getHeader('Set-Cookie');
    if (!existing) res.setHeader('Set-Cookie', [value]);
    else if (Array.isArray(existing)) res.setHeader('Set-Cookie', existing.concat(value));
    else res.setHeader('Set-Cookie', [existing, value]);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function newSessionToken() {
    return randomBytes(32).toString('base64url');
}

function newCsrfToken() {
    return randomBytes(24).toString('base64url');
}

/**
 * Only the hash of the session token is stored, for the same reason the relay
 * only stores the hash of a client secret: a dump of the table must not be a
 * pile of working credentials.
 */
function sessionIdHash(token) {
    return sha256(token);
}

function sessionIsUsable(session) {
    if (!session) return false;
    if (session.revokedAt) return false;
    if (session.expiresAt <= Date.now()) return false;
    return true;
}

module.exports = {
    SESSION_COOKIE,
    CSRF_COOKIE,
    SESSION_TTL_MS,
    MIN_PASSWORD_LENGTH,
    sha256,
    safeEquals,
    hashPassword,
    verifyPassword,
    passwordProblem,
    emailProblem,
    normaliseEmail,
    parseCookies,
    isSecureRequest,
    setSessionCookie,
    setCsrfCookie,
    clearAuthCookies,
    newSessionToken,
    newCsrfToken,
    sessionIdHash,
    sessionIsUsable
};
