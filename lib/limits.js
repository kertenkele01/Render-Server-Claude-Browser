'use strict';

/**
 * Layered limits.
 *
 * Each layer protects a different thing, which is why they are separate numbers
 * rather than one global throttle:
 *
 * | limit                  | protects against                     |
 * | ---------------------- | ------------------------------------ |
 * | login attempts         | password brute force                 |
 * | credential failures    | scanning for a valid client key      |
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
    claim: { windowMs: 10 * 60 * 1000, max: envMax('LIMIT_CLAIM_MAX', 15) }
};

/** Per-plan ceilings. Free is generous on commands on purpose: they run on the
 *  user's own phone and cost the relay almost nothing, so a tight command limit
 *  would be an artificial cripple rather than a cost control. What is limited is
 *  what actually costs something, or what a paid tier is for. */
const PLANS = {
    free: {
        label: 'Ücretsiz',
        maxDevices: 1,
        maxClients: 8,
        maxSseChannelsPerClient: 5,
        commandsPerDay: 5000,
        auditRetentionDays: 7
    },
    pro: {
        label: 'Pro',
        maxDevices: 3,
        maxClients: 50,
        maxSseChannelsPerClient: 10,
        commandsPerDay: 100000,
        auditRetentionDays: 90
    }
};

function planFor(account) {
    if (!account) return PLANS.free;
    return PLANS[account.plan] || PLANS.free;
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

/** The client IP, honouring the proxy header only for its first hop. */
function clientIp(req) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return forwarded || req.socket?.remoteAddress || 'unknown';
}

/** Start of the current UTC day — the window quotas are counted in. */
function currentUsageWindow(now = Date.now()) {
    return Math.floor(now / 86400000) * 86400000;
}

module.exports = {
    WINDOWS,
    PLANS,
    planFor,
    hit,
    reset,
    clientIp,
    currentUsageWindow
};
