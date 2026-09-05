'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openStore } = require('../lib/store');

test('dosya deposu çoklu cihaz bağlarını kalıcı tutar ve hash çatışmasını reddeder', async () => {
    const stateFile = path.join(os.tmpdir(), `bridge-store-multi-${process.pid}-${Date.now()}.json`);
    let store;
    try {
        store = await openStore({ stateFile, databaseUrl: '' });
        const account = await store.createAccount({
            email: 'store-multi@test.com',
            passwordHash: 'hash',
            passwordSalt: 'salt'
        });
        await store.upsertDevice({ id: 'dev_store_1', secretHash: 'd1', name: 'Telefon' });
        await store.upsertDevice({ id: 'dev_store_2', secretHash: 'd2', name: 'Tablet' });
        await store.setDeviceAccount('dev_store_1', account.id);
        await store.setDeviceAccount('dev_store_2', account.id);
        await store.setAccountDefaultDevice(account.id, 'dev_store_2');
        await store.setDeviceSyncEnabled('dev_store_2', account.id, true);
        await store.setDeviceCookieSyncEnabledGlobal('dev_store_2', account.id, true);
        assert.equal((await store.getAccountById(account.id)).defaultDeviceId, 'dev_store_2');
        assert.equal((await store.getDevice('dev_store_2')).cookieSyncEnabled, true);

        const first = await store.upsertClient({
            id: 'cli_store_multi',
            deviceId: 'dev_store_1',
            secretHash: 'a'.repeat(64),
            name: 'Ortak AI'
        });
        assert.deepEqual(first.deviceIds, ['dev_store_1']);

        const shared = await store.upsertClient({
            id: 'cli_store_multi',
            deviceId: 'dev_store_2',
            secretHash: 'a'.repeat(64),
            name: 'Ortak AI'
        });
        assert.deepEqual(new Set(shared.deviceIds), new Set(['dev_store_1', 'dev_store_2']));

        const conflict = await store.upsertClient({
            id: 'cli_store_multi',
            deviceId: 'dev_store_2',
            secretHash: 'b'.repeat(64),
            name: 'Sahte rotasyon'
        });
        assert.equal(conflict, null, 'ikincil cihaz ortak anahtarın hashini değiştirdi');

        await store.setClientCookieSyncEnabled('cli_store_multi', account.id, true);
        await store.setDeviceCookieSyncEnabled('cli_store_multi', 'dev_store_1', account.id, true);
        await store.setDeviceCookieSyncEnabled('cli_store_multi', 'dev_store_2', account.id, true);
        await store.setDeviceCookieSyncEnabled('cli_store_multi', 'dev_store_1', account.id, false);
        assert.equal(
            (await store.getClient('cli_store_multi')).deviceId,
            'dev_store_1',
            'çerez ayarı credential sahibini değiştirdi'
        );

        await store.replaceDeviceClients('dev_store_2', []);
        assert.deepEqual((await store.getClient('cli_store_multi')).deviceIds, ['dev_store_1']);

        await store.upsertClient({
            id: 'cli_store_multi',
            deviceId: 'dev_store_2',
            secretHash: 'a'.repeat(64),
            name: 'Ortak AI'
        });
        await store.replaceDeviceClients('dev_store_1', []);
        assert.equal(
            (await store.getClient('cli_store_multi')).deviceId,
            'dev_store_1',
            'bağlantı kaldırma credential sahibini değiştirdi'
        );
        await store.upsertClient({
            id: 'cli_store_multi',
            deviceId: 'dev_store_1',
            secretHash: 'a'.repeat(64),
            name: 'Ortak AI'
        });
        await store.setDeviceAccount('dev_store_1', null);
        const handedOff = await store.getClient('cli_store_multi');
        assert.equal(handedOff.deviceId, 'dev_store_1', 'hesaptan ayrılmak credential sahibini değiştirdi');
        assert.equal(handedOff.accountId, account.id, 'kalan cihazın hesap bağı kayboldu');
        assert.deepEqual(handedOff.deviceIds, ['dev_store_2']);

        const otherAccount = await store.createAccount({
            email: 'store-other@test.com', passwordHash: 'hash2', passwordSalt: 'salt2'
        });
        await store.upsertDevice({ id: 'dev_store_3', secretHash: 'd3', name: 'Paylaşılan telefon' });
        await store.setDeviceAccount('dev_store_3', account.id);
        await store.upsertClient({
            id: 'cli_eski_hesap', deviceId: 'dev_store_3', secretHash: 'c'.repeat(64), name: 'Eski hesap AI'
        });
        await store.setDeviceAccount('dev_store_3', null);
        await store.setDeviceAccount('dev_store_3', otherAccount.id);
        assert.equal(
            (await store.getClient('cli_eski_hesap')).accountId,
            account.id,
            'çıkıştan sonra eski AI bağlantısı yeni hesaba taşındı'
        );
        await store.upsertCookieSnapshot({
            clientId: 'cli_store_multi',
            accountId: account.id,
            sourceDeviceId: 'dev_store_2',
            version: 1,
            iv: 'c2FrbGFuYW4taXY=',
            ciphertext: 'c2FrbGFuYW4tc2lmcmVsaS1jZXJleg==',
            updatedAt: 12345
        });
        await store.close();
        store = null;

        const restored = await openStore({ stateFile, databaseUrl: '' });
        assert.equal((await restored.getAccountById(account.id)).defaultDeviceId, 'dev_store_2');
        assert.deepEqual((await restored.getClient('cli_store_multi')).deviceIds, ['dev_store_2']);
        const preservedCloudClient = await restored.getClient('cli_eski_hesap');
        assert.equal(preservedCloudClient.accountId, account.id);
        assert.deepEqual(preservedCloudClient.deviceIds, [], 'hesaptan çıkarılan telefon yeniden bağlandı');
        const cookieSnapshot = await restored.getCookieSnapshot(account.id, 'cli_store_multi');
        assert.equal(cookieSnapshot.ciphertext, 'c2FrbGFuYW4tc2lmcmVsaS1jZXJleg==');
        assert.equal(await restored.getCookieSnapshot('baska-hesap', 'cli_store_multi'), null);
        await restored.close();
    } finally {
        if (store) await store.close();
        try { fs.unlinkSync(stateFile); } catch (e) {}
    }
});
