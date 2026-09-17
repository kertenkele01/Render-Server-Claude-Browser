'use strict';

const RESERVED_FIELDS = new Set(['type', 'messageId', 'clientId', 'clientSecret',
    'deviceSecret', 'role', 'timeoutMs', 'maxResponseBytes']);

function argumentsProblem(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
    if (Object.keys(args).some(key => RESERVED_FIELDS.has(key))) return 'reserved command fields are not allowed';
    if (args.operationId !== undefined &&
        (typeof args.operationId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(args.operationId))) {
        return 'operationId must contain 8–80 letters, digits, underscores or hyphens';
    }
    return null;
}

// Memory only, bounded, and scoped to credential + operation id by the caller.
// Retaining even an uncertain outcome prevents an identified operation from
// being dispatched twice after the HTTP request times out.
function operationCache(ttlMs = 5 * 60 * 1000, maxEntries = 500) {
    const entries = new Map();
    return {
        lookup(key, fingerprint) {
            const entry = entries.get(key);
            if (!entry || (entry.settled && entry.expiresAt <= Date.now())) return null;
            if (entry.fingerprint !== fingerprint) return Promise.reject(new Error('operation_id_conflict'));
            return entry.promise;
        },
        run(key, fingerprint, dispatch) {
            const now = Date.now();
            for (const [id, entry] of entries) {
                if (entry.settled && entry.expiresAt <= now) entries.delete(id);
            }
            const existing = entries.get(key);
            if (existing) {
                if (existing.fingerprint !== fingerprint) return Promise.reject(new Error('operation_id_conflict: the same operationId cannot be reused for a different command.'));
                return existing.promise;
            }
            if (entries.size >= maxEntries) return Promise.reject(new Error('operation_cache_full: wait for earlier operations to finish; do not retry with a new operationId.'));
            const entry = { fingerprint, settled: false, expiresAt: Infinity };
            entry.promise = Promise.resolve().then(dispatch);
            entries.set(key, entry);
            const settle = () => { entry.settled = true; entry.expiresAt = Date.now() + ttlMs; };
            entry.promise.then(settle, settle);
            return entry.promise;
        }
    };
}

module.exports = { argumentsProblem, operationCache };
