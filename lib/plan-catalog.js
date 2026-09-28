'use strict';

// Version 2 distinguishes the former paid tier (Plus) from the new upper Pro.
const PLAN_CATALOG_VERSION = 2;
const PLAN_DEFAULTS = {
    free: { label: 'Ücretsiz', maxDevices: 1, maxClients: 8, commandsPerDay: 5000 },
    plus: { label: 'Plus', maxDevices: 3, maxClients: 50, commandsPerDay: 100000 },
    pro: { label: 'Pro', maxDevices: 20, maxClients: 200, commandsPerDay: 1000000 }
};

function migrateLegacyPolicy(policy) {
    if (!policy || policy.plus || !policy.free || !policy.pro || !policy.features) return policy;
    const { label, ...upper } = PLAN_DEFAULTS.pro;
    for (const key of Object.keys(upper)) upper[key] = Math.max(upper[key], policy.pro[key]);
    return { ...policy, plus: { ...policy.pro }, pro: upper };
}

// Verified Google Play purchases grant Plus only; Pro is not on sale yet.
function resolvePaidPlan(account, subscription, now = Date.now()) {
    const operatorPaid = ['plus', 'pro'].includes(account?.plan) &&
        (!account.planExpiresAt || Number(account.planExpiresAt) > now);
    const playActive = subscription?.active === true && Number(subscription.expiresAt || 0) > now;
    return {
        plan: operatorPaid ? account.plan : (playActive ? 'plus' : 'free'),
        planSource: operatorPaid ? 'operator' : (playActive ? 'google_play' : 'free'),
        planValidUntil: operatorPaid ? (Number(account.planExpiresAt) || null) :
            (playActive ? Number(subscription.expiresAt) : null)
    };
}

// Calendar months and years clamp to the last day of the destination month.
// Timestamps and calendar arithmetic use UTC, independent of the server zone.
function planExpiry(unit = 'unlimited', count, now = Date.now()) {
    if (unit === 'unlimited') return null;
    const maxima = { day: 36500, month: 1200, year: 100 };
    if (!Object.hasOwn(maxima, unit)) throw new Error('Geçersiz süre birimi.');
    if (!/^\d+$/.test(String(count)) || !Number.isSafeInteger(Number(count)) ||
        Number(count) < 1 || Number(count) > maxima[unit]) {
        throw new Error(`Süre adedi 1 ile ${maxima[unit]} arasında tam sayı olmalı.`);
    }
    const amount = Number(count);
    const date = new Date(now);
    if (unit === 'day') date.setUTCDate(date.getUTCDate() + amount);
    else {
        const day = date.getUTCDate();
        date.setUTCDate(1);
        date.setUTCMonth(date.getUTCMonth() + amount * (unit === 'year' ? 12 : 1));
        const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
        date.setUTCDate(Math.min(day, lastDay));
    }
    const expiresAt = date.getTime();
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) throw new Error('Geçersiz bitiş tarihi.');
    return expiresAt;
}

function validatePlanAssignment(plan, expiresAt) {
    if (!Object.hasOwn(PLAN_DEFAULTS, plan) ||
        (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= 0))) {
        throw new Error('Geçersiz plan ataması.');
    }
}

module.exports = { PLAN_CATALOG_VERSION, PLAN_DEFAULTS, migrateLegacyPolicy, resolvePaidPlan,
    planExpiry, validatePlanAssignment };
