'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { openStore } = require('../lib/store');
const { DAY, quickLinkReportRange, quickLinkReport } = require('../lib/quick-link-analytics');
const panel = require('../lib/panel');

const now = Date.parse('2026-03-02T00:30:00Z');
test('UTC ranges include both selected dates, cross month boundaries, and reject invalid ranges', () => {
    const week = quickLinkReportRange({ period: 'week' }, now);
    assert.equal(week.to - week.from, 7 * DAY);
    assert.equal(week.fromDate, '2026-02-24');
    const custom = quickLinkReportRange({ period: 'custom', from: '2026-02-28', to: '2026-03-01' }, now);
    assert.equal(custom.to - custom.from, 2 * DAY);
    assert.equal(custom.error, '');
    for (const dates of [['2026-02-30', '2026-03-01'], ['2026-03-02', '2026-03-01'],
        ['2026-03-01', '2026-03-03'], ['2020-01-01', '2026-03-01'], ['', '']]) {
        const range = quickLinkReportRange({ period: 'custom', from: dates[0], to: dates[1] }, now);
        assert.ok(range.error);
        assert.equal(range.period, 'month');
    }
    assert.equal(quickLinkReportRange({ period: 'year' }, now).fromDate, '2026-01-01');
    assert.equal(quickLinkReportRange({ period: 'custom', from: ['2026-03-01'], to: {} }, now).period, 'month');
});

test('daily and monthly sums match category and site reports, preserving historical totals separately', () => {
    const links = [{ id: 'a', categoryId: 'c1', openCount: 100 }, { id: 'b', categoryId: 'c2', openCount: 20 }];
    const categories = [{ id: 'c1' }, { id: 'c2' }];
    const analytics = { startedAt: now - 5 * DAY, days: [
        { id: 'a', dayStart: Date.parse('2026-02-28'), openCount: 3 },
        { id: 'a', dayStart: Date.parse('2026-03-01'), openCount: 4 },
        { id: 'b', dayStart: Date.parse('2026-03-02'), openCount: 2 },
        { id: 'deleted', dayStart: Date.parse('2026-03-02'), openCount: 999 }
    ] };
    const range = quickLinkReportRange({ period: 'week', group: 'month' }, now);
    const report = quickLinkReport(links, categories, analytics, range, now);
    assert.deepEqual(report.totals, { today: 2, week: 9, month: 6, period: 9, total: 120 });
    assert.deepEqual(report.buckets, [{ date: '2026-02', count: 3 }, { date: '2026-03', count: 6 }]);
    assert.equal(report.byCategory.get('c1').period, 7);
    assert.equal(report.bySite.get('a').month, 4);
    links[0].categoryId = 'c2';
    const moved = quickLinkReport(links, categories, analytics, range, now);
    assert.equal(moved.byCategory.get('c1').period, 0);
    assert.equal(moved.byCategory.get('c2').period, 9);
    const days = quickLinkReport(links, categories, analytics, quickLinkReportRange({ period: 'month' }, now), now);
    assert.deepEqual(days.buckets, [{ date: '2026-03-01', count: 4 }, { date: '2026-03-02', count: 2 }]);
});

for (const driver of ['file', ...(process.env.TEST_DATABASE_URL ? ['postgres'] : [])]) {
    test(`${driver}: opens update total and daily counters atomically, survive restart, and respect hidden/deleted sites`, async () => {
        const stateFile = path.join(os.tmpdir(), `quick-link-analytics-${randomUUID()}.json`);
        const options = { stateFile, databaseUrl: driver === 'postgres' ? process.env.TEST_DATABASE_URL : '' };
        let store;
        const categoryId = `cat-${randomUUID()}`, id = `site-${randomUUID()}`;
        try {
            store = await openStore(options);
            await store.upsertQuickLinkCategory({ id: categoryId, title: categoryId, sortOrder: 0 });
            const link = { id, categoryId, name: 'Test', url: 'https://example.com/?affiliate=private',
                description: 'description', sortOrder: 0, active: true };
            await store.upsertQuickLink(link);
            const revision = (await store.listQuickLinks()).revision;
            const at = Date.parse('2026-03-01T23:59:59Z');
            await Promise.all(Array.from({ length: 20 }, () => store.recordQuickLinkOpen(id, at)));
            await store.recordQuickLinkOpen(id, at + 1000);
            await store.recordQuickLinkOpen(id, at - DAY);
            assert.equal((await store.getQuickLink(id)).openCount, 22);
            assert.equal((await store.getQuickLink(id)).lastOpenedAt, at + 1000);
            assert.equal((await store.listQuickLinks()).revision, revision, 'analytics must not change catalogue revision');
            const analytics = await store.listQuickLinkAnalytics({ from: at - 2 * DAY, to: at + DAY });
            assert.equal(analytics.days.filter((row) => row.id === id).reduce((sum, row) => sum + row.openCount, 0), 22);
            assert.equal(analytics.days.find((row) => row.id === id && row.dayStart === Date.parse('2026-03-01')).openCount, 20);
            assert.ok(!JSON.stringify(analytics).includes('affiliate'));
            assert.ok(analytics.days.every((row) => Object.keys(row).sort().join(',') === 'dayStart,id,openCount'));
            await store.close();
            store = await openStore(options);
            assert.equal((await store.listQuickLinkAnalytics()).startedAt, analytics.startedAt);
            assert.equal((await store.getQuickLink(id)).openCount, 22);
            await store.upsertQuickLink({ ...link, active: false });
            assert.equal(await store.recordQuickLinkOpen(id), null);
            assert.equal(await store.recordQuickLinkOpen('unknown-site'), null);
            assert.equal((await store.getQuickLink(id)).openCount, 22);
            await assert.rejects(store.recordQuickLinkOpen(id, NaN));
            assert.equal(await store.deleteQuickLink(id), true);
            assert.ok(!(await store.listQuickLinkAnalytics()).days.some((row) => row.id === id));
            await store.deleteQuickLinkCategory(categoryId);
        } finally {
            if (store) {
                await store.deleteQuickLink(id);
                await store.deleteQuickLinkCategory(categoryId);
                await store.close();
            }
            if (driver === 'file') fs.rmSync(stateFile, { force: true });
        }
    });
}

test('file migration keeps legacy total without inventing dated openings', async () => {
    const stateFile = path.join(os.tmpdir(), `quick-link-legacy-${randomUUID()}.json`);
    fs.writeFileSync(stateFile, JSON.stringify({ quickLinks: { old: { id: 'old', categoryId: 'c', category: 'C',
        name: 'Old', url: 'https://example.com', active: true, openCount: 500, lastOpenedAt: 1234 } },
        quickLinkCategories: { c: { id: 'c', title: 'C', sortOrder: 0 } }, quickLinkRevision: 10 }));
    let store;
    try {
        store = await openStore({ stateFile, databaseUrl: '' });
        const analytics = await store.listQuickLinkAnalytics();
        assert.equal(analytics.days.length, 0);
        assert.equal((await store.getQuickLink('old')).openCount, 500);
        await store.recordQuickLinkOpen('old');
        assert.equal((await store.getQuickLink('old')).openCount, 501);
        await store.close();
        store = await openStore({ stateFile, databaseUrl: '' });
        assert.equal((await store.listQuickLinkAnalytics()).startedAt, analytics.startedAt);
        assert.equal((await store.listQuickLinkAnalytics()).days[0].openCount, 1);
    } finally { await store?.close(); fs.rmSync(stateFile, { force: true }); }
});

test('operator view filters and escapes untrusted catalogue copy without scripts or affiliate URLs in the listing', () => {
    const links = [{ id: 'a', name: '<img src=x onerror=alert(1)>', categoryId: 'c', category: 'C',
        url: 'https://example.com/?affiliate=kept', description: '<script>bad</script>', active: false, openCount: 6 }];
    const categories = [{ id: 'c', title: '<category>', sortOrder: 0 }];
    const range = quickLinkReportRange({}, now);
    const report = quickLinkReport(links, categories, { startedAt: now, days: [] }, range, now);
    const options = { account: { email: 'operator@test.com' }, catalogue: { links, revision: 1 }, categories, csrf: 'csrf', report };
    const html = panel.renderQuickLinks(options);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(html, /<script|<img src=x/);
    assert.doesNotMatch(html, /affiliate=kept/);
    const edit = panel.renderQuickLinks({ ...options, filters: { edit: 'a' } });
    assert.match(edit, /affiliate=kept/);
    assert.match(edit, /&lt;script&gt;bad&lt;\/script&gt;/);
    assert.match(panel.renderQuickLinks({ ...options, filters: { state: 'active' } }), /eşleşen site yok/);
    assert.match(html, /name="_csrf"/);
});
