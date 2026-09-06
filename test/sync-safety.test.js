'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { openStore } = require('../lib/store');

for (const databaseUrl of ['', ...(process.env.TEST_DATABASE_URL ? [process.env.TEST_DATABASE_URL] : [])]) {
    test(`${databaseUrl ? 'PostgreSQL' : 'file'}: password envelopes and explicit backup deletion are atomic`, async () => {
        const suffix = randomUUID();
        const stateFile = path.join(os.tmpdir(), `sync-safety-${suffix}.json`);
        const store = await openStore({ stateFile, databaseUrl });
        try {
            const a = await store.createAccount({ email: `${suffix}@test.invalid`, passwordHash: 'old-hash', passwordSalt: 'salt' });
            const other = await store.createAccount({ email: `other-${suffix}@test.invalid`, passwordHash: 'other-hash', passwordSalt: 'salt' });
            const main = `main-${suffix}`, backup = `backup-${suffix}`, id = `client-${suffix}`;
            for (const deviceId of [main, backup]) {
                await store.upsertDevice({ id: deviceId, secretHash: deviceId, name: 'Test' });
                await store.setDeviceAccount(deviceId, a.id);
                await store.setDeviceSyncEnabled(deviceId, a.id, true);
                await store.setDeviceCookieSyncEnabledGlobal(deviceId, a.id, true);
                await store.upsertClient({ id, deviceId, secretHash: 'client-hash', name: 'Test client' });
                await store.setDeviceCookieSyncEnabled(id, deviceId, a.id, true);
            }
            await store.setClientCookieSyncEnabled(id, a.id, true);
            let chosen = await store.setAccountDefaultDevice(a.id, main);
            await store.markMainReady(a.id, main, chosen.mainGeneration);
            await store.publishDeviceClients(a.id, main);
            const snapshot = { clientId: id, accountId: a.id, sourceDeviceId: main, version: 2,
                iv: Buffer.alloc(12).toString('base64'), ciphertext: Buffer.alloc(48, 5).toString('base64'), updatedAt: 100 };
            await store.writeMainCookieSnapshot(snapshot, chosen.mainGeneration);
            const previousGeneration = chosen.mainGeneration;
            await Promise.all([
                store.setAccountDefaultDevice(a.id, backup),
                store.writeMainCookieSnapshot({ ...snapshot, updatedAt: 101 }, previousGeneration)
            ]);
            assert.equal((await store.getAccountById(a.id)).defaultDeviceId, backup);
            assert.equal(await store.writeMainCookieSnapshot(snapshot, previousGeneration), null);
            chosen = await store.setAccountDefaultDevice(a.id, main);
            await store.markMainReady(a.id, main, chosen.mainGeneration);
            await store.writeMainCookieSnapshot(snapshot, chosen.mainGeneration);
            assert.equal(await store.changePasswordWithCookieKey(a.id, 'old-hash', 'new', 'salt', null, 0), false);
            assert.equal((await store.getAccountById(a.id)).passwordHash, 'old-hash');
            const envelope = { version: 1, iv: snapshot.iv, ciphertext: snapshot.ciphertext };
            const changes = await Promise.all([
                store.changePasswordWithCookieKey(a.id, 'old-hash', 'new-one', 'salt', envelope, 0),
                store.changePasswordWithCookieKey(a.id, 'old-hash', 'new-two', 'salt', envelope, 0)
            ]);
            assert.equal(changes.filter(Boolean).length, 1, 'two concurrent password changes won');
            assert.deepEqual((await store.getAccountById(a.id)).cookieKeyEnvelope, envelope);
            assert.equal((await store.getCookieSnapshot(a.id, id)).ciphertext, snapshot.ciphertext);
            assert.equal(await store.writeMainCookieSnapshot(snapshot, chosen.mainGeneration), null, 'old app overwrote rewrapped account data');
            assert.ok(await store.writeMainCookieSnapshot({ ...snapshot, cookieKeyRevision: 1 }, chosen.mainGeneration));
            assert.equal(await store.deleteCookieBackups(other.id, [{ clientId: id, updatedAt: 100 }]), false);
            assert.equal(await store.deleteCookieBackups(a.id, [{ clientId: id, updatedAt: 99 }]), false);
            await store.setDeviceSyncEnabled(main, a.id, false);
            await store.setDeviceSyncEnabled(backup, a.id, false);
            assert.equal(await store.deleteCookieBackups(a.id, [{ clientId: id, updatedAt: 100 }]), true);
            assert.equal((await store.getCookieSnapshot(a.id, id)) ?? null, null);
            assert.equal((await store.getClient(id)).deviceIds.length, 2, 'backup deletion removed routing');
            assert.equal((await store.getClient(id)).cookieSyncEnabled, false);
            await store.setDeviceSyncEnabled(main, a.id, true);
            assert.equal(await store.writeMainCookieSnapshot(snapshot, chosen.mainGeneration), null, 'old in-flight upload recreated backup');
        } finally { await store.close(); fs.rmSync(stateFile, { force: true }); }
    });
}
