'use strict';
const path = require('node:path');
function loadConfig(env, root) {
    const config = {};
    const errors = [];
    config.DISCORD_TOKEN = (env.DISCORD_TOKEN || '').trim();
    if (!config.DISCORD_TOKEN) errors.push('DISCORD_TOKEN is required');
    for (const key of ['CLIENT_ID', 'GUILD_ID', 'SUPPORT_ROLE_ID', 'TICKET_CATEGORY_ID', 'TRANSCRIPT_CHANNEL_ID', 'RATING_CHANNEL_ID', 'ESCALATION_ROLE_ID', 'DUPLICATE_APPROVAL_CHANNEL_ID']) {
        config[key] = (env[key] || '').trim();
        if (!/^\d{17,20}$/.test(config[key])) errors.push(`${key} must be a Discord ID`);
    }
    config.BRAND_NAME = (env.BRAND_NAME || '').trim() || 'TicketCore';
    if (config.BRAND_NAME.length > 80) errors.push('BRAND_NAME must be at most 80 characters');
    config.DATABASE_FILE = path.resolve(root, (env.DATABASE_FILE || '').trim() || 'ticketcore-tickets.sqlite');
    const numeric = {
        TICKET_DUPLICATE_LOOKBACK_DAYS: [30, 1, 36500],
        TICKET_DUPLICATE_SIMILARITY_THRESHOLD: [0.60, 0.25, 1],
        TICKET_INACTIVITY_WARN_HOURS: [48, 1, 87600],
        TICKET_INACTIVITY_CLOSE_HOURS: [72, 2, 87600],
        TICKET_INACTIVITY_CHECK_MINUTES: [10, 1, 1440],
        TICKET_REOPEN_WINDOW_HOURS: [48, 1, 87600],
    };
    for (const [key, [fallback, min, max]] of Object.entries(numeric)) {
        const raw = String(env[key] ?? '').trim();
        const value = raw === '' ? fallback : Number(raw);
        config[key] = value;
        if (!Number.isFinite(value) || value < min || value > max) errors.push(`${key} must be a number between ${min} and ${max}`);
    }
    if (config.TICKET_INACTIVITY_CLOSE_HOURS <= config.TICKET_INACTIVITY_WARN_HOURS) errors.push('TICKET_INACTIVITY_CLOSE_HOURS must exceed TICKET_INACTIVITY_WARN_HOURS');
    // Report key names, never values: tokens must not appear in setup errors.
    if (errors.length) throw new Error(`Invalid configuration:\n- ${errors.join('\n- ')}`);
    return config;
}
module.exports = { loadConfig };
