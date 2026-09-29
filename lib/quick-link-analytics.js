'use strict';

const DAY = 86400000;
const dayStart = (timestamp) => Math.floor(timestamp / DAY) * DAY;
const dateText = (timestamp) => new Date(timestamp).toISOString().slice(0, 10);

function parseDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const timestamp = Date.parse(value + 'T00:00:00.000Z');
    return Number.isFinite(timestamp) && dateText(timestamp) === value ? timestamp : null;
}

function quickLinkReportRange(query = {}, now = Date.now()) {
    const today = dayStart(now);
    const date = new Date(today);
    const month = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    const presets = {
        today: [today, 'Bugün'], week: [today - 6 * DAY, 'Son 7 gün'],
        month: [month, 'Bu ay'], days30: [today - 29 * DAY, 'Son 30 gün'],
        year: [Date.UTC(date.getUTCFullYear(), 0, 1), 'Bu yıl']
    };
    let period = Object.hasOwn(presets, query.period) ? query.period : 'month';
    let [from, label] = presets[period];
    let to = today + DAY;
    let error = '';
    if (query.period === 'custom') {
        const start = parseDate(query.from), end = parseDate(query.to);
        if (start === null || end === null || start > end || end > today || end - start >= 366 * DAY) {
            error = 'Geçerli bir tarih aralığı seçin: en fazla 366 gün, bitiş tarihi bugün veya öncesi olmalı.';
        } else {
            period = 'custom'; from = start; to = end + DAY; label = 'Özel tarih aralığı';
        }
    }
    const group = query.group === 'month' || to - from > 62 * DAY ? 'month' : 'day';
    return { period, from, to, label, group, error, fromDate: dateText(from), toDate: dateText(to - DAY),
        // Load the current summary counters even when the selected period is historical.
        queryFrom: Math.min(from, month, today - 6 * DAY), queryTo: today + DAY };
}

function quickLinkReport(links, categories, analytics, range, now = Date.now()) {
    const today = dayStart(now), date = new Date(today);
    const month = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    const empty = (total = 0) => ({ today: 0, week: 0, month: 0, period: 0, total });
    const bySite = new Map(links.map((link) => [link.id, empty(Number(link.openCount || 0))]));
    const byCategory = new Map(categories.map((category) => [category.id, empty()]));
    const buckets = new Map();
    for (let day = range.from; day < range.to; day += DAY) {
        const key = dateText(day).slice(0, range.group === 'month' ? 7 : 10);
        if (!buckets.has(key)) buckets.set(key, 0);
    }
    for (const row of analytics.days) {
        const stat = bySite.get(row.id);
        if (!stat) continue;
        const day = Number(row.dayStart), count = Number(row.openCount);
        if (day === today) stat.today += count;
        if (day >= today - 6 * DAY && day < today + DAY) stat.week += count;
        if (day >= month && day < today + DAY) stat.month += count;
        if (day >= range.from && day < range.to) {
            stat.period += count;
            const key = dateText(day).slice(0, range.group === 'month' ? 7 : 10);
            buckets.set(key, (buckets.get(key) || 0) + count);
        }
    }
    const totals = empty();
    for (const link of links) {
        const stat = bySite.get(link.id), category = byCategory.get(link.categoryId);
        for (const key of Object.keys(totals)) {
            totals[key] += stat[key];
            if (category) category[key] += stat[key];
        }
    }
    return { bySite, byCategory, totals, buckets: [...buckets].map(([date, count]) => ({ date, count })),
        startedAt: analytics.startedAt, range };
}

module.exports = { DAY, dayStart, quickLinkReportRange, quickLinkReport };
