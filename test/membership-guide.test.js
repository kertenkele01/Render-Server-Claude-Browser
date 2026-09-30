'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { membershipGuide } = require('../lib/membership-guide');
const { PLAN_DEFAULTS } = require('../lib/plan-catalog');

test('membership copy reflects live policy and billing availability without promoting previews to active tools', () => {
    const plans = structuredClone(PLAN_DEFAULTS);
    const first = membershipGuide(plans, false);
    assert.equal(first.plans.plus.limits.commands_per_day, plans.plus.commandsPerDay);
    assert.equal(first.plans.plus.purchasable, false);
    plans.plus.commandsPerDay = 23456;
    plans.pro.maxDevices = 17;
    const updated = membershipGuide(plans, true);
    assert.equal(updated.plans.plus.limits.commands_per_day, 23456);
    assert.equal(updated.plans.plus.purchasable, true);
    assert.equal(updated.plans.pro.limits.max_devices, 17);
    assert.equal(first.plans.plus.limits.commands_per_day, PLAN_DEFAULTS.plus.commandsPerDay);
    assert.equal(updated.plans.pro.purchasable, false);
    assert.match(updated.plans.pro.availability, /does not activate planned services/);
    assert.match(updated.plans.pro.planned_feature_status, /not currently callable MCP tools/);
    assert.match(updated.shared_security, /paid plan never grants/);
    assert.doesNotMatch(JSON.stringify(updated), /[çğıöşüÇĞİÖŞÜ]/);
    assert.match(updated.limits_note, /not this account's remaining balance/);
});
