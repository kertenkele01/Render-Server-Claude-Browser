'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { openStore } = require('../lib/store');
const panel = require('../lib/panel');

for (const driver of ['file', ...(process.env.TEST_DATABASE_URL ? ['postgres'] : [])]) {
    test(`${driver}: Pro registration is durable, account-scoped and idempotent across concurrent requests`, async () => {
        const stateFile = path.join(os.tmpdir(), `pro-preregistration-${randomUUID()}.json`);
        const options = { stateFile, databaseUrl: driver === 'postgres' ? process.env.TEST_DATABASE_URL : '' };
        let store;
        try {
            store = await openStore(options);
            const initialCount = await store.countProPreregistrations();
            const first = await store.createAccount({ email: `pro-first-${randomUUID()}@test.com`, passwordHash: 'private-hash', passwordSalt: 'private-salt' });
            const second = await store.createAccount({ email: `pro-second-${randomUUID()}@test.com`, passwordHash: 'hash', passwordSalt: 'salt' });
            assert.equal(await store.registerProInterest('missing-account'), null);
            const results = await Promise.all(Array.from({ length: 8 }, () => store.registerProInterest(first.id)));
            assert.ok(results[0].registeredAt > 0);
            assert.ok(results.every((r) => r.registeredAt === results[0].registeredAt && r.registered));
            assert.equal(await store.countProPreregistrations(), initialCount + 1);
            assert.equal((await store.getAccountById(first.id)).plan, 'free', 'Interest never grants a paid plan.');
            assert.equal(Number((await store.getAccountById(second.id)).proPreregisteredAt || 0), 0);
            await store.setAccountStatus(second.id, 'suspended');
            assert.equal(await store.registerProInterest(second.id), null);
            await store.setAccountStatus(second.id, 'active');
            await store.registerProInterest(second.id);
            const rows = await store.listProPreregistrations();
            const firstRow = rows.find((r) => r.accountId === first.id);
            assert.deepEqual(Object.keys(firstRow).sort(), ['accountId', 'email', 'registeredAt']);
            assert.equal(firstRow.email, first.email);
            const firstPage = await store.listProPreregistrations({ limit: 1, offset: 0 });
            const secondPage = await store.listProPreregistrations({ limit: 1, offset: 1 });
            assert.equal(firstPage.length, 1);
            assert.notEqual(firstPage[0].accountId, secondPage[0].accountId);
            await store.close();
            store = await openStore(options);
            assert.equal((await store.getAccountById(first.id)).proPreregisteredAt, results[0].registeredAt);
            assert.equal(await store.countProPreregistrations(), initialCount + 2);
            assert.deepEqual(await store.registerProInterest(first.id), results[0]);
        } finally {
            await store?.close();
            if (driver === 'file') fs.rmSync(stateFile, { force: true });
        }
    });
}

test('operator registration page escapes emails and provides count, dates and pagination', () => {
    const html = panel.renderProPreregistrations({ account: { email: 'admin@test.com' }, total: 201,
        registrations: [{ accountId: 'account', email: '<script>alert(1)</script>@test.com', registeredAt: Date.now() }],
        page: 2, pages: 3 });
    assert.ok(html.includes('201'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(!html.includes('<script>alert'));
    assert.ok(html.includes('?page=1') && html.includes('?page=3'));
    assert.ok(html.includes('Ön kayıt tarihi'));
    assert.ok(!html.includes('undefined'));
});
