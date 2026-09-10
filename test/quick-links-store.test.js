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
        const categories = await store.listQuickLinkCategories();
        const flight = categories.find((category) => category.title === 'Uçuş');
        assert.ok(flight, 'default category was not seeded');

        const saved = await store.upsertQuickLink({
            id: 'affiliate-flight-test',
            categoryId: flight.id,
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
        await store.recordQuickLinkOpen('affiliate-flight-test', 123456);
        const counted = await store.getQuickLink('affiliate-flight-test');
        assert.equal(counted.openCount, 1);
        assert.equal(counted.lastOpenedAt, 123456);

        await store.upsertQuickLinkCategory({ id: flight.id, title: 'Uçak Bileti', sortOrder: 15 });
        const moved = await store.getQuickLink('affiliate-flight-test');
        assert.equal(moved.category, 'Uçak Bileti');
        assert.equal(moved.categoryOrder, 15);

        await store.close();
        store = await openStore({ stateFile, databaseUrl: '' });
        const restored = await store.getQuickLink('affiliate-flight-test');
        assert.equal(restored.description, 'Bilet aramaları için');
        assert.equal(restored.url, 'https://tickets.example/flight?aff_id=42&campaign=ai');
        assert.equal(restored.openCount, 1);
        assert.equal(restored.category, 'Uçak Bileti');

        assert.equal(await store.deleteQuickLink('affiliate-flight-test'), true);
        assert.equal(await store.getQuickLink('affiliate-flight-test'), null);
        assert.equal(await store.deleteQuickLinkCategory(flight.id), false,
            'category containing default sites should not be deleted');
    } finally {
        if (store) await store.close();
        try { fs.unlinkSync(stateFile); } catch (e) {}
    }
});
