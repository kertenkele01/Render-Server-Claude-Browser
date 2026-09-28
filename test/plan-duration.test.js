'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { openStore } = require('../lib/store');
const { planExpiry, resolvePaidPlan } = require('../lib/plan-catalog');
const { planFor, PLANS } = require('../lib/limits');

test('operator periods count days, calendar months and years, clamping month ends', () => {
    const now = Date.parse('2028-01-31T12:34:56.789Z');
    assert.equal(planExpiry('day', '7', now), now + 7 * 86400000);
    assert.equal(new Date(planExpiry('month', '1', now)).toISOString(), '2028-02-29T12:34:56.789Z');
    assert.equal(new Date(planExpiry('month', '3', now)).toISOString(), '2028-04-30T12:34:56.789Z');
    assert.equal(new Date(planExpiry('year', '1', Date.parse('2028-02-29T12:00:00Z'))).toISOString(),
        '2029-02-28T12:00:00.000Z');
    assert.equal(planExpiry('unlimited', 'invalid', now), null);
    for (const count of ['0', '-1', '1.5', '1abc', '', undefined, '9999999999999999999']) {
        assert.throws(() => planExpiry('day', count, now));
    }
    assert.throws(() => planExpiry('week', '1', now));
    assert.throws(() => planExpiry('year', '101', now));
});

test('manual access stops at the exact deadline, preserving an unexpired Play Plus subscription', () => {
    const manual = { plan: 'pro', planExpiresAt: 2000 };
    const play = { active: true, expiresAt: 3000 };
    assert.deepEqual(resolvePaidPlan(manual, play, 1999),
        { plan: 'pro', planSource: 'operator', planValidUntil: 2000 });
    assert.deepEqual(resolvePaidPlan(manual, play, 2000),
        { plan: 'plus', planSource: 'google_play', planValidUntil: 3000 });
    assert.equal(resolvePaidPlan(manual, play, 3000).plan, 'free');
    assert.equal(resolvePaidPlan(manual, null, 2000).plan, 'free');
    assert.equal(resolvePaidPlan({ plan: 'plus' }, null, 100000).plan, 'plus');
    assert.equal(resolvePaidPlan({ plan: 'pro', planExpiresAt: null }, null, 100000).plan, 'pro');

    const now = Date.now();
    const cached = { plan: 'pro', planValidUntil: now - 1,
        billing: { active: true, expiresAt: now + 60000 } };
    assert.equal(planFor(cached), PLANS.plus, 'stale registry must use the remaining purchased plan');
    assert.equal(planFor({ ...cached, billing: { active: true, expiresAt: now - 1 } }), PLANS.free);
    assert.equal(planFor({ ...cached, billing: null }), PLANS.free);
    assert.equal(planFor({ ...cached, planValidUntil: null }), PLANS.pro);
});

for (const driver of ['file', ...(process.env.TEST_DATABASE_URL ? ['postgres'] : [])]) {
    test(`${driver}: timed assignments survive reopening; renewal and unlimited assignments replace the deadline`, async () => {
        const stateFile = path.join(os.tmpdir(), `plan-duration-${randomUUID()}.json`);
        const options = { stateFile, databaseUrl: driver === 'postgres' ? process.env.TEST_DATABASE_URL : '' };
        let store;
        try {
            store = await openStore(options);
            const account = await store.createAccount({ email: `timed-${randomUUID()}@test.com`,
                passwordHash: 'hash', passwordSalt: 'salt' });
            const deadline = planExpiry('month', 3);
            await store.setAccountPlan(account.id, 'pro', deadline);
            await store.close();
            store = await openStore(options);
            const restored = await store.getAccountById(account.id);
            assert.equal(restored.plan, 'pro');
            assert.equal(restored.planExpiresAt, deadline);
            assert.equal((await store.listAccounts({ query: account.email }))[0].planExpiresAt, deadline);
            await store.setAccountPlan(account.id, 'pro', Date.now() - 1000);
            assert.equal(resolvePaidPlan(await store.getAccountById(account.id), null).plan, 'free');
            const revision = (await store.getAccountById(account.id)).freeSelectionRevision;
            await store.setAccountPlan(account.id, 'plus', deadline);
            assert.equal((await store.getAccountById(account.id)).freeSelectionRevision, revision + 1);
            await store.setAccountPlan(account.id, 'plus');
            assert.equal((await store.getAccountById(account.id)).planExpiresAt, null);
            await assert.rejects(store.setAccountPlan(account.id, 'pro', NaN));
            await assert.rejects(store.setAccountPlan(account.id, 'other'));
            assert.equal((await store.getAccountById(account.id)).plan, 'plus');
        } finally {
            await store?.close();
            if (driver === 'file') fs.rmSync(stateFile, { force: true });
        }
    });
}
