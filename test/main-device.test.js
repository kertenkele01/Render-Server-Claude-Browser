'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openStore } = require('../lib/store');

test('only the explicitly selected prepared main device publishes; opt-outs and generations survive restart', async () => {
    const stateFile = path.join(os.tmpdir(), `bridge-main-${process.pid}-${Date.now()}.json`);
    let store = await openStore({ stateFile, databaseUrl: '' });
    try {
        const account = await store.createAccount({ email: 'main@test.com', passwordHash: 'hash', passwordSalt: 'salt' });
        for (const id of ['main', 'backup']) {
            await store.upsertDevice({ id, secretHash: id, name: id });
            await store.setDeviceAccount(id, account.id);
            await store.setDeviceSyncEnabled(id, account.id, true);
            await store.setDeviceCookieSyncEnabledGlobal(id, account.id, true);
        }
        await store.upsertClient({ id: 'shared', deviceId: 'main', secretHash: 'original', name: 'AI' });
        await store.upsertClient({ id: 'shared', deviceId: 'backup', secretHash: 'original', name: 'AI' });
        await store.upsertClient({ id: 'local', deviceId: 'backup', secretHash: 'local', name: 'Local AI' });
        await store.setClientCookieSyncEnabled('shared', account.id, true);
        for (const device of ['main', 'backup']) await store.setDeviceCookieSyncEnabled('shared', device, account.id, true);
        const selected = await store.setAccountDefaultDevice(account.id, 'main');
        const packageFor = (sourceDeviceId, updatedAt = 100) => ({ clientId: 'shared', accountId: account.id, sourceDeviceId, version: 2, iv: 'iv', ciphertext: 'encrypted', updatedAt });
        assert.equal(await store.writeMainCookieSnapshot(packageFor('main'), selected.mainGeneration), null);
        assert.equal(await store.markMainReady(account.id, 'backup', selected.mainGeneration), false);
        assert.equal(await store.markMainReady(account.id, 'main', selected.mainGeneration), true);
        await store.publishDeviceClients(account.id, 'main');
        await store.publishDeviceClients(account.id, 'backup');
        assert.equal((await store.getClient('local')).cloudPublished, false);
        assert.ok(await store.writeMainCookieSnapshot(packageFor('main'), selected.mainGeneration));
        assert.equal(await store.writeMainCookieSnapshot(packageFor('backup'), selected.mainGeneration), null);

        await store.setDeviceCookieSyncEnabled('shared', 'main', account.id, false);
        assert.equal((await store.getAccountById(account.id)).defaultDeviceId, 'main');
        assert.equal(await store.writeMainCookieSnapshot(packageFor('main'), selected.mainGeneration), null);
        await store.setDeviceCookieSyncEnabled('shared', 'main', account.id, true);
        await store.setDeviceSyncEnabled('main', account.id, false);
        assert.equal(await store.writeMainCookieSnapshot(packageFor('main'), selected.mainGeneration), null);
        await store.upsertClient({ id: 'private-main', deviceId: 'main', secretHash: 'private', name: 'Private' });
        await store.publishDeviceClients(account.id, 'main');
        assert.equal((await store.getClient('private-main')).cloudPublished, false);

        await store.close();
        store = await openStore({ stateFile, databaseUrl: '' });
        assert.equal((await store.getClient('local')).cloudPublished, false, 'restart published a backup session');
        assert.equal((await store.getClient('private-main')).cloudPublished, false);
        const newMain = await store.setAccountDefaultDevice(account.id, 'backup');
        assert.ok(newMain.mainGeneration > selected.mainGeneration);
        assert.equal(await store.writeMainCookieSnapshot(packageFor('backup', 200), newMain.mainGeneration), null);
        await store.markMainReady(account.id, 'backup', newMain.mainGeneration);
        await store.publishDeviceClients(account.id, 'backup');
        assert.ok(await store.writeMainCookieSnapshot(packageFor('backup', 200), newMain.mainGeneration));
        assert.equal((await store.getClient('shared')).deviceId, 'main', 'cookie handoff changed credential ownership');
        assert.equal(await store.upsertClient({ id: 'shared', deviceId: 'backup', secretHash: 'forged', name: 'AI' }), null);
        const backAgain = await store.setAccountDefaultDevice(account.id, 'main');
        await store.setDeviceSyncEnabled('main', account.id, true);
        await store.markMainReady(account.id, 'main', backAgain.mainGeneration);
        assert.equal(await store.writeMainCookieSnapshot(packageFor('main', 300), selected.mainGeneration), null, 'stale upload accepted after main returned');
        assert.equal(await store.deleteMainCookieSnapshot(account.id, 'main', 'shared', selected.mainGeneration), false, 'stale delete accepted after main returned');
        assert.equal((await store.getCookieSnapshot(account.id, 'shared')).updatedAt, 200);
        await store.setDeviceAccount('main', null);
        assert.equal((await store.getAccountById(account.id)).defaultDeviceId, null, 'main was automatically reassigned');
    } finally {
        await store.close();
        fs.rmSync(stateFile, { force: true });
    }
});
