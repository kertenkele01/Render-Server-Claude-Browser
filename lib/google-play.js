'use strict';

/**
 * Minimal Google Play Developer API client.
 *
 * Billing credentials never belong in the Android application. The relay uses
 * a narrowly-permissioned service account to verify purchase tokens and to
 * acknowledge initial subscription purchases. No purchase token is logged.
 */

const fs = require('fs');
const { createHash, createPublicKey, sign, verify } = require('crypto');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_ROOT = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ACTIVE_STATES = new Set([
    'SUBSCRIPTION_STATE_ACTIVE',
    'SUBSCRIPTION_STATE_CANCELED',
    'SUBSCRIPTION_STATE_IN_GRACE_PERIOD'
]);

function base64url(value) {
    return Buffer.from(value).toString('base64url');
}

function sha256(value) {
    return createHash('sha256').update(String(value)).digest('hex');
}

function accountIdentifier(accountId) {
    return sha256(`play-account:${accountId}`);
}

function readCredentials() {
    const inline = String(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || '').trim();
    const filename = String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
    try {
        if (inline) return JSON.parse(inline);
        if (filename) return JSON.parse(fs.readFileSync(filename, 'utf8'));
    } catch (e) {
        throw new Error(`Google Play service account could not be read: ${e.message}`);
    }
    return null;
}

function createGooglePlayClient() {
    const credentials = readCredentials();
    const packageName = String(process.env.GOOGLE_PLAY_PACKAGE_NAME || 'com.kertenkele.tabrove').trim();
    const productId = String(process.env.GOOGLE_PLAY_SUBSCRIPTION_ID || 'tabrove_pro').trim();
    const rtdnAudience = String(process.env.GOOGLE_PLAY_RTDN_AUDIENCE || '').trim();
    const rtdnServiceAccount = String(process.env.GOOGLE_PLAY_RTDN_PUSH_SERVICE_ACCOUNT || '').trim().toLowerCase();
    const configured = !!(credentials?.client_email && credentials?.private_key && packageName && productId);

    let accessToken = null;
    let accessTokenExpiresAt = 0;
    let jwks = new Map();
    let jwksExpiresAt = 0;

    async function getAccessToken() {
        if (!configured) throw new Error('google_play_not_configured');
        if (accessToken && accessTokenExpiresAt > Date.now() + 60_000) return accessToken;

        const now = Math.floor(Date.now() / 1000);
        const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
        const claims = base64url(JSON.stringify({
            iss: credentials.client_email,
            scope: 'https://www.googleapis.com/auth/androidpublisher',
            aud: TOKEN_URL,
            iat: now,
            exp: now + 3600
        }));
        const unsigned = `${header}.${claims}`;
        const signature = sign('RSA-SHA256', Buffer.from(unsigned), credentials.private_key).toString('base64url');
        const response = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                assertion: `${unsigned}.${signature}`
            })
        });
        const json = await response.json().catch(() => ({}));
        if (!response.ok || !json.access_token) {
            throw new Error(`google_oauth_failed:${response.status}:${json.error || 'unknown'}`);
        }
        accessToken = json.access_token;
        accessTokenExpiresAt = Date.now() + Math.max(60, Number(json.expires_in) || 3600) * 1000;
        return accessToken;
    }

    async function api(pathname, options = {}) {
        const token = await getAccessToken();
        const response = await fetch(`${API_ROOT}/${encodeURIComponent(packageName)}${pathname}`, {
            ...options,
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                ...(options.headers || {})
            }
        });
        if (response.status === 204) return {};
        const json = await response.json().catch(() => ({}));
        if (!response.ok) {
            const reason = json?.error?.message || json?.error || 'unknown';
            throw new Error(`google_play_api_failed:${response.status}:${reason}`);
        }
        return json;
    }

    function normaliseSubscription(purchaseToken, purchase) {
        const lineItems = Array.isArray(purchase.lineItems) ? purchase.lineItems : [];
        const lineItem = lineItems.find((item) => item.productId === productId);
        if (!lineItem) throw new Error('google_play_product_mismatch');
        const expiresAt = Date.parse(lineItem.expiryTime || '') || 0;
        const state = String(purchase.subscriptionState || 'SUBSCRIPTION_STATE_UNSPECIFIED');
        const active = ACTIVE_STATES.has(state) && expiresAt > Date.now();
        return {
            tokenHash: sha256(purchaseToken),
            purchaseToken,
            productId: lineItem.productId,
            basePlanId: lineItem.offerDetails?.basePlanId || '',
            state,
            active,
            expiresAt,
            willRenew: lineItem.autoRenewingPlan?.autoRenewEnabled === true,
            acknowledgementState: String(purchase.acknowledgementState || ''),
            orderId: String(purchase.latestOrderId || ''),
            environment: purchase.testPurchase ? 'sandbox' : 'production',
            obfuscatedAccountId: String(purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId || ''),
            verifiedAt: Date.now()
        };
    }

    async function verifySubscription(purchaseToken) {
        if (!/^[A-Za-z0-9._-]{10,4096}$/.test(String(purchaseToken || ''))) {
            throw new Error('invalid_purchase_token');
        }
        const purchase = await api(`/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`);
        return normaliseSubscription(purchaseToken, purchase);
    }

    async function acknowledgeSubscription(subscription) {
        if (subscription.acknowledgementState !== 'ACKNOWLEDGEMENT_STATE_PENDING') return false;
        await api(`/purchases/subscriptions/${encodeURIComponent(subscription.productId)}/tokens/${encodeURIComponent(subscription.purchaseToken)}:acknowledge`, {
            method: 'POST',
            body: JSON.stringify({})
        });
        return true;
    }

    async function refreshJwks() {
        if (jwks.size && jwksExpiresAt > Date.now()) return;
        const response = await fetch(GOOGLE_JWKS_URL);
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !Array.isArray(body.keys)) throw new Error('google_jwks_unavailable');
        jwks = new Map(body.keys.filter((key) => key.kid).map((key) => [key.kid, key]));
        const maxAge = /max-age=(\d+)/i.exec(String(response.headers.get('cache-control') || ''));
        jwksExpiresAt = Date.now() + Math.max(300, Number(maxAge?.[1]) || 3600) * 1000;
    }

    async function verifyRtdnAuthorization(headerValue) {
        if (!rtdnAudience || !rtdnServiceAccount) throw new Error('google_play_rtdn_not_configured');
        const raw = String(headerValue || '');
        const jwt = raw.toLowerCase().startsWith('bearer ') ? raw.substring(7).trim() : '';
        const parts = jwt.split('.');
        if (parts.length !== 3) throw new Error('invalid_rtdn_token');
        let header;
        let payload;
        try {
            header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
            payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        } catch (_) {
            throw new Error('invalid_rtdn_token');
        }
        await refreshJwks();
        const key = jwks.get(header.kid);
        if (!key || header.alg !== 'RS256') throw new Error('invalid_rtdn_key');
        const signatureOk = verify(
            'RSA-SHA256',
            Buffer.from(`${parts[0]}.${parts[1]}`),
            createPublicKey({ key, format: 'jwk' }),
            Buffer.from(parts[2], 'base64url')
        );
        const now = Math.floor(Date.now() / 1000);
        const issuerOk = payload.iss === 'https://accounts.google.com' || payload.iss === 'accounts.google.com';
        const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
        if (!signatureOk || !issuerOk || !audience.includes(rtdnAudience) || Number(payload.exp || 0) <= now ||
            Number(payload.iat || 0) > now + 300 || payload.email_verified !== true ||
            String(payload.email || '').toLowerCase() !== rtdnServiceAccount) {
            throw new Error('invalid_rtdn_claims');
        }
        return payload;
    }

    return {
        configured,
        packageName,
        productId,
        rtdnConfigured: !!(configured && rtdnAudience && rtdnServiceAccount),
        accountIdentifier,
        verifySubscription,
        acknowledgeSubscription,
        verifyRtdnAuthorization
    };
}

module.exports = { createGooglePlayClient, accountIdentifier };
