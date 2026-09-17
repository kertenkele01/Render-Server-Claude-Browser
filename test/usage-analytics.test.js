'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openStore } = require('../lib/store');

test('araç analitiği yalnızca toplulaştırılmış güvenli alanları saklar ve filtreler', async (t) => {
    const stateFile = path.join(os.tmpdir(), `bridge-usage-${process.pid}-${Date.now()}.json`);
    t.after(() => { try { fs.unlinkSync(stateFile); } catch (e) {} });

    const store = await openStore({ stateFile });
    const account = await store.createAccount({
        email: 'analitik@test.com', passwordHash: 'hash', passwordSalt: 'salt'
    });
    const day = Date.UTC(2026, 8, 16);
    const base = {
        accountId: account.id,
        clientId: 'cli_analytics',
        toolName: 'browser_get_markdown',
        dayStart: day,
        createdAt: day + 1000
    };

    await store.recordToolUsage({
        ...base, status: 'success', durationMs: 120,
        url: 'https://example.com/private?token=secret',
        arguments: { password: 'never-store-this' }
    });
    await store.recordToolUsage({ ...base, status: 'success', durationMs: 80, createdAt: day + 2000 });
    await store.recordToolUsage({ ...base, status: 'error', durationMs: 20, createdAt: day + 3000 });
    await store.recordToolUsage({
        ...base, toolName: 'browser_click', status: 'success', durationMs: 40, createdAt: day + 4000
    });

    const rows = await store.listToolUsage({ from: day, to: day + 86400000, accountId: account.id });
    assert.equal(rows.length, 3);
    const success = rows.find((row) => row.toolName === 'browser_get_markdown' && row.status === 'success');
    assert.equal(success.callCount, 2);
    assert.equal(success.totalDurationMs, 200);
    assert.equal(success.accountEmail, 'analitik@test.com');

    const markdownOnly = await store.listToolUsage({
        from: day, to: day + 86400000, accountId: account.id, toolName: 'browser_get_markdown'
    });
    assert.equal(markdownOnly.length, 2);

    await store.close();
    const persisted = fs.readFileSync(stateFile, 'utf8');
    assert.ok(!persisted.includes('example.com'));
    assert.ok(!persisted.includes('never-store-this'));
});

test('son denetim kayıtları kullanıcıya göre filtrelenir ve yeniden eskiye sıralanır', async (t) => {
    const stateFile = path.join(os.tmpdir(), `bridge-audit-${process.pid}-${Date.now()}.json`);
    t.after(() => { try { fs.unlinkSync(stateFile); } catch (e) {} });

    const store = await openStore({ stateFile });
    const account = await store.createAccount({
        email: 'birinci@test.com', passwordHash: 'hash', passwordSalt: 'salt'
    });
    const other = await store.createAccount({
        email: 'ikinci@test.com', passwordHash: 'hash', passwordSalt: 'salt'
    });

    await store.appendAudit({
        accountId: account.id, clientId: 'cli_a', action: 'SSE Bağlantısı',
        status: 'success', detail: 'sakli-ayrinti', host: 'private.example', createdAt: 1000
    });
    await store.appendAudit({
        accountId: other.id, clientId: 'cli_b', action: 'Tamamlandı: browser_click',
        status: 'success', createdAt: 2000
    });
    await store.appendAudit({
        accountId: account.id, clientId: 'cli_a', action: 'Tamamlandı: browser_get_markdown',
        status: 'success', createdAt: 3000
    });

    const rows = await store.listRecentAudit({ accountId: account.id, limit: 10 });
    assert.deepEqual(rows.map((row) => row.action), [
        'Tamamlandı: browser_get_markdown',
        'SSE Bağlantısı'
    ]);
    assert.ok(rows.every((row) => row.accountId === account.id));
    assert.ok(rows.every((row) => row.accountEmail === 'birinci@test.com'));

    await store.close();
});
