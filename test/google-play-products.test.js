'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { createGooglePlayClient } = require('../lib/google-play');

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const credentials = JSON.stringify({
    client_email: 'billing-test@example.test',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' })
});

async function withPlayPurchase(purchase, action, configuredProduct) {
    const previousFetch = global.fetch;
    const environment = new Map(['GOOGLE_PLAY_SERVICE_ACCOUNT_JSON', 'GOOGLE_PLAY_SUBSCRIPTION_ID',
        'GOOGLE_PLAY_PLUS_SUBSCRIPTION_ID', 'GOOGLE_PLAY_PRO_SUBSCRIPTION_ID']
        .map((key) => [key, process.env[key]]));
    process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON = credentials;
    delete process.env.GOOGLE_PLAY_PLUS_SUBSCRIPTION_ID;
    delete process.env.GOOGLE_PLAY_PRO_SUBSCRIPTION_ID;
    if (configuredProduct) process.env.GOOGLE_PLAY_SUBSCRIPTION_ID = configuredProduct;
    else delete process.env.GOOGLE_PLAY_SUBSCRIPTION_ID;
    const requests = [];
    global.fetch = async (url) => {
        requests.push(url);
        if (url === 'https://oauth2.googleapis.com/token') {
            return { ok: true, json: async () => ({ access_token: 'test-access-token', expires_in: 3600 }) };
        }
        assert.match(url, /\/purchases\/subscriptionsv2\/tokens\/test-purchase-token$/);
        return { ok: true, json: async () => purchase };
    };
    try {
        await action(createGooglePlayClient(), requests);
    } finally {
        global.fetch = previousFetch;
        for (const [key, value] of environment) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

function subscription(productId, basePlanId) {
    return {
        subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
        acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
        lineItems: [{ productId, expiryTime: new Date(Date.now() + 86400000).toISOString(),
            offerDetails: { basePlanId }, autoRenewingPlan: { autoRenewEnabled: true } }]
    };
}

test('Plus monthly and yearly purchases are verified using Google product and base-plan identities', async () => {
    for (const basePlanId of ['monthly', 'yearly']) {
        await withPlayPurchase(subscription('tabrove_plus', basePlanId), async (client) => {
            assert.equal(client.productId, 'tabrove_plus');
            assert.equal(client.configured, true);
            const verified = await client.verifySubscription('test-purchase-token');
            assert.equal(verified.productId, 'tabrove_plus');
            assert.equal(verified.basePlanId, basePlanId);
            assert.equal(verified.active, true);
        });
    }
});

test('a Google-confirmed Pro purchase cannot grant Plus while Pro is coming soon', async () => {
    await withPlayPurchase(subscription('tabrove_pro', 'monthly'), async (client) => {
        await assert.rejects(client.verifySubscription('test-purchase-token'), /google_play_product_mismatch/);
    });
});

test('unknown or missing Plus base plans cannot grant paid access', async () => {
    for (const basePlanId of ['weekly', undefined]) {
        await withPlayPurchase(subscription('tabrove_plus', basePlanId), async (client) => {
            await assert.rejects(client.verifySubscription('test-purchase-token'), /google_play_base_plan_mismatch/);
        });
    }
});

test('legacy shared Pro setting does not disable Plus or enable Pro purchases', async () => {
    await withPlayPurchase(subscription('tabrove_plus', 'monthly'), async (client) => {
        assert.equal(client.configured, true);
        assert.equal(client.productId, 'tabrove_plus');
        assert.equal((await client.verifySubscription('test-purchase-token')).active, true);
        assert.deepEqual(client.products.plus, {
            name: 'Tabrove Plus', productId: 'tabrove_plus', basePlanIds: ['monthly', 'yearly'], purchasable: true
        });
        assert.deepEqual(client.products.pro, {
            name: 'Tabrove Pro', productId: 'tabrove_pro', basePlanIds: [], purchasable: false, comingSoon: true
        });
    }, 'tabrove_pro');
    await withPlayPurchase(subscription('tabrove_pro', 'monthly'), async (client) => {
        await assert.rejects(client.verifySubscription('test-purchase-token'), /google_play_product_mismatch/);
    }, 'tabrove_pro');
});
