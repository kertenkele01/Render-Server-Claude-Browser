'use strict';

// Public product information only: no account identity, entitlement or secrets.
// Build on each request because operators can update plan ceilings live.
function membershipGuide(plans, plusPurchasable = false) {
    const limitsFor = (id) => ({
        commands_per_day: plans[id].commandsPerDay,
        max_devices: plans[id].maxDevices,
        max_ai_connections: plans[id].maxClients
    });
    return {
        title: 'Tabrove Plus and Pro',
        introduction: 'Give your AI more room to work. Plus expands daily browsing capacity and connects more phones and AI clients. Pro is the upcoming upper tier for larger workflows and additional services.',
        plans: {
            free: { name: 'Free', description: 'Start with the core Android browser tools and an isolated profile for each AI connection.', limits: limitsFor('free') },
            plus: {
                name: 'Plus',
                description: 'More daily commands, more linked devices, and more AI connections for sustained browsing workflows.',
                limits: limitsFor('plus'),
                purchasable: plusPurchasable === true,
                availability: plusPurchasable ? 'Available through Google Play in the Android app, subject to store availability.' : 'Google Play purchasing is not configured on this relay.'
            },
            pro: {
                name: 'Pro',
                description: 'The upper tier for larger browsing workloads, with additional services planned for a future release.',
                limits: limitsFor('pro'),
                purchasable: false,
                availability: 'Public purchase is coming soon. An operator may already assign the current Pro quota tier; this does not activate planned services.',
                planned_features: [
                    'Bring your own server, with request capacity determined by your infrastructure.',
                    '10 GB of proxy traffic.',
                    'A 1,000 CAPTCHA-service allowance.',
                    'A dedicated virtual phone session.',
                    'A virtual number for SMS verification.',
                    'An address for email verification.'
                ],
                planned_feature_status: 'These are previews, not currently callable MCP tools or guaranteed active benefits. Current CAPTCHA challenges still require the user on the phone.'
            }
        },
        shared_security: 'All plans use device-side credential checks, isolated AI profiles, permissions and owner approvals. A paid plan never grants sensitive_fields, execute_js, clear_data or unattended access.',
        limits_note: 'These are the current relay plan ceilings, not this account\'s remaining balance or subscription status. The relay operator may change them. Phone-side capacity limits still apply.',
        upgrade: 'The owner can review availability, localized prices, billing periods and subscription status in Android Settings > Membership. This documentation tool cannot purchase or change a subscription.'
    };
}

module.exports = { membershipGuide };
