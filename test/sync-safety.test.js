'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { openStore, recoveryCodeVerifier } = require('../lib/store');

for (const databaseUrl of ['', ...(process.env.TEST_DATABASE_URL ? [process.env.TEST_DATABASE_URL] : [])]) {
    test(`${databaseUrl ? 'PostgreSQL' : 'file'}: account-bound recovery code is single-use and preserves encrypted data`, async () => {
        const suffix = randomUUID();
        const stateFile = path.join(os.tmpdir(), `recovery-safety-${suffix}.json`);
        const store = await openStore({ stateFile, databaseUrl });
        try {
            const account = await store.createAccount({ email: `recovery-${suffix}@test.invalid`,
                passwordHash: 'old', passwordSalt: 'salt' });
            const envelope = { version: 2, strong: { iv: 'aaaaaaaaaaaaaaaa', ciphertext: 'a'.repeat(64) },
                legacy: { version: 1, iv: 'bbbbbbbbbbbbbbbb', ciphertext: 'b'.repeat(64) } };
            const recoveryEnvelope = { iv: 'aaaaaaaaaaaaaaaa', ciphertext: 'c'.repeat(64) };
            assert.equal(await store.setAccountRecoveryKit(account.id, 'wrong', 0, 'kit', 'code', recoveryEnvelope), false);
            assert.equal(await store.setAccountRecoveryKit(account.id, 'old', 0, 'kit', 'code', recoveryEnvelope), true);
            const savedKit = await store.getAccountById(account.id);
            assert.deepEqual(savedKit.recoveryEnvelope, recoveryEnvelope);
            assert.equal(savedKit.recoveryCodeHash, recoveryCodeVerifier('code'));
            assert.notEqual(savedKit.recoveryCodeHash, 'code', 'veritabanındaki değer doğrudan kurtarma kanıtı olmamalı');
            assert.equal(await store.changePasswordWithCookieKey(account.id, 'old', 'operator-reset', 'salt', null, 0), false,
                'yönetici etkin kodu ve veri anahtarını atlayarak parola sıfırlayamamalı');
            assert.equal(await store.consumeAccountRecoveryKit(account.id, 'kit', savedKit.recoveryCodeHash, 0,
                'new', 'salt', envelope), false, 'veritabanındaki doğrulayıcı kanıt olarak kabul edilmemeli');
            assert.equal(await store.consumeAccountRecoveryKit(account.id, 'kit', 'wrong', 0,
                'new', 'salt', envelope), false);
            assert.equal((await store.getAccountById(account.id)).passwordHash, 'old');
            assert.equal(await store.setAccountRecoveryKit(account.id, 'old', 0, 'next-kit', 'next-code', recoveryEnvelope), true);
            assert.equal(await store.consumeAccountRecoveryKit(account.id, 'kit', 'code', 0,
                'new', 'salt', envelope), false, 'yenilenen eski kod artık kullanılamamalı');
            assert.equal(await store.consumeAccountRecoveryKit(account.id, 'next-kit', 'next-code', 0,
                'new', 'salt', envelope), true);
            assert.equal(await store.consumeAccountRecoveryKit(account.id, 'next-kit', 'next-code', 0,
                'another', 'salt', envelope), false);
            const recovered = await store.getAccountById(account.id);
            assert.equal(recovered.passwordHash, 'new');
            assert.equal(recovered.cookieKeyRevision, 1);
            assert.deepEqual(recovered.cookieKeyEnvelope, envelope);
            assert.equal(recovered.recoveryCodeHash, null);
            assert.equal(recovered.recoveryEnvelope, null);
        } finally { await store.close(); fs.rmSync(stateFile, { force: true }); }
    });

    if (!databaseUrl) test('file: existing recovery codes migrate without becoming replayable', async () => {
        const stateFile = path.join(os.tmpdir(), `recovery-migration-${randomUUID()}.json`);
        const id = randomUUID();
        const proof = createHash('sha256').update('legacy-recovery-proof').digest('hex');
        const legacy = { id, email: 'legacy-recovery@test.invalid', passwordHash: 'old', passwordSalt: 'salt',
            status: 'active', recoveryKitId: 'kit', recoveryCodeHash: proof,
            recoveryEnvelope: { iv: 'aaaaaaaaaaaaaaaa', ciphertext: 'c'.repeat(64) } };
        fs.writeFileSync(stateFile, JSON.stringify({ version: 11, accounts: { [id]: legacy } }));
        let store = await openStore({ stateFile, databaseUrl: '' });
        try {
            assert.equal((await store.getAccountById(id)).recoveryCodeHash, recoveryCodeVerifier(proof));
            assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).accounts[id].recoveryCodeHash,
                recoveryCodeVerifier(proof), 'migration must be durable before requests are served');
            await store.close();
            store = await openStore({ stateFile, databaseUrl: '' });
            assert.equal((await store.getAccountById(id)).recoveryCodeHash, recoveryCodeVerifier(proof),
                'restarting must not hash a migrated code again');
            const envelope = { version: 2, strong: { iv: 'aaaaaaaaaaaaaaaa', ciphertext: 'a'.repeat(64) },
                legacy: { version: 1, iv: 'bbbbbbbbbbbbbbbb', ciphertext: 'b'.repeat(64) } };
            assert.equal(await store.consumeAccountRecoveryKit(id, 'kit', proof, 0, 'new', 'salt', envelope), true,
                'existing recovery code must still work');
        } finally { await store.close(); fs.rmSync(stateFile, { force: true }); }
    });

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
