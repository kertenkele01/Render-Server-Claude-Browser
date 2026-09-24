'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openStore, SCHEMA } = require('../lib/store');
const limits = require('../lib/limits');

test('plan ayarları sıkı doğrulanır ve Pro Free altında olamaz', () => {
    const valid = limits.policySnapshot();
    assert.deepEqual(limits.validatePolicy(valid), valid);
    assert.equal(limits.validatePolicy({ ...valid, free: { ...valid.free, maxDevices: 0 } }), null);
    assert.equal(limits.validatePolicy({ ...valid, free: { ...valid.free, maxDevices: 101 } }), null);
    assert.equal(limits.validatePolicy({ ...valid, pro: { ...valid.pro, maxClients: 1 } }), null);
    assert.equal(limits.validatePolicy({ ...valid, features: { ...valid.features, guestEntry: 'false' } }), null);
    assert.equal(limits.validatePolicy({ ...valid, free: { ...valid.free, auditRetentionDays: 1 } }), null);
});

test('dosya deposu plan ayarlarını sürüm kontrolüyle kalıcı tutar', async (t) => {
    const stateFile = path.join(os.tmpdir(), `product-policy-${process.pid}-${Date.now()}.json`);
    t.after(() => { try { fs.unlinkSync(stateFile); } catch (_) {} });
    const first = await openStore({ stateFile, databaseUrl: '' });
    const policy = limits.policySnapshot();
    policy.free.commandsPerDay = 4321;
    policy.features.guestEntry = false;
    assert.equal(await first.getProductPolicy(), null);
    assert.equal((await first.setProductPolicy(policy, 0, 'operator-id')).revision, 1);
    assert.equal(await first.setProductPolicy(limits.policySnapshot(), 0, 'operator-id'), null);
    await first.close();
    const reopened = await openStore({ stateFile, databaseUrl: '' });
    assert.deepEqual((await reopened.getProductPolicy()).policy, policy);
    assert.equal((await reopened.setProductPolicy(limits.policySnapshot(), 1, 'operator-id')).revision, 2);
    await reopened.close();
});

test('PostgreSQL şemasında plan ayarları tablosu kalıcıdır', () => {
    assert.match(SCHEMA, /CREATE TABLE IF NOT EXISTS product_policy/);
    assert.match(SCHEMA, /policy jsonb NOT NULL/);
});
