'use strict';

const proxyaddr = require('proxy-addr');
// Never accept a hop count or trust every peer: a shorter alternate network
// path would then let a caller supply its own forwarded address.
const trustedProxies = (process.env.TRUSTED_PROXIES || '').split(',').map(s => s.trim()).filter(Boolean);
const trustProxy = trustedProxies.length ? proxyaddr.compile(trustedProxies) : () => false;

/**
 * Layered limits.
 *
 * Each layer protects a different thing, which is why they are separate numbers
 * rather than one global throttle:
 *
 * | limit                  | protects against                     |
 * | ---------------------- | ------------------------------------ |
 * | login attempts         | password brute force                 |
 * | pairing attempts       | guessing an OAuth pairing code       |
 * | credential failures    | scanning for a valid client key      |
 * | WebSocket handshakes   | unauthenticated socket exhaustion     |
 * | concurrent SSE channels| memory growth from abandoned clients |
 * | command quota          | abuse and cost                       |
 * | devices / clients      | one account spreading without bound  |
 *
 * The device keeps its own concurrency cap (`MAX_CONCURRENT_COMMANDS`, 3) and
 * that one is deliberately *not* mirrored here: it protects the phone's battery
 * and memory, which only the phone can judge. These limits protect the relay.
 *
 * Counters are in memory. That is the right trade for a single-instance relay:
 * a restart forgives outstanding attempts, which matters far less than adding a
 * database round trip to the failure path of every request.
 */

/** Thresholds are overridable so an operator can loosen one without a deploy —
 *  a shared office address behind one NAT is a legitimate reason to raise the
 *  registration ceiling, and guessing that number correctly up front is not
 *  something this file can do. */
function envMax(name, fallback) {
    const raw = Number.parseInt(process.env[name] || '', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

const WINDOWS = {
    login: { windowMs: 10 * 60 * 1000, max: envMax('LIMIT_LOGIN_MAX', 10) },
    credential: { windowMs: 5 * 60 * 1000, max: envMax('LIMIT_CREDENTIAL_MAX', 20) },
    register: { windowMs: 60 * 60 * 1000, max: envMax('LIMIT_REGISTER_MAX', 20) },
    claim: { windowMs: 10 * 60 * 1000, max: envMax('LIMIT_CLAIM_MAX', 15) },
    websocket: { windowMs: 60 * 1000, max: envMax('LIMIT_WEBSOCKET_MAX', 30) },
    // Guest accounts have no account row, but they are an intentional product
    // mode rather than the legacy unclaimed-device migration path. Their
    // random guest id therefore gets the same free command ceiling.
    guestCommand: { windowMs: 24 * 60 * 60 * 1000, max: envMax('LIMIT_GUEST_COMMANDS', 5000) },
    // A pairing code is eight Crockford base32 characters, so guessing one
    // is 32^8 work — but it is also the one input on a public page that
    // hands over a browsing credential, and an unlimited form is an
    // invitation to try anyway.
    pairing: { windowMs: 10 * 60 * 1000, max: envMax('LIMIT_PAIRING_MAX', 10) }
};

/** Per-plan ceilings. Free is generous on commands on purpose: they run on the
 *  user's own phone and cost the relay almost nothing, so a tight command limit
 *  would be an artificial cripple rather than a cost control. What is limited is
 *  what actually costs something, or what a paid tier is for. */
// Keep the former FREE variable as a deployment-compatible alias. The value is
// shared by both plans now; concurrency is no longer a paid feature.
const sharedSseChannels = envMax(
    'LIMIT_SSE_CHANNELS',
    envMax('LIMIT_SSE_CHANNELS_FREE', envMax('LIMIT_SSE_CHANNELS_PRO', 5))
);

const PLANS = {
    free: {
        label: 'Ücretsiz',
        maxDevices: 1,
        maxClients: 8,
        // Concurrency and audit history are core product features, not paid
        // gates. Only commands, devices and newly-created AI connections vary.
        maxSseChannelsPerClient: sharedSseChannels,
        commandsPerDay: 5000,
        auditRetentionDays: 90
    },
    pro: {
        label: 'Pro',
        maxDevices: 3,
        maxClients: 50,
        maxSseChannelsPerClient: sharedSseChannels,
        commandsPerDay: 100000,
        auditRetentionDays: 90
    }
};

// Operator-controlled product policy. Abuse throttles above remain deployment
// safety controls and cannot be loosened from the web panel.
const FEATURES = {
    registration: true,
    guestEntry: true,
    cloudBackupUploads: true
};
const POLICY_FIELDS = ['maxDevices', 'maxClients', 'commandsPerDay'];
const POLICY_RANGES = {
    maxDevices: [1, 100],
    maxClients: [1, 1000],
    commandsPerDay: [1, 1000000]
};

function policySnapshot() {
    return {
        free: Object.fromEntries(POLICY_FIELDS.map((key) => [key, PLANS.free[key]])),
        pro: Object.fromEntries(POLICY_FIELDS.map((key) => [key, PLANS.pro[key]])),
        features: { ...FEATURES }
    };
}

function validatePolicy(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        !value.free || !value.pro || !value.features) return null;
    for (const tier of ['free', 'pro']) {
        if (Object.keys(value[tier]).sort().join(',') !== POLICY_FIELDS.slice().sort().join(',')) return null;
        for (const key of POLICY_FIELDS) {
            const n = value[tier][key];
            const [min, max] = POLICY_RANGES[key];
            if (!Number.isSafeInteger(n) || n < min || n > max) return null;
        }
    }
    if (Object.keys(value.features).sort().join(',') !== Object.keys(FEATURES).sort().join(',') ||
        Object.values(value.features).some((enabled) => typeof enabled !== 'boolean')) return null;
    // A paid plan must not have lower product ceilings than Free.
    if (POLICY_FIELDS.some((key) => value.pro[key] < value.free[key])) return null;
    return {
        free: Object.fromEntries(POLICY_FIELDS.map((key) => [key, value.free[key]])),
        pro: Object.fromEntries(POLICY_FIELDS.map((key) => [key, value.pro[key]])),
        features: Object.fromEntries(Object.keys(FEATURES).map((key) => [key, value.features[key]]))
    };
}

function applyPolicy(value) {
    const valid = validatePolicy(value);
    if (!valid) throw new Error('Invalid plan policy');
    for (const tier of ['free', 'pro']) {
        for (const key of POLICY_FIELDS) PLANS[tier][key] = valid[tier][key];
    }
    Object.assign(FEATURES, valid.features);
    return policySnapshot();
}

function planFor(account) {
    if (!account) return PLANS.free;
    // A cached Play entitlement may reach its expiry between registry refreshes.
    // Never let an old hot-cache entry extend paid limits beyond that instant.
    if (account.plan === 'pro' && account.planValidUntil && account.planValidUntil <= Date.now()) {
        return PLANS.free;
    }
    return PLANS[account.plan] || PLANS.free;
}

/** Free overages are paused, never deleted. A prior selection is deliberately
 * invalid after its device/main changes or a policy change lowers a ceiling. */
function freeSelectionStatus(account, deviceIds, clientIds) {
    const plan = planFor(account);
    const allDevices = [...new Set(deviceIds)];
    const allClients = [...new Set(clientIds)];
    const overLimit = plan === PLANS.free &&
        (allDevices.length > plan.maxDevices || allClients.length > plan.maxClients);
    if (!overLimit) return { overLimit: false, required: false,
        activeDeviceIds: allDevices, activeClientIds: allClients };
    const selected = account?.freeSelection;
    const chosenDevices = selected?.deviceIds;
    const chosenClients = selected?.clientIds;
    const valid = Array.isArray(chosenDevices) && Array.isArray(chosenClients) &&
        chosenDevices.length > 0 && chosenDevices.length <= plan.maxDevices &&
        chosenClients.length <= plan.maxClients &&
        new Set(chosenDevices).size === chosenDevices.length &&
        new Set(chosenClients).size === chosenClients.length &&
        chosenDevices.every((id) => allDevices.includes(id)) &&
        chosenClients.every((id) => allClients.includes(id)) &&
        chosenDevices.includes(selected.mainDeviceId) &&
        account.defaultDeviceId === selected.mainDeviceId;
    return { overLimit: true, required: !valid,
        activeDeviceIds: valid ? chosenDevices : [],
        activeClientIds: valid ? chosenClients : [] };
}

const buckets = new Map(); // `${kind}|${key}` -> { count, resetAt }

function sweep() {
    const now = Date.now();
    for (const [k, v] of buckets) {
        if (v.resetAt <= now) buckets.delete(k);
    }
}
const sweepTimer = setInterval(sweep, 60 * 1000);
if (sweepTimer.unref) sweepTimer.unref();

/**
 * Fixed-window counter. Returns `{ allowed, remaining, retryAfterSeconds }`.
 *
 * Fixed rather than sliding because the failure mode of a fixed window — twice
 * the rate across a boundary — is irrelevant at these thresholds, and a sliding
 * window costs memory per attempt.
 */
function hit(kind, key, { peek = false } = {}) {
    const config = WINDOWS[kind];
    if (!config) throw new Error(`Unknown limit: ${kind}`);

    const id = `${kind}|${key}`;
    const now = Date.now();
    let bucket = buckets.get(id);

    if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + config.windowMs };
        buckets.set(id, bucket);
    }

    if (bucket.count >= config.max) {
        return {
            allowed: false,
            remaining: 0,
            retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
        };
    }

    if (!peek) bucket.count += 1;
    return {
        allowed: true,
        remaining: Math.max(0, config.max - bucket.count),
        retryAfterSeconds: 0
    };
}

/** Forgets a counter — called after a success so a legitimate user who
 *  mistyped twice is not still carrying those attempts. */
function reset(kind, key) {
    buckets.delete(`${kind}|${key}`);
}

/** Resolve from the socket through explicitly trusted proxy addresses only. */
function clientIp(req) {
    if (!req.socket?.remoteAddress) return 'unknown';
    return proxyaddr(req, trustProxy);
}

/** Start of the current UTC day — the window quotas are counted in. */
function currentUsageWindow(now = Date.now()) {
    return Math.floor(now / 86400000) * 86400000;
}

module.exports = {
    WINDOWS,
    PLANS,
    FEATURES,
    POLICY_RANGES,
    policySnapshot,
    validatePolicy,
    applyPolicy,
    planFor,
    freeSelectionStatus,
    hit,
    reset,
    clientIp,
    trustProxy,
    currentUsageWindow
};
