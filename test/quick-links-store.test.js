'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openStore } = require('../lib/store');

test('operator quick links persist affiliate URLs and catalogue revision', async () => {
    const stateFile = path.join(os.tmpdir(), `bridge-quick-links-${process.pid}-${Date.now()}.json`);
    let store;
    try {
        store = await openStore({ stateFile, databaseUrl: '' });
        const initial = await store.listQuickLinks({ includeInactive: true });
        assert.ok(initial.links.length > 0, 'default catalogue was not seeded');

        const saved = await store.upsertQuickLink({
            id: 'affiliate-flight-test',
            category: 'Uçuş',
            categoryOrder: 50,
            name: 'Affiliate Flight',
            url: 'https://tickets.example/flight?aff_id=42&campaign=ai',
            description: 'Bilet aramaları için',
            sortOrder: 5,
            active: true
        });
        assert.equal(saved.revision, initial.revision + 1);
        assert.equal((await store.getQuickLink('affiliate-flight-test')).url,
            'https://tickets.example/flight?aff_id=42&campaign=ai');

        await store.close();
        store = await openStore({ stateFile, databaseUrl: '' });
        const restored = await store.getQuickLink('affiliate-flight-test');
        assert.equal(restored.description, 'Bilet aramaları için');
        assert.equal(restored.url, 'https://tickets.example/flight?aff_id=42&campaign=ai');

        assert.equal(await store.deleteQuickLink('affiliate-flight-test'), true);
        assert.equal(await store.getQuickLink('affiliate-flight-test'), null);
    } finally {
        if (store) await store.close();
        try { fs.unlinkSync(stateFile); } catch (e) {}
    }
});
