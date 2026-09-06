'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { openStore } = require('../lib/store');

for (const databaseUrl of ['', ...(process.env.TEST_DATABASE_URL ? [process.env.TEST_DATABASE_URL] : [])]) {
    test(`${databaseUrl ? 'PostgreSQL' : 'file'}: shared credentials keep identity, binding and password boundaries`, async () => {
        const suffix = randomUUID();
        const stateFile = path.join(os.tmpdir(), `credential-sharing-${suffix}.json`);
        let store = await openStore({ stateFile, databaseUrl });
        try {
            const a = await store.createAccount({ email: `${suffix}@test.invalid`, passwordHash: 'old', passwordSalt: 'salt' });
            const other = await store.createAccount({ email: `other-${suffix}@test.invalid`, passwordHash: 'other', passwordSalt: 'salt' });
            const origin = `origin-${suffix}`, backup = `backup-${suffix}`, stranger = `stranger-${suffix}`, id = `client-${suffix}`;
            for (const deviceId of [origin, backup, stranger]) {
                await store.upsertDevice({ id: deviceId, secretHash: 'device-hash', name: 'Test' });
                await store.setDeviceAccount(deviceId, deviceId === stranger ? other.id : a.id);
            }
            await store.upsertClient({ id, deviceId: origin, secretHash: 'a'.repeat(64), name: 'Existing AI' });
            const pkg = { clientId: id, accountId: a.id, sourceDeviceId: origin, secretHash: 'a'.repeat(64),
                version: 1, iv: Buffer.alloc(12).toString('base64'), ciphertext: Buffer.alloc(48, 7).toString('base64'),
                cookieKeyRevision: 0, updatedAt: 100 };
            assert.equal(await store.writeCredentialPackage(pkg), null, 'sync off allowed automatic publication');
            await store.setDeviceSyncEnabled(origin, a.id, true);
            assert.ok(await store.writeCredentialPackage(pkg), 'cookie sync or main selection was incorrectly required');
            assert.deepEqual(await store.listCredentialPackages(a.id, backup), [], 'unbound device obtained package');
            await store.upsertClient({ id, deviceId: backup, secretHash: pkg.secretHash, name: 'Existing AI' });
            assert.deepEqual(await store.listCredentialPackages(a.id, backup), [pkg]);
            assert.deepEqual(await store.listCredentialPackages(other.id, stranger), []);
            assert.deepEqual(await store.listCredentialPackages(a.id, stranger), []);
            assert.equal(await store.writeCredentialPackage({ ...pkg, sourceDeviceId: backup }), null);
            assert.equal(await store.writeCredentialPackage({ ...pkg, secretHash: 'b'.repeat(64) }), null);
            assert.equal((await store.getClient(id)).deviceId, origin);
            assert.equal((await store.getClient(id)).cloudPublished, false, 'credential sharing changed restore inventory');
            assert.equal(!!(await store.getClient(id)).cookieSyncEnabled, false);
            // Even with no cookie backups, a legacy password change must not strand the key.
            assert.equal(await store.changePasswordWithCookieKey(a.id, 'old', 'new', 'salt', null, 0), false);
            const envelope = { version: 1, iv: pkg.iv, ciphertext: pkg.ciphertext };
            assert.equal(await store.changePasswordWithCookieKey(a.id, 'old', 'new', 'salt', envelope, 0), true);
            assert.deepEqual(await store.listCredentialPackages(a.id, backup), [pkg]);
            assert.equal(await store.writeCredentialPackage(pkg), null, 'stale key revision wrote a package');
            assert.ok(await store.writeCredentialPackage({ ...pkg, cookieKeyRevision: 1 }));
            if (!databaseUrl) {
                await store.close();
                store = await openStore({ stateFile, databaseUrl });
                assert.equal((await store.listCredentialPackages(a.id, backup))[0].ciphertext, pkg.ciphertext);
            }
            // A rotation and an old upload cannot leave a usable obsolete package.
            await Promise.all([
                store.upsertClient({ id, deviceId: origin, secretHash: 'b'.repeat(64), name: 'Existing AI' }),
                store.writeCredentialPackage({ ...pkg, cookieKeyRevision: 1 })
            ]);
            assert.deepEqual(await store.listCredentialPackages(a.id, backup), []);
            assert.equal(await store.writeCredentialPackage({ ...pkg, cookieKeyRevision: 1 }), null);
            const next = { ...pkg, secretHash: 'b'.repeat(64), cookieKeyRevision: 1 };
            assert.ok(await store.writeCredentialPackage(next));
            await store.setDeviceAccount(backup, null);
            assert.deepEqual(await store.listCredentialPackages(a.id, backup), [], 'signed-out device retained access');
            await store.setDeviceSyncEnabled(origin, a.id, false);
            assert.equal(await store.writeCredentialPackage(next), null);
            await store.deleteClient(id);
            assert.deepEqual(await store.listCredentialPackages(a.id, origin), []);
        } finally { await store.close(); fs.rmSync(stateFile, { force: true }); }
    });
}
