'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PLANS, planFor, freeSelectionStatus } = require('../lib/limits');

test('Free ve Pro yalnızca komut, cihaz ve yeni AI bağlantısı sınırlarında ayrılır', () => {
    const differing = Object.keys(PLANS.free).filter((key) => PLANS.free[key] !== PLANS.pro[key]);
    assert.deepEqual(
        differing.sort(),
        ['commandsPerDay', 'label', 'maxClients', 'maxDevices'].sort()
    );
    assert.equal(PLANS.free.maxSseChannelsPerClient, PLANS.pro.maxSseChannelsPerClient);
    assert.equal(PLANS.free.auditRetentionDays, PLANS.pro.auditRetentionDays);
});

test('süresi dolmuş Play önbelleği ücretli sınırları uzatmaz', () => {
    assert.equal(
        planFor({ plan: 'pro', planValidUntil: Date.now() - 1 }),
        PLANS.free
    );
    assert.equal(
        planFor({ plan: 'pro', planValidUntil: Date.now() + 60_000 }),
        PLANS.pro
    );
});

test('Pro bitince fazla cihaz ve oturumlar seçim yapılana kadar durur; kayıtlar saklanır', () => {
    const devices = ['phone-a', 'phone-b'];
    const clients = Array.from({ length: PLANS.free.maxClients + 1 }, (_, index) => `session-${index}`);
    const account = { plan: 'pro', planValidUntil: Date.now() - 1, defaultDeviceId: 'phone-a' };
    const pending = freeSelectionStatus(account, devices, clients);
    assert.equal(pending.required, true);
    assert.deepEqual(pending.activeDeviceIds, []);
    assert.deepEqual(pending.activeClientIds, []);
    account.freeSelection = {
        deviceIds: ['phone-b'], clientIds: clients.slice(0, PLANS.free.maxClients), mainDeviceId: 'phone-b'
    };
    account.defaultDeviceId = 'phone-b';
    const chosen = freeSelectionStatus(account, devices, clients);
    assert.equal(chosen.required, false);
    assert.deepEqual(chosen.activeDeviceIds, ['phone-b']);
    assert.equal(chosen.activeClientIds.length, PLANS.free.maxClients);
    assert.equal(clients.length, PLANS.free.maxClients + 1, 'fazla oturum envanterden silindi');
    account.defaultDeviceId = 'phone-a';
    assert.equal(freeSelectionStatus(account, devices, clients).required, true,
        'ana cihaz dışarıdan değişince eski seçim geçerli sayıldı');
});
