'use strict';

/**
 * Durable storage for the control plane.
 *
 * Two drivers behind one interface:
 *
 * - **postgres** — used when `DATABASE_URL` is set. This is the one that is
 *   meant to run in production: Render's container filesystem is ephemeral, so
 *   an account table living on disk would be gone at the next deploy.
 * - **file** — a JSON file, the same shape the relay used before there were
 *   accounts. It exists so the relay still boots and can be developed against
 *   without provisioning a database, and so an existing deployment is not
 *   bricked the moment this code ships. It says so, loudly, at startup.
 *
 * The device and client tables are also mirrored into memory by `server.js`,
 * because `authenticate()` runs on every single MCP command and must not wait
 * on a query. This module is the truth; that cache is a read-through copy the
 * relay refreshes whenever the phone tells it something changed.
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const DEFAULT_STATE_FILE = path.join(__dirname, '..', '.bridge-state.json');

// ---------------------------------------------------------------------------
// File driver
// ---------------------------------------------------------------------------

function createFileDriver(stateFile) {
    const data = {
        accounts: new Map(),      // id -> account
        webSessions: new Map(),   // idHash -> session
        devices: new Map(),       // deviceId -> device
        clients: new Map(),       // clientId -> client
        claimCodes: new Map(),    // code -> claim
        oauthClients: new Map(),  // client_id -> dynamically registered MCP client
        audit: [],                // newest last
        usage: new Map()          // `${accountId}|${windowStart}` -> counters
    };

    let saveTimer = null;

    function writeNow() {
        clearTimeout(saveTimer);
        saveTimer = null;
        try {
            fs.writeFileSync(stateFile, JSON.stringify({
                version: 2,
                accounts: Object.fromEntries(data.accounts),
                webSessions: Object.fromEntries(data.webSessions),
                devices: Object.fromEntries(data.devices),
                clients: Object.fromEntries(data.clients),
                claimCodes: Object.fromEntries(data.claimCodes),
                oauthClients: Object.fromEntries(data.oauthClients),
                // The audit trail is the one thing worth truncating on disk: it
                // grows without bound and the panel only ever shows a window.
                audit: data.audit.slice(-2000),
                usage: Object.fromEntries(data.usage)
            }), 'utf8');
        } catch (e) {
            console.error('[Store] Could not persist state file:', e.message);
        }
    }

    function save() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(writeNow, 250);
    }

    function load() {
        if (!fs.existsSync(stateFile)) return;
        let raw;
        try {
            raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        } catch (e) {
            console.error('[Store] Could not read state file:', e.message);
            return;
        }

        Object.entries(raw.accounts || {}).forEach(([k, v]) => data.accounts.set(k, v));
        Object.entries(raw.webSessions || {}).forEach(([k, v]) => data.webSessions.set(k, v));
        Object.entries(raw.claimCodes || {}).forEach(([k, v]) => data.claimCodes.set(k, v));
        Object.entries(raw.oauthClients || {}).forEach(([k, v]) => data.oauthClients.set(k, v));
        Object.entries(raw.usage || {}).forEach(([k, v]) => data.usage.set(k, v));
        (raw.audit || []).forEach((e) => data.audit.push(e));

        // A pre-accounts state file has devices as { secretHash } and clients as
        // { deviceId, secretHash, name }. Both are adopted with a null account:
        // they keep working, and the panel shows them as unclaimed until their
        // owner enters a claim code.
        Object.entries(raw.devices || {}).forEach(([id, v]) => {
            data.devices.set(id, {
                id,
                accountId: v.accountId || null,
                secretHash: v.secretHash,
                name: v.name || id,
                enrolledAt: v.enrolledAt || Date.now(),
                lastSeenAt: v.lastSeenAt || null
            });
        });
        Object.entries(raw.clients || {}).forEach(([id, v]) => {
            data.clients.set(id, {
                id,
                deviceId: v.deviceId,
                accountId: v.accountId || null,
                secretHash: v.secretHash,
                name: v.name || 'AI istemcisi',
                createdAt: v.createdAt || Date.now()
            });
        });

        console.log(`[Store] file: ${data.accounts.size} hesap, ${data.devices.size} cihaz, ${data.clients.size} istemci geri yüklendi.`);
    }

    load();

    const clone = (v) => (v ? JSON.parse(JSON.stringify(v)) : null);

    return {
        kind: 'file',
        durable: false,

        async close() { writeNow(); },

        // --- accounts ---
        async createAccount({ email, passwordHash, passwordSalt }) {
            const account = {
                id: randomUUID(),
                email,
                passwordHash,
                passwordSalt,
                createdAt: Date.now(),
                status: 'active',
                plan: 'free',
                isAdmin: false
            };
            data.accounts.set(account.id, account);
            save();
            return clone(account);
        },
        async getAccountByEmail(email) {
            for (const a of data.accounts.values()) {
                if (a.email === email) return clone(a);
            }
            return null;
        },
        async getAccountById(id) { return clone(data.accounts.get(id)); },
        async countAccounts() { return data.accounts.size; },
        async setAccountPassword(id, passwordHash, passwordSalt) {
            const a = data.accounts.get(id);
            if (!a) return;
            a.passwordHash = passwordHash;
            a.passwordSalt = passwordSalt;
            save();
        },
        async setAccountAdmin(id, isAdmin) {
            const a = data.accounts.get(id);
            if (!a) return null;
            a.isAdmin = !!isAdmin;
            save();
            return clone(a);
        },
        async setAccountStatus(id, status) {
            const a = data.accounts.get(id);
            if (!a) return null;
            a.status = status;
            save();
            return clone(a);
        },
        async setAccountPlan(id, plan) {
            const a = data.accounts.get(id);
            if (!a) return null;
            a.plan = plan;
            save();
            return clone(a);
        },
        async listAccounts({ limit = 200 } = {}) {
            const rows = [...data.accounts.values()]
                .sort((x, y) => y.createdAt - x.createdAt)
                .slice(0, limit)
                .map(clone);
            rows.forEach((a) => {
                a.deviceCount = 0;
                a.clientCount = 0;
                delete a.passwordHash;
                delete a.passwordSalt;
            });
            const byId = new Map(rows.map((a) => [a.id, a]));
            for (const d of data.devices.values()) {
                const a = d.accountId && byId.get(d.accountId);
                if (a) a.deviceCount++;
            }
            for (const c of data.clients.values()) {
                const a = c.accountId && byId.get(c.accountId);
                if (a) a.clientCount++;
            }
            return rows;
        },
        async aggregates(windowStart) {
            let commandCount = 0;
            for (const u of data.usage.values()) {
                if (u.windowStart === windowStart) commandCount += u.commandCount;
            }
            let unclaimedDevices = 0;
            for (const d of data.devices.values()) if (!d.accountId) unclaimedDevices++;
            return {
                accounts: data.accounts.size,
                devices: data.devices.size,
                clients: data.clients.size,
                unclaimedDevices,
                commandsToday: commandCount
            };
        },
        async usageForAccounts(ids, windowStart) {
            const out = new Map();
            ids.forEach((id) => {
                const u = data.usage.get(`${id}|${windowStart}`);
                out.set(id, u ? u.commandCount : 0);
            });
            return out;
        },

        // --- web sessions ---
        async createWebSession(session) {
            data.webSessions.set(session.idHash, { ...session });
            save();
            return clone(session);
        },
        async getWebSession(idHash) { return clone(data.webSessions.get(idHash)); },
        async touchWebSession(idHash, lastSeenAt) {
            const s = data.webSessions.get(idHash);
            if (s) { s.lastSeenAt = lastSeenAt; save(); }
        },
        async revokeWebSession(idHash) {
            const s = data.webSessions.get(idHash);
            if (s) { s.revokedAt = Date.now(); save(); }
        },
        async revokeAccountSessions(accountId, exceptIdHash = null) {
            let n = 0;
            for (const s of data.webSessions.values()) {
                if (s.accountId === accountId && !s.revokedAt && s.idHash !== exceptIdHash) {
                    s.revokedAt = Date.now();
                    n++;
                }
            }
            if (n) save();
            return n;
        },

        // --- devices ---
        async getDevice(id) { return clone(data.devices.get(id)); },
        async upsertDevice(device) {
            const existing = data.devices.get(device.id);
            const merged = { ...(existing || {}), ...device };
            if (!merged.enrolledAt) merged.enrolledAt = Date.now();
            if (existing && existing.accountId && device.accountId === undefined) {
                merged.accountId = existing.accountId;
            }
            if (merged.accountId === undefined) merged.accountId = null;
            data.devices.set(device.id, merged);
            save();
            return clone(merged);
        },
        async setDeviceAccount(id, accountId) {
            const d = data.devices.get(id);
            if (!d) return null;
            d.accountId = accountId;
            for (const c of data.clients.values()) {
                if (c.deviceId === id) c.accountId = accountId;
            }
            save();
            return clone(d);
        },
        async touchDevice(id, ts) {
            const d = data.devices.get(id);
            if (d) { d.lastSeenAt = ts; save(); }
        },
        async listDevices(accountId) {
            return [...data.devices.values()]
                .filter((d) => d.accountId === accountId)
                .map(clone);
        },
        async listAllDevices() { return [...data.devices.values()].map(clone); },
        async countDevices(accountId) {
            let n = 0;
            for (const d of data.devices.values()) if (d.accountId === accountId) n++;
            return n;
        },

        // --- clients ---
        async getClient(id) { return clone(data.clients.get(id)); },
        async replaceDeviceClients(deviceId, list) {
            const device = data.devices.get(deviceId);
            const accountId = device ? device.accountId : null;
            for (const [id, c] of [...data.clients.entries()]) {
                if (c.deviceId === deviceId) data.clients.delete(id);
            }
            list.forEach((c) => {
                data.clients.set(c.id, {
                    id: c.id,
                    deviceId,
                    accountId,
                    secretHash: c.secretHash,
                    name: c.name,
                    createdAt: c.createdAt || Date.now()
                });
            });
            save();
        },
        async upsertClient(client) {
            const device = data.devices.get(client.deviceId);
            const existing = data.clients.get(client.id);
            data.clients.set(client.id, {
                createdAt: existing ? existing.createdAt : Date.now(),
                ...existing,
                ...client,
                accountId: device ? device.accountId : null
            });
            save();
        },
        async deleteClient(id) { data.clients.delete(id); save(); },
        async listClients(accountId) {
            return [...data.clients.values()]
                .filter((c) => c.accountId === accountId)
                .map(clone);
        },
        async listAllClients() { return [...data.clients.values()].map(clone); },
        async countClients(accountId) {
            let n = 0;
            for (const c of data.clients.values()) if (c.accountId === accountId) n++;
            return n;
        },

        // --- claim codes ---
        async createClaimCode(claim) {
            for (const [code, c] of [...data.claimCodes.entries()]) {
                if (c.deviceId === claim.deviceId && !c.consumedAt) data.claimCodes.delete(code);
            }
            data.claimCodes.set(claim.code, { ...claim });
            save();
            return clone(claim);
        },
        async getClaimCode(code) { return clone(data.claimCodes.get(code)); },
        async consumeClaimCode(code) {
            const c = data.claimCodes.get(code);
            if (!c || c.consumedAt || c.expiresAt < Date.now()) return null;
            c.consumedAt = Date.now();
            save();
            return clone(c);
        },

        // --- oauth clients ---
        //
        // Registrations carry no secret: an MCP client runs on the user's own
        // machine and is a public OAuth client, so what is kept here is a name
        // and a list of redirect URIs. They are persisted anyway, because a
        // client that has to re-register after every relay restart is a client
        // whose stored client_id keeps going stale.
        async createOAuthClient(record) {
            data.oauthClients.set(record.id, { ...record });
            save();
            return clone(record);
        },
        async getOAuthClient(id) { return clone(data.oauthClients.get(id)); },
        async touchOAuthClient(id, ts) {
            const c = data.oauthClients.get(id);
            if (!c) return;
            c.lastUsedAt = ts;
            save();
        },
        async pruneOAuthClients(before) {
            let removed = 0;
            for (const [id, c] of [...data.oauthClients.entries()]) {
                if ((c.lastUsedAt || c.createdAt || 0) < before) {
                    data.oauthClients.delete(id);
                    removed++;
                }
            }
            if (removed) save();
            return removed;
        },

        // --- audit ---
        async appendAudit(event) {
            data.audit.push(event);
            if (data.audit.length > 5000) data.audit.splice(0, data.audit.length - 5000);
            save();
        },
        async listAudit(accountId, { limit = 200, deviceId = null, clientId = null } = {}) {
            const out = [];
            for (let i = data.audit.length - 1; i >= 0 && out.length < limit; i--) {
                const e = data.audit[i];
                if (e.accountId !== accountId) continue;
                if (deviceId && e.deviceId !== deviceId) continue;
                if (clientId && e.clientId !== clientId) continue;
                out.push(clone(e));
            }
            return out;
        },
        async pruneAudit(before) {
            const kept = data.audit.filter((e) => e.createdAt >= before);
            const removed = data.audit.length - kept.length;
            if (removed > 0) { data.audit = kept; save(); }
            return removed;
        },

        // --- usage ---
        async addUsage(accountId, windowStart, commands, bytes) {
            const key = `${accountId}|${windowStart}`;
            const cur = data.usage.get(key) || { accountId, windowStart, commandCount: 0, byteCount: 0 };
            cur.commandCount += commands;
            cur.byteCount += bytes;
            data.usage.set(key, cur);
            save();
            return clone(cur);
        },
        async getUsage(accountId, windowStart) {
            return clone(data.usage.get(`${accountId}|${windowStart}`))
                || { accountId, windowStart, commandCount: 0, byteCount: 0 };
        }
    };
}

// ---------------------------------------------------------------------------
// Postgres driver
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
    id             uuid PRIMARY KEY,
    email          text UNIQUE NOT NULL,
    password_hash  text NOT NULL,
    password_salt  text NOT NULL,
    created_at     bigint NOT NULL,
    status         text NOT NULL DEFAULT 'active',
    plan           text NOT NULL DEFAULT 'free',
    is_admin       boolean NOT NULL DEFAULT false
);

-- Added after the first release; harmless to re-run.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS web_sessions (
    id_hash         text PRIMARY KEY,
    account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at      bigint NOT NULL,
    expires_at      bigint NOT NULL,
    last_seen_at    bigint,
    user_agent_hash text,
    revoked_at      bigint
);
CREATE INDEX IF NOT EXISTS web_sessions_account ON web_sessions(account_id);

CREATE TABLE IF NOT EXISTS devices (
    id           text PRIMARY KEY,
    account_id   uuid REFERENCES accounts(id) ON DELETE SET NULL,
    secret_hash  text NOT NULL,
    name         text NOT NULL,
    enrolled_at  bigint NOT NULL,
    last_seen_at bigint
);
CREATE INDEX IF NOT EXISTS devices_account ON devices(account_id);

CREATE TABLE IF NOT EXISTS clients (
    id          text PRIMARY KEY,
    device_id   text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    account_id  uuid REFERENCES accounts(id) ON DELETE SET NULL,
    secret_hash text NOT NULL,
    name        text NOT NULL,
    created_at  bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS clients_account ON clients(account_id);
CREATE INDEX IF NOT EXISTS clients_device ON clients(device_id);

CREATE TABLE IF NOT EXISTS claim_codes (
    code        text PRIMARY KEY,
    device_id   text NOT NULL,
    created_at  bigint NOT NULL,
    expires_at  bigint NOT NULL,
    consumed_at bigint
);

CREATE TABLE IF NOT EXISTS oauth_clients (
    id            text PRIMARY KEY,
    name          text NOT NULL,
    redirect_uris text NOT NULL,
    created_at    bigint NOT NULL,
    last_used_at  bigint
);

CREATE TABLE IF NOT EXISTS audit_events (
    id         bigserial PRIMARY KEY,
    account_id uuid,
    device_id  text,
    client_id  text,
    action     text NOT NULL,
    status     text NOT NULL,
    detail     text,
    host       text,
    created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_account_time ON audit_events(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS usage_counters (
    account_id   uuid NOT NULL,
    window_start bigint NOT NULL,
    command_count bigint NOT NULL DEFAULT 0,
    byte_count    bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, window_start)
);
`;

async function createPostgresDriver(connectionString) {
    let Pool;
    try {
        ({ Pool } = require('pg'));
    } catch (e) {
        throw new Error("DATABASE_URL tanımlı ama 'pg' paketi kurulu değil. 'npm install' çalıştırın.");
    }

    const pool = new Pool({
        connectionString,
        // Managed Postgres (Render, Neon, Supabase) terminates TLS with a chain
        // Node does not ship. Verifying it properly needs the provider's CA;
        // until that is configured, refusing to connect helps nobody.
        ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false },
        max: 8
    });

    await pool.query(SCHEMA);

    const q = (text, params) => pool.query(text, params);

    const rowAccount = (r) => r && ({
        id: r.id, email: r.email, passwordHash: r.password_hash, passwordSalt: r.password_salt,
        createdAt: Number(r.created_at), status: r.status, plan: r.plan,
        isAdmin: r.is_admin === true
    });
    const rowSession = (r) => r && ({
        idHash: r.id_hash, accountId: r.account_id, createdAt: Number(r.created_at),
        expiresAt: Number(r.expires_at), lastSeenAt: r.last_seen_at === null ? null : Number(r.last_seen_at),
        userAgentHash: r.user_agent_hash, revokedAt: r.revoked_at === null ? null : Number(r.revoked_at)
    });
    const rowDevice = (r) => r && ({
        id: r.id, accountId: r.account_id, secretHash: r.secret_hash, name: r.name,
        enrolledAt: Number(r.enrolled_at), lastSeenAt: r.last_seen_at === null ? null : Number(r.last_seen_at)
    });
    const rowClient = (r) => r && ({
        id: r.id, deviceId: r.device_id, accountId: r.account_id, secretHash: r.secret_hash,
        name: r.name, createdAt: Number(r.created_at)
    });
    const rowClaim = (r) => r && ({
        code: r.code, deviceId: r.device_id, createdAt: Number(r.created_at),
        expiresAt: Number(r.expires_at), consumedAt: r.consumed_at === null ? null : Number(r.consumed_at)
    });
    const rowOAuthClient = (r) => {
        if (!r) return null;
        let uris = [];
        try { uris = JSON.parse(r.redirect_uris); } catch (e) { uris = []; }
        return {
            id: r.id, name: r.name, redirectUris: Array.isArray(uris) ? uris : [],
            createdAt: Number(r.created_at),
            lastUsedAt: r.last_used_at === null ? null : Number(r.last_used_at)
        };
    };
    const rowAudit = (r) => r && ({
        id: Number(r.id), accountId: r.account_id, deviceId: r.device_id, clientId: r.client_id,
        action: r.action, status: r.status, detail: r.detail, host: r.host, createdAt: Number(r.created_at)
    });

    return {
        kind: 'postgres',
        durable: true,

        async close() { await pool.end(); },

        async createAccount({ email, passwordHash, passwordSalt }) {
            const id = randomUUID();
            const now = Date.now();
            const { rows } = await q(
                `INSERT INTO accounts (id, email, password_hash, password_salt, created_at)
                 VALUES ($1,$2,$3,$4,$5) RETURNING *`,
                [id, email, passwordHash, passwordSalt, now]
            );
            return rowAccount(rows[0]);
        },
        async getAccountByEmail(email) {
            const { rows } = await q('SELECT * FROM accounts WHERE email = $1', [email]);
            return rowAccount(rows[0]);
        },
        async getAccountById(id) {
            const { rows } = await q('SELECT * FROM accounts WHERE id = $1', [id]);
            return rowAccount(rows[0]);
        },
        async countAccounts() {
            const { rows } = await q('SELECT count(*)::int AS n FROM accounts');
            return rows[0].n;
        },
        async setAccountPassword(id, passwordHash, passwordSalt) {
            await q('UPDATE accounts SET password_hash = $2, password_salt = $3 WHERE id = $1',
                [id, passwordHash, passwordSalt]);
        },
        async setAccountAdmin(id, isAdmin) {
            const { rows } = await q('UPDATE accounts SET is_admin = $2 WHERE id = $1 RETURNING *', [id, !!isAdmin]);
            return rowAccount(rows[0]);
        },
        async setAccountStatus(id, status) {
            const { rows } = await q('UPDATE accounts SET status = $2 WHERE id = $1 RETURNING *', [id, status]);
            return rowAccount(rows[0]);
        },
        async setAccountPlan(id, plan) {
            const { rows } = await q('UPDATE accounts SET plan = $2 WHERE id = $1 RETURNING *', [id, plan]);
            return rowAccount(rows[0]);
        },
        async listAccounts({ limit = 200 } = {}) {
            const { rows } = await q(
                `SELECT a.id, a.email, a.created_at, a.status, a.plan, a.is_admin,
                        (SELECT count(*) FROM devices d WHERE d.account_id = a.id)::int AS device_count,
                        (SELECT count(*) FROM clients c WHERE c.account_id = a.id)::int AS client_count
                 FROM accounts a
                 ORDER BY a.created_at DESC
                 LIMIT $1`,
                [Math.min(limit, 1000)]
            );
            return rows.map((r) => ({
                id: r.id, email: r.email, createdAt: Number(r.created_at),
                status: r.status, plan: r.plan, isAdmin: r.is_admin === true,
                deviceCount: r.device_count, clientCount: r.client_count
            }));
        },
        async aggregates(windowStart) {
            const { rows } = await q(
                `SELECT
                    (SELECT count(*) FROM accounts)::int AS accounts,
                    (SELECT count(*) FROM devices)::int AS devices,
                    (SELECT count(*) FROM clients)::int AS clients,
                    (SELECT count(*) FROM devices WHERE account_id IS NULL)::int AS unclaimed,
                    COALESCE((SELECT sum(command_count) FROM usage_counters WHERE window_start = $1), 0)::bigint AS commands`,
                [windowStart]
            );
            const r = rows[0];
            return {
                accounts: r.accounts,
                devices: r.devices,
                clients: r.clients,
                unclaimedDevices: r.unclaimed,
                commandsToday: Number(r.commands)
            };
        },
        async usageForAccounts(ids, windowStart) {
            const out = new Map(ids.map((id) => [id, 0]));
            if (ids.length === 0) return out;
            const { rows } = await q(
                'SELECT account_id, command_count FROM usage_counters WHERE window_start = $1 AND account_id = ANY($2::uuid[])',
                [windowStart, ids]
            );
            rows.forEach((r) => out.set(r.account_id, Number(r.command_count)));
            return out;
        },

        async createWebSession(s) {
            await q(
                `INSERT INTO web_sessions (id_hash, account_id, created_at, expires_at, last_seen_at, user_agent_hash)
                 VALUES ($1,$2,$3,$4,$5,$6)`,
                [s.idHash, s.accountId, s.createdAt, s.expiresAt, s.lastSeenAt || null, s.userAgentHash || null]
            );
            return s;
        },
        async getWebSession(idHash) {
            const { rows } = await q('SELECT * FROM web_sessions WHERE id_hash = $1', [idHash]);
            return rowSession(rows[0]);
        },
        async touchWebSession(idHash, lastSeenAt) {
            await q('UPDATE web_sessions SET last_seen_at = $2 WHERE id_hash = $1', [idHash, lastSeenAt]);
        },
        async revokeWebSession(idHash) {
            await q('UPDATE web_sessions SET revoked_at = $2 WHERE id_hash = $1', [idHash, Date.now()]);
        },
        async revokeAccountSessions(accountId, exceptIdHash = null) {
            const { rowCount } = await q(
                `UPDATE web_sessions SET revoked_at = $2
                 WHERE account_id = $1 AND revoked_at IS NULL AND ($3::text IS NULL OR id_hash <> $3)`,
                [accountId, Date.now(), exceptIdHash]
            );
            return rowCount;
        },

        async getDevice(id) {
            const { rows } = await q('SELECT * FROM devices WHERE id = $1', [id]);
            return rowDevice(rows[0]);
        },
        async upsertDevice(d) {
            const { rows } = await q(
                `INSERT INTO devices (id, account_id, secret_hash, name, enrolled_at, last_seen_at)
                 VALUES ($1,$2,$3,$4,$5,$6)
                 ON CONFLICT (id) DO UPDATE SET
                    secret_hash = EXCLUDED.secret_hash,
                    name = EXCLUDED.name,
                    last_seen_at = COALESCE(EXCLUDED.last_seen_at, devices.last_seen_at)
                 RETURNING *`,
                [d.id, d.accountId || null, d.secretHash, d.name || d.id, d.enrolledAt || Date.now(), d.lastSeenAt || null]
            );
            return rowDevice(rows[0]);
        },
        async setDeviceAccount(id, accountId) {
            const { rows } = await q('UPDATE devices SET account_id = $2 WHERE id = $1 RETURNING *', [id, accountId]);
            await q('UPDATE clients SET account_id = $2 WHERE device_id = $1', [id, accountId]);
            return rowDevice(rows[0]);
        },
        async touchDevice(id, ts) {
            await q('UPDATE devices SET last_seen_at = $2 WHERE id = $1', [id, ts]);
        },
        async listDevices(accountId) {
            const { rows } = await q('SELECT * FROM devices WHERE account_id = $1 ORDER BY enrolled_at', [accountId]);
            return rows.map(rowDevice);
        },
        async listAllDevices() {
            const { rows } = await q('SELECT * FROM devices');
            return rows.map(rowDevice);
        },
        async countDevices(accountId) {
            const { rows } = await q('SELECT count(*)::int AS n FROM devices WHERE account_id = $1', [accountId]);
            return rows[0].n;
        },

        async getClient(id) {
            const { rows } = await q('SELECT * FROM clients WHERE id = $1', [id]);
            return rowClient(rows[0]);
        },
        async replaceDeviceClients(deviceId, list) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const { rows } = await client.query('SELECT account_id FROM devices WHERE id = $1', [deviceId]);
                const accountId = rows[0] ? rows[0].account_id : null;
                await client.query('DELETE FROM clients WHERE device_id = $1', [deviceId]);
                for (const c of list) {
                    await client.query(
                        `INSERT INTO clients (id, device_id, account_id, secret_hash, name, created_at)
                         VALUES ($1,$2,$3,$4,$5,$6)`,
                        [c.id, deviceId, accountId, c.secretHash, c.name, c.createdAt || Date.now()]
                    );
                }
                await client.query('COMMIT');
            } catch (e) {
                await client.query('ROLLBACK');
                throw e;
            } finally {
                client.release();
            }
        },
        async upsertClient(c) {
            await q(
                `INSERT INTO clients (id, device_id, account_id, secret_hash, name, created_at)
                 VALUES ($1,$2,(SELECT account_id FROM devices WHERE id = $2),$3,$4,$5)
                 ON CONFLICT (id) DO UPDATE SET
                    secret_hash = EXCLUDED.secret_hash,
                    name = EXCLUDED.name,
                    account_id = EXCLUDED.account_id`,
                [c.id, c.deviceId, c.secretHash, c.name, c.createdAt || Date.now()]
            );
        },
        async deleteClient(id) { await q('DELETE FROM clients WHERE id = $1', [id]); },
        async listClients(accountId) {
            const { rows } = await q('SELECT * FROM clients WHERE account_id = $1 ORDER BY created_at', [accountId]);
            return rows.map(rowClient);
        },
        async listAllClients() {
            const { rows } = await q('SELECT * FROM clients');
            return rows.map(rowClient);
        },
        async countClients(accountId) {
            const { rows } = await q('SELECT count(*)::int AS n FROM clients WHERE account_id = $1', [accountId]);
            return rows[0].n;
        },

        async createClaimCode(claim) {
            await q('DELETE FROM claim_codes WHERE device_id = $1 AND consumed_at IS NULL', [claim.deviceId]);
            await q(
                `INSERT INTO claim_codes (code, device_id, created_at, expires_at) VALUES ($1,$2,$3,$4)`,
                [claim.code, claim.deviceId, claim.createdAt, claim.expiresAt]
            );
            return claim;
        },
        async getClaimCode(code) {
            const { rows } = await q('SELECT * FROM claim_codes WHERE code = $1', [code]);
            return rowClaim(rows[0]);
        },
        async consumeClaimCode(code) {
            // Single statement so two people racing the same code cannot both win.
            const { rows } = await q(
                `UPDATE claim_codes SET consumed_at = $2
                 WHERE code = $1 AND consumed_at IS NULL AND expires_at > $2
                 RETURNING *`,
                [code, Date.now()]
            );
            return rowClaim(rows[0]) || null;
        },

        async createOAuthClient(record) {
            await q(
                `INSERT INTO oauth_clients (id, name, redirect_uris, created_at, last_used_at)
                 VALUES ($1,$2,$3,$4,$5)`,
                [record.id, record.name, JSON.stringify(record.redirectUris), record.createdAt, record.lastUsedAt]
            );
            return record;
        },
        async getOAuthClient(id) {
            const { rows } = await q('SELECT * FROM oauth_clients WHERE id = $1', [id]);
            return rowOAuthClient(rows[0]);
        },
        async touchOAuthClient(id, ts) {
            await q('UPDATE oauth_clients SET last_used_at = $2 WHERE id = $1', [id, ts]);
        },
        async pruneOAuthClients(before) {
            const { rowCount } = await q(
                'DELETE FROM oauth_clients WHERE COALESCE(last_used_at, created_at) < $1',
                [before]
            );
            return rowCount || 0;
        },

        async appendAudit(e) {
            await q(
                `INSERT INTO audit_events (account_id, device_id, client_id, action, status, detail, host, created_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                [e.accountId || null, e.deviceId || null, e.clientId || null,
                 e.action, e.status, e.detail || null, e.host || null, e.createdAt]
            );
        },
        async listAudit(accountId, { limit = 200, deviceId = null, clientId = null } = {}) {
            const { rows } = await q(
                `SELECT * FROM audit_events
                 WHERE account_id = $1
                   AND ($2::text IS NULL OR device_id = $2)
                   AND ($3::text IS NULL OR client_id = $3)
                 ORDER BY created_at DESC, id DESC
                 LIMIT $4`,
                [accountId, deviceId, clientId, Math.min(limit, 1000)]
            );
            return rows.map(rowAudit);
        },
        async pruneAudit(before) {
            const { rowCount } = await q('DELETE FROM audit_events WHERE created_at < $1', [before]);
            return rowCount;
        },

        async addUsage(accountId, windowStart, commands, bytes) {
            const { rows } = await q(
                `INSERT INTO usage_counters (account_id, window_start, command_count, byte_count)
                 VALUES ($1,$2,$3,$4)
                 ON CONFLICT (account_id, window_start) DO UPDATE SET
                    command_count = usage_counters.command_count + EXCLUDED.command_count,
                    byte_count = usage_counters.byte_count + EXCLUDED.byte_count
                 RETURNING *`,
                [accountId, windowStart, commands, bytes]
            );
            const r = rows[0];
            return { accountId, windowStart, commandCount: Number(r.command_count), byteCount: Number(r.byte_count) };
        },
        async getUsage(accountId, windowStart) {
            const { rows } = await q(
                'SELECT * FROM usage_counters WHERE account_id = $1 AND window_start = $2',
                [accountId, windowStart]
            );
            const r = rows[0];
            return r
                ? { accountId, windowStart, commandCount: Number(r.command_count), byteCount: Number(r.byte_count) }
                : { accountId, windowStart, commandCount: 0, byteCount: 0 };
        }
    };
}

// ---------------------------------------------------------------------------

/**
 * Opens the store. Postgres if `DATABASE_URL` is set, the JSON file otherwise.
 *
 * A failed Postgres connection is fatal on purpose: silently dropping to a file
 * store would mean accounts quietly stop surviving deploys, which is the exact
 * failure this table exists to prevent.
 */
async function openStore(options = {}) {
    const url = (options.databaseUrl || process.env.DATABASE_URL || '').trim();
    if (url) {
        const driver = await createPostgresDriver(url);
        console.log('[Store] PostgreSQL bağlantısı kuruldu; şema hazır.');
        return driver;
    }

    const stateFile = options.stateFile || process.env.BRIDGE_STATE_FILE || DEFAULT_STATE_FILE;
    console.warn('[Store] DATABASE_URL tanımlı değil — dosya deposu kullanılıyor (%s).', stateFile);
    console.warn('[Store] UYARI: Render gibi ortamlarda bu dosya her dağıtımda silinir. Hesaplar kalıcı olmaz.');
    return createFileDriver(stateFile);
}

module.exports = { openStore, SCHEMA };
