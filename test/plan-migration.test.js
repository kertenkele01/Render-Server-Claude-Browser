'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { openStore, SCHEMA } = require('../lib/store');
const { migrateLegacyPolicy, resolvePaidPlan } = require('../lib/plan-catalog');
const limits = require('../lib/limits');

test('legacy customized Pro ceilings migrate to Plus without reducing either paid tier', () => {
    const legacy = { free: { maxDevices: 1, maxClients: 8, commandsPerDay: 5000 },
        pro: { maxDevices: 30, maxClients: 300, commandsPerDay: 800000 },
        features: { registration: true, guestEntry: false, cloudBackupUploads: true } };
    const migrated = migrateLegacyPolicy(legacy);
    assert.deepEqual(migrated.plus, legacy.pro);
    assert.deepEqual(migrated.pro, { maxDevices: 30, maxClients: 300, commandsPerDay: 1000000 });
    assert.deepEqual(limits.validatePolicy(migrated), migrated);
    assert.deepEqual(migrateLegacyPolicy(migrated), migrated);
});

test('stored legacy accounts become Plus once; newly assigned Pro survives reopening', async () => {
    const stateFile = path.join(os.tmpdir(), `plan-migration-${randomUUID()}.json`);
    let store;
    try {
        store = await openStore({ stateFile, databaseUrl: '' });
        const account = await store.createAccount({ email: 'legacy-plan@test.com', passwordHash: 'hash', passwordSalt: 'salt' });
        await store.setAccountPlan(account.id, 'pro');
        await store.setProductPolicy(limits.policySnapshot(), 0, account.id);
        await store.close();
        const old = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        old.version = 11;
        old.productPolicy.policy.pro = { maxDevices: 5, maxClients: 60, commandsPerDay: 150000 };
        delete old.productPolicy.policy.plus;
        const identity = structuredClone(old.accounts[account.id]);
        fs.writeFileSync(stateFile, JSON.stringify(old));
        store = await openStore({ stateFile, databaseUrl: '' });
        assert.deepEqual(await store.getAccountById(account.id), { ...identity, plan: 'plus' });
        assert.deepEqual((await store.getProductPolicy()).policy.plus, old.productPolicy.policy.pro);
        assert.equal((await store.getProductPolicy()).revision, 2);
        await store.setAccountPlan(account.id, 'pro');
        await store.close();
        store = await openStore({ stateFile, databaseUrl: '' });
        assert.equal((await store.getAccountById(account.id)).plan, 'pro');
        assert.equal((await store.getProductPolicy()).revision, 2);
        assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).version, 12);
    } finally {
        await store?.close();
        fs.rmSync(stateFile, { force: true });
    }
});

test('existing Play entitlement grants Plus, never the upper Pro; operator Pro remains independent', () => {
    const active = { active: true, expiresAt: 2000, productId: 'tabrove_pro' };
    assert.deepEqual(resolvePaidPlan({ plan: 'free' }, active, 1000),
        { plan: 'plus', planSource: 'google_play', planValidUntil: 2000 });
    assert.equal(resolvePaidPlan({ plan: 'free' }, active, 2000).plan, 'free');
    assert.equal(resolvePaidPlan({ plan: 'plus' }, active, 3000).plan, 'plus');
    assert.deepEqual(resolvePaidPlan({ plan: 'pro' }, active, 3000),
        { plan: 'pro', planSource: 'operator', planValidUntil: null });
});

test('PostgreSQL migration has a durable atomic marker and preserves customized lower-tier ceilings', () => {
    assert.match(SCHEMA, /CREATE TABLE IF NOT EXISTS store_migrations/);
    assert.match(SCHEMA, /three_tier_plans_v2/);
    assert.match(SCHEMA, /ON CONFLICT DO NOTHING;\s+IF NOT FOUND THEN RETURN/);
    assert.match(SCHEMA, /UPDATE accounts SET plan = 'plus' WHERE plan = 'pro'/);
    assert.match(SCHEMA, /'plus', policy->'pro'/);
    assert.match(SCHEMA, /GREATEST\(20,/);
});
