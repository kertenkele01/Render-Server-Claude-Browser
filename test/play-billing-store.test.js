'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openStore } = require('../lib/store');
const { accountIdentifier } = require('../lib/google-play');

test('Play aboneliği hesap sınırını aşmadan ve bildirimleri iki kez işlemeden kalıcı tutulur', async () => {
    const stateFile = path.join(os.tmpdir(), `bridge-play-billing-${process.pid}-${Date.now()}.json`);
    let store;
    try {
        store = await openStore({ stateFile, databaseUrl: '' });
        const first = await store.createAccount({
            email: 'play-first@test.com', passwordHash: 'hash', passwordSalt: 'salt'
        });
        const second = await store.createAccount({
            email: 'play-second@test.com', passwordHash: 'hash', passwordSalt: 'salt'
        });

        assert.equal(first.billingAccountId, accountIdentifier(first.id));
        assert.equal((await store.getAccountByBillingId(first.billingAccountId)).id, first.id);

        const subscription = {
            tokenHash: 'a'.repeat(64),
            purchaseToken: 'play-token-kept-server-side',
            accountId: first.id,
            productId: 'tabrove_pro',
            basePlanId: 'monthly',
            state: 'SUBSCRIPTION_STATE_ACTIVE',
            active: true,
            expiresAt: Date.now() + 30 * 86400000,
            willRenew: true,
            acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
            orderId: 'test-order',
            environment: 'sandbox',
            verifiedAt: Date.now()
        };
        assert.equal((await store.upsertPlaySubscription(subscription)).accountId, first.id);
        assert.equal((await store.getPlayEntitlement(first.id)).active, true);
        assert.equal(
            await store.upsertPlaySubscription({ ...subscription, accountId: second.id }),
            null,
            'aynı Play satın alımı ikinci bir hesaba taşınmamalı'
        );

        assert.equal(await store.recordPlayNotification('pubsub-message-1', Date.now()), true);
        assert.equal(await store.recordPlayNotification('pubsub-message-1', Date.now()), false);
        await store.close();

        store = await openStore({ stateFile, databaseUrl: '' });
        assert.equal((await store.getPlayEntitlement(first.id)).purchaseToken, subscription.purchaseToken);
        assert.equal(await store.hasPlayNotification('pubsub-message-1'), true);
    } finally {
        await store?.close();
        try { fs.unlinkSync(stateFile); } catch (_) { /* already absent */ }
    }
});
