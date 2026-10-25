/**
 * TicketCore Discord Bot v1.4.1 (Ticket-Only Edition)
 * Public distribution of the supplied running Eternity ticket bot.
 * Discord.js v14
 *
 * Features:
 * - Blue / black ticket system with configurable branding
 * - General Support / Report / Partner tickets
 * - Persistent SQLite ticket counter (0000-9999)
 * - Persistent ticket history
 * - Staff statistics
 * - Branded transcript headers
 * - 1-5 star customer ratings
 * - Ticket priority system with color-coded embeds
 * - /priority support command
 * - Customer inactivity warnings and automatic closure
 * - Ticket reopen system
 * - Ticket transfer system
 * - Ticket escalation workflow
 * - Duplicate ticket review / approval queue
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
    Client, GatewayIntentBits, Partials,
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder,
    PermissionsBitField, ChannelType, Events,
    REST, Routes, EmbedBuilder, Collection,
} = require('discord.js');
const discordTranscripts = require('discord-html-transcripts');

// ========== DATABASE DRIVER ==========
// sql.js is a WebAssembly build of SQLite. It works on Node.js 21 without
// native addons, so Pterodactyl does not need better-sqlite3 or Node 22.5+.
const initSqlJs = require('sql.js');
let db = null;
const DATABASE_DRIVER = 'sql.js';

class SqlJsStatement {
    constructor(owner, sql) {
        this.owner = owner;
        this.sql = sql;
    }

    get(...params) {
        const statement = this.owner.database.prepare(this.sql);
        try {
            statement.bind(params);
            if (!statement.step()) return undefined;
            return statement.getAsObject();
        } finally {
            statement.free();
        }
    }

    all(...params) {
        const statement = this.owner.database.prepare(this.sql);
        const rows = [];
        try {
            statement.bind(params);
            while (statement.step()) {
                rows.push(statement.getAsObject());
            }
            return rows;
        } finally {
            statement.free();
        }
    }

    run(...params) {
        this.owner.database.run(this.sql, params);
        const changes = this.owner.database.getRowsModified();

        let lastInsertRowid = 0;
        const result = this.owner.database.exec('SELECT last_insert_rowid() AS id;');
        if (result?.[0]?.values?.[0]?.[0] !== undefined) {
            lastInsertRowid = Number(result[0].values[0][0]);
        }

        this.owner.persist();
        return { changes, lastInsertRowid };
    }
}

class SqlJsDatabase {
    constructor(SQL, filePath) {
        this.filePath = filePath;

        if (fs.existsSync(filePath)) {
            const existing = fs.readFileSync(filePath);
            this.database = new SQL.Database(new Uint8Array(existing));
        } else {
            this.database = new SQL.Database();
        }
    }

    exec(sql) {
        const result = this.database.exec(sql);
        this.persist();
        return result;
    }

    prepare(sql) {
        return new SqlJsStatement(this, sql);
    }

    persist() {
        const exported = this.database.export();
        const tempFile = `${this.filePath}.tmp`;
        fs.writeFileSync(tempFile, Buffer.from(exported));
        fs.renameSync(tempFile, this.filePath);
    }
}

function ensureTicketColumn(columnName, definition) {
    const columns = db.prepare('PRAGMA table_info(tickets)').all();
    const exists = columns.some(column => String(column.name).toLowerCase() === String(columnName).toLowerCase());

    if (!exists) {
        db.exec(`ALTER TABLE tickets ADD COLUMN ${columnName} ${definition};`);
        console.log(`[Ticket Database] Added column: ${columnName}`);
    }
}

async function initializeDatabase() {
    const SQL = await initSqlJs({
        locateFile: file => require.resolve(`sql.js/dist/${file}`),
    });

    db = new SqlJsDatabase(SQL, CONSTANTS.DATABASE_FILE);

    db.exec(`
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tickets (
            record_id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticket_id TEXT NOT NULL,
            guild_id TEXT NOT NULL,
            channel_id TEXT,
            channel_name TEXT,
            owner_id TEXT NOT NULL,
            type_key TEXT NOT NULL,
            subject TEXT,
            purchase_description TEXT,
            opened_at INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'OPEN',
            claimed_by TEXT,
            claimed_at INTEGER,
            assigned_staff_id TEXT,
            closed_by TEXT,
            closed_at INTEGER,
            rating INTEGER,
            rated_at INTEGER,
            transcript_message_id TEXT,
            priority TEXT NOT NULL DEFAULT 'NORMAL',
            last_customer_message_at INTEGER,
            last_staff_message_at INTEGER,
            inactivity_warned_at INTEGER,
            reopened_from_record_id INTEGER,
            reopen_count INTEGER NOT NULL DEFAULT 0,
            transfer_count INTEGER NOT NULL DEFAULT 0,
            escalated_by TEXT,
            escalated_at INTEGER,
            escalation_reason TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_tickets_ticket_id
            ON tickets(ticket_id);

        CREATE INDEX IF NOT EXISTS idx_tickets_channel_id
            ON tickets(channel_id);

        CREATE INDEX IF NOT EXISTS idx_tickets_owner_status
            ON tickets(owner_id, status);

        CREATE TABLE IF NOT EXISTS staff_stats (
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            tickets_claimed INTEGER NOT NULL DEFAULT 0,
            tickets_closed INTEGER NOT NULL DEFAULT 0,
            rating_total INTEGER NOT NULL DEFAULT 0,
            rating_count INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (guild_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS pending_ticket_requests (
            request_id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            type_key TEXT NOT NULL,
            subject TEXT,
            purchase_description TEXT,
            duplicate_record_id INTEGER,
            duplicate_reason TEXT,
            similarity_score REAL,
            status TEXT NOT NULL DEFAULT 'PENDING',
            requested_at INTEGER NOT NULL,
            reviewed_by TEXT,
            reviewed_at INTEGER,
            approval_message_id TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_pending_ticket_requests_status
            ON pending_ticket_requests(guild_id, user_id, status);
    `);

    // Migrations for databases created by older Eternity/Spector builds.
    ensureTicketColumn('priority', "TEXT NOT NULL DEFAULT 'NORMAL'");
    ensureTicketColumn('last_customer_message_at', 'INTEGER');
    ensureTicketColumn('last_staff_message_at', 'INTEGER');
    ensureTicketColumn('inactivity_warned_at', 'INTEGER');
    ensureTicketColumn('reopened_from_record_id', 'INTEGER');
    ensureTicketColumn('reopen_count', 'INTEGER NOT NULL DEFAULT 0');
    ensureTicketColumn('transfer_count', 'INTEGER NOT NULL DEFAULT 0');
    ensureTicketColumn('escalated_by', 'TEXT');
    ensureTicketColumn('escalated_at', 'INTEGER');
    ensureTicketColumn('escalation_reason', 'TEXT');

    initializeTicketCounter();
    console.log(`[Ticket Database] Ready using ${DATABASE_DRIVER}. Next ticket ID: ${formatTicketId(getCurrentTicketCounter())}`);
}

// ========== CONFIGURATION ==========
const {
    DISCORD_TOKEN,
    CLIENT_ID,
    GUILD_ID,
    SUPPORT_ROLE_ID,
    TICKET_CATEGORY_ID,
    TRANSCRIPT_CHANNEL_ID,
    RATING_CHANNEL_ID,
    ESCALATION_ROLE_ID,
    DUPLICATE_APPROVAL_CHANNEL_ID,
    BRAND_NAME,
    DATABASE_FILE,
    TICKET_DUPLICATE_LOOKBACK_DAYS,
    TICKET_DUPLICATE_SIMILARITY_THRESHOLD,
    TICKET_INACTIVITY_WARN_HOURS,
    TICKET_INACTIVITY_CLOSE_HOURS,
    TICKET_INACTIVITY_CHECK_MINUTES,
    TICKET_REOPEN_WINDOW_HOURS,
} = require('./config').loadConfig(process.env, __dirname);

// ========== CONSTANTS ==========
const CONSTANTS = {
    COLORS: {
        DEFAULT: '#0A84FF',
        DARK: '#0B0F14',
        SUCCESS: '#0A84FF',
        ERROR: '#ED4245',
        WARNING: '#0A84FF',
    },
    BRAND_NAME,
    TICKET_TOPIC_MARKER: 'TICKETCORE_TICKET',
    LEGACY_TICKET_TOPIC_MARKERS: ['ETERNITY_TICKET', 'SPECTOR_TICKET'],
    LEGACY_TICKET_PREFIX: 'ticket-',
    DATABASE_FILE,
    LEGACY_COUNTER_FILE: path.join(__dirname, 'ticket-counter.json'),
    MAX_TICKET_ID: 9999,
    RATING_CHANNEL_ID,
    ESCALATION_ROLE_ID,
    DUPLICATE_APPROVAL_CHANNEL_ID,
    TICKET_CATEGORY_ID,
    DUPLICATE_LOOKBACK_DAYS: TICKET_DUPLICATE_LOOKBACK_DAYS,
    DUPLICATE_SIMILARITY_THRESHOLD: TICKET_DUPLICATE_SIMILARITY_THRESHOLD,
    INACTIVITY_WARN_HOURS: TICKET_INACTIVITY_WARN_HOURS,
    INACTIVITY_CLOSE_HOURS: TICKET_INACTIVITY_CLOSE_HOURS,
    INACTIVITY_CHECK_MINUTES: TICKET_INACTIVITY_CHECK_MINUTES,
    REOPEN_WINDOW_HOURS: TICKET_REOPEN_WINDOW_HOURS,
};

const PRIORITIES = {
    LOW: {
        label: 'Low',
        display: '`LOW`',
        color: '#6B7280',
    },
    NORMAL: {
        label: 'Normal',
        display: '`NORMAL`',
        color: '#0A84FF',
    },
    HIGH: {
        label: 'High',
        display: '`HIGH`',
        color: '#F59E0B',
    },
    URGENT: {
        label: 'Urgent',
        display: '`URGENT`',
        color: '#ED4245',
    },
};

const TICKET_TYPES = {
    general_support: {
        label: 'General Support',
        channelPrefix: 'General-Support-',
        emoji: '🔷',
        panelDescription: 'Questions, technical assistance, account help, or general enquiries.',
        openingTitle: 'GENERAL SUPPORT',
        openingDescription: `Your request has been routed to **General Support**. A member of the ${CONSTANTS.BRAND_NAME} team will review your message and assist you as soon as possible.`,
        requestFieldName: 'Support Request',
        guidance: 'Please explain the issue clearly and include any useful screenshots, error messages, or other relevant information.'
    },
    report: {
        label: 'Report',
        channelPrefix: 'Report-',
        emoji: '🚨',
        panelDescription: 'Report a user, incident, suspicious activity, abuse, or another concern.',
        openingTitle: 'REPORT',
        openingDescription: `Your report has been routed to the **${CONSTANTS.BRAND_NAME} Team**. Staff will review the information you provided and respond as soon as possible.`,
        requestFieldName: 'Report Details',
        guidance: 'Include what happened, who or what is involved, and any useful screenshots, links, message IDs, or other evidence. Do not post sensitive personal information.'
    },
    partner: {
        label: 'Partner',
        channelPrefix: 'Partner-Support-',
        emoji: '🤝',
        panelDescription: 'Partnership proposals, collaboration requests, and partner support.',
        openingTitle: 'PARTNERSHIP',
        openingDescription: 'Your request has been routed to the **Partnership Team**. We will review your proposal or partner-related enquiry and respond when available.',
        requestFieldName: 'Partnership Request',
        guidance: 'Please include the name of your community or organisation, what you are proposing, and any relevant links or details.'
    },
};

// Legacy definitions are intentionally non-enumerable. They keep already-open
// Store/Nitro tickets readable and closable without exposing those departments
// in the current ticket panel or /transfer choices.
Object.defineProperties(TICKET_TYPES, {
    store: {
        enumerable: false,
        value: {
            label: 'Report',
            channelPrefix: 'Store-Support-',
            emoji: '🚨',
            openingTitle: 'REPORT',
            openingDescription: `This legacy ticket is now handled by the **${CONSTANTS.BRAND_NAME} Team** as a report.`,
            requestFieldName: 'Report Details',
            guidance: 'Provide any useful context or evidence for staff review.'
        }
    },
    nitro_boosts: {
        enumerable: false,
        value: {
            label: 'Legacy Ticket',
            channelPrefix: 'Nitro-Boosts-',
            emoji: '🔷',
            openingTitle: 'LEGACY TICKET',
            openingDescription: `This legacy ticket remains available for compatibility and is handled by the **${CONSTANTS.BRAND_NAME} Support Team**.`,
            requestFieldName: 'Request Details',
            guidance: 'Provide any information staff need to finish this existing request.'
        }
    }
});

function getTicketCategoryId() {
    return CONSTANTS.TICKET_CATEGORY_ID || TICKET_CATEGORY_ID || null;
}

function getTicketPingRoleId() {
    return SUPPORT_ROLE_ID;
}

function getTicketAccessRoleIds() {
    return [SUPPORT_ROLE_ID].filter(Boolean);
}

function memberIsSupportForTicket(member) {
    if (!member?.roles?.cache) return false;

    return Boolean(
        member.roles.cache.has(SUPPORT_ROLE_ID) ||
        member.roles.cache.has(CONSTANTS.ESCALATION_ROLE_ID)
    );
}

// ========== SQLITE DATABASE HELPERS ==========

function getSetting(key) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
}

function setSetting(key, value) {
    db.prepare(`
        INSERT INTO settings (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
}

function readLegacyCounter() {
    try {
        if (!fs.existsSync(CONSTANTS.LEGACY_COUNTER_FILE)) return 0;

        const data = JSON.parse(fs.readFileSync(CONSTANTS.LEGACY_COUNTER_FILE, 'utf8'));
        const value = Number(data.nextTicketId);

        if (!Number.isInteger(value) || value < 0 || value > CONSTANTS.MAX_TICKET_ID) {
            return 0;
        }

        return value;
    } catch (error) {
        console.error('[Ticket Database] Could not import the old ticket counter:', error);
        return 0;
    }
}

function initializeTicketCounter() {
    const current = getSetting('next_ticket_id');

    if (current !== null) {
        const parsed = Number(current);
        if (Number.isInteger(parsed) && parsed >= 0 && parsed <= CONSTANTS.MAX_TICKET_ID) {
            return;
        }
    }

    const importedCounter = readLegacyCounter();
    setSetting('next_ticket_id', importedCounter);

    if (fs.existsSync(CONSTANTS.LEGACY_COUNTER_FILE)) {
        console.log(`[Ticket Database] Imported old JSON counter at ${String(importedCounter).padStart(4, '0')}.`);
    }
}

function formatTicketId(id) {
    return String(id).padStart(4, '0');
}

function getCurrentTicketCounter() {
    const value = Number(getSetting('next_ticket_id'));
    return Number.isInteger(value) && value >= 0 && value <= CONSTANTS.MAX_TICKET_ID ? value : 0;
}

function getTicketOwnerId(channel) {
    if (!channel?.topic) return null;

    const newMatch = channel.topic.match(/Owner:(\d+)/i);
    if (newMatch) return newMatch[1];

    // Legacy ticket support from the previous script.
    const legacyMatch = channel.topic.match(/\((\d+)\)/);
    return legacyMatch ? legacyMatch[1] : null;
}

function getTicketId(channel) {
    if (!channel?.topic) return null;
    const match = channel.topic.match(/TicketID:(\d{4})/i);
    return match ? match[1] : null;
}

function getTicketTypeKey(channel) {
    if (!channel?.topic) return null;
    const match = channel.topic.match(/Type:([a-z_]+)/i);
    return match ? match[1].toLowerCase() : null;
}

function getTicketRecordId(channel) {
    if (!channel?.topic) return null;
    const match = channel.topic.match(/DBID:(\d+)/i);
    return match ? Number(match[1]) : null;
}

function isTicketChannel(channel) {
    if (!channel) return false;

    return Boolean(
        channel.topic?.startsWith(CONSTANTS.TICKET_TOPIC_MARKER) ||
        CONSTANTS.LEGACY_TICKET_TOPIC_MARKERS.some(marker => channel.topic?.startsWith(marker)) ||
        channel.name?.startsWith(CONSTANTS.LEGACY_TICKET_PREFIX)
    );
}

function getTicketRecord(channel) {
    const recordId = getTicketRecordId(channel);

    if (recordId) {
        const byRecordId = db.prepare('SELECT * FROM tickets WHERE record_id = ?').get(recordId);
        if (byRecordId) return byRecordId;
    }

    if (channel?.id) {
        const byChannel = db.prepare('SELECT * FROM tickets WHERE channel_id = ? ORDER BY record_id DESC LIMIT 1').get(channel.id);
        if (byChannel) return byChannel;
    }

    const ticketId = getTicketId(channel);
    if (ticketId) {
        return db.prepare(`
            SELECT * FROM tickets
            WHERE guild_id = ? AND ticket_id = ?
            ORDER BY record_id DESC
            LIMIT 1
        `).get(channel.guild?.id || GUILD_ID, ticketId) || null;
    }

    return null;
}

function isTicketIdInUse(guild, ticketId) {
    const possibleNames = Object.values(TICKET_TYPES).map(type => `${type.channelPrefix}${ticketId}`.toLowerCase());

    const channelInUse = guild.channels.cache.some(channel => {
        if (getTicketId(channel) === ticketId) return true;
        return possibleNames.includes(channel.name?.toLowerCase());
    });

    if (channelInUse) return true;

    const databaseInUse = db.prepare(`
        SELECT record_id FROM tickets
        WHERE guild_id = ? AND ticket_id = ? AND status = 'OPEN'
        LIMIT 1
    `).get(guild.id, ticketId);

    return Boolean(databaseInUse);
}

function getNextTicketId(guild) {
    let current = getCurrentTicketCounter();

    for (let attempt = 0; attempt <= CONSTANTS.MAX_TICKET_ID; attempt++) {
        const formattedId = formatTicketId(current);
        const next = (current + 1) % (CONSTANTS.MAX_TICKET_ID + 1);

        // The SQLite database is now the only source of truth for the counter.
        setSetting('next_ticket_id', next);

        if (!isTicketIdInUse(guild, formattedId)) {
            return formattedId;
        }

        current = next;
    }

    throw new Error('All ticket IDs from 0000 to 9999 are currently in use.');
}

function insertTicketRecord({
    ticketId,
    guildId,
    channelName,
    ownerId,
    typeKey,
    subject,
    purchaseDescription,
    priority = 'NORMAL',
    reopenedFromRecordId = null,
    reopenCount = 0,
}) {
    const now = Date.now();
    const normalizedPriority = PRIORITIES[String(priority || 'NORMAL').toUpperCase()] ? String(priority).toUpperCase() : 'NORMAL';

    const result = db.prepare(`
        INSERT INTO tickets (
            ticket_id, guild_id, channel_name, owner_id, type_key,
            subject, purchase_description, opened_at, status, priority,
            last_customer_message_at, reopened_from_record_id, reopen_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)
    `).run(
        ticketId,
        guildId,
        channelName,
        ownerId,
        typeKey,
        subject,
        purchaseDescription,
        now,
        normalizedPriority,
        now,
        reopenedFromRecordId,
        Number(reopenCount || 0)
    );

    return Number(result.lastInsertRowid);
}

function updateTicketChannel(recordId, channel) {
    db.prepare(`
        UPDATE tickets
        SET channel_id = ?, channel_name = ?
        WHERE record_id = ?
    `).run(channel.id, channel.name, recordId);
}

function deleteTicketRecord(recordId) {
    db.prepare('DELETE FROM tickets WHERE record_id = ?').run(recordId);
}

function changeStaffStats(guildId, userId, changes = {}) {
    if (!guildId || !userId) return;

    const claimed = Number(changes.claimed || 0);
    const closed = Number(changes.closed || 0);
    const ratingTotal = Number(changes.ratingTotal || 0);
    const ratingCount = Number(changes.ratingCount || 0);

    db.prepare(`
        INSERT INTO staff_stats (
            guild_id, user_id, tickets_claimed, tickets_closed, rating_total, rating_count
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET
            tickets_claimed = MAX(0, staff_stats.tickets_claimed + excluded.tickets_claimed),
            tickets_closed = MAX(0, staff_stats.tickets_closed + excluded.tickets_closed),
            rating_total = MAX(0, staff_stats.rating_total + excluded.rating_total),
            rating_count = MAX(0, staff_stats.rating_count + excluded.rating_count)
    `).run(guildId, userId, claimed, closed, ratingTotal, ratingCount);
}

function getStaffStats(guildId, userId) {
    return db.prepare(`
        SELECT tickets_claimed, tickets_closed, rating_total, rating_count
        FROM staff_stats
        WHERE guild_id = ? AND user_id = ?
    `).get(guildId, userId) || {
        tickets_claimed: 0,
        tickets_closed: 0,
        rating_total: 0,
        rating_count: 0,
    };
}

function getActiveAssignedTickets(guildId, userId) {
    const row = db.prepare(`
        SELECT COUNT(*) AS amount
        FROM tickets
        WHERE guild_id = ? AND status = 'OPEN' AND claimed_by = ?
    `).get(guildId, userId);

    return Number(row?.amount || 0);
}

function getPriorityMeta(priority) {
    const key = String(priority || 'NORMAL').toUpperCase();
    return PRIORITIES[key] || PRIORITIES.NORMAL;
}

function normalizePriority(priority) {
    const key = String(priority || 'NORMAL').toUpperCase();
    return PRIORITIES[key] ? key : 'NORMAL';
}

function updatePriorityField(fields, priority) {
    const meta = getPriorityMeta(priority);
    const nextFields = fields.map(field => ({
        name: field.name,
        value: field.value,
        inline: field.inline,
    }));

    const index = nextFields.findIndex(field => field.name === 'Priority');
    const priorityField = { name: 'Priority', value: meta.display, inline: true };

    if (index >= 0) {
        nextFields[index] = priorityField;
    } else {
        const statusIndex = nextFields.findIndex(field => field.name === 'Status');
        if (statusIndex >= 0) {
            nextFields.splice(statusIndex + 1, 0, priorityField);
        } else {
            nextFields.unshift(priorityField);
        }
    }

    return nextFields;
}


function updateNamedField(fields, fieldName, value, inline = true) {
    const nextFields = (fields || []).map(field => ({
        name: field.name,
        value: field.value,
        inline: field.inline,
    }));

    const index = nextFields.findIndex(field => field.name === fieldName);
    const replacement = { name: fieldName, value, inline };

    if (index >= 0) {
        nextFields[index] = replacement;
    } else {
        nextFields.push(replacement);
    }

    return nextFields;
}

function truncateEmbedValue(value, maxLength = 1000) {
    const text = String(value || 'Not provided.');
    return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function buildTicketTopic({ ownerId, typeKey, ticketId, recordId }) {
    return `${CONSTANTS.TICKET_TOPIC_MARKER} | Owner:${ownerId} | Type:${typeKey} | TicketID:${ticketId} | DBID:${recordId}`;
}

function normalizeIssueText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function calculateIssueSimilarity(first, second) {
    const a = normalizeIssueText(first);
    const b = normalizeIssueText(second);

    if (!a || !b) return 0;
    if (a === b) return 1;

    const wordsA = new Set(a.split(' ').filter(word => word.length > 2));
    const wordsB = new Set(b.split(' ').filter(word => word.length > 2));
    if (!wordsA.size || !wordsB.size) return 0;

    let intersection = 0;
    for (const word of wordsA) {
        if (wordsB.has(word)) intersection++;
    }

    const union = new Set([...wordsA, ...wordsB]).size;
    return union ? intersection / union : 0;
}

function getPendingDuplicateRequest(guildId, userId) {
    return db.prepare(`
        SELECT *
        FROM pending_ticket_requests
        WHERE guild_id = ? AND user_id = ? AND status = 'PENDING'
        ORDER BY request_id DESC
        LIMIT 1
    `).get(guildId, userId) || null;
}

function findPotentialDuplicate(guildId, userId, typeKey, subject) {
    const openTicket = db.prepare(`
        SELECT *
        FROM tickets
        WHERE guild_id = ? AND owner_id = ? AND status = 'OPEN'
        ORDER BY opened_at DESC
        LIMIT 1
    `).get(guildId, userId);

    if (openTicket) {
        const sameType = String(openTicket.type_key) === String(typeKey);
        const similarity = sameType ? calculateIssueSimilarity(subject, openTicket.subject) : 0;
        return {
            ticket: openTicket,
            reason: sameType
                ? 'The customer already has an open ticket in the same department.'
                : `The customer already has another open ${CONSTANTS.BRAND_NAME} ticket.`,
            similarity,
        };
    }

    const cutoff = Date.now() - (CONSTANTS.DUPLICATE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const recentTickets = db.prepare(`
        SELECT *
        FROM tickets
        WHERE guild_id = ?
          AND owner_id = ?
          AND type_key = ?
          AND opened_at >= ?
          AND status IN ('CLOSED', 'DELETED')
        ORDER BY opened_at DESC
        LIMIT 15
    `).all(guildId, userId, typeKey, cutoff);

    for (const ticket of recentTickets) {
        const similarity = typeKey === 'partner'
            ? 1
            : calculateIssueSimilarity(subject, ticket.subject);

        if (similarity >= CONSTANTS.DUPLICATE_SIMILARITY_THRESHOLD) {
            return {
                ticket,
                reason: `A similar ${TICKET_TYPES[typeKey]?.label || 'support'} ticket was opened recently.`,
                similarity,
            };
        }
    }

    return null;
}

function createPendingTicketRequest({ guildId, userId, typeKey, subject, purchaseDescription, duplicate }) {
    const result = db.prepare(`
        INSERT INTO pending_ticket_requests (
            guild_id, user_id, type_key, subject, purchase_description,
            duplicate_record_id, duplicate_reason, similarity_score,
            status, requested_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)
    `).run(
        guildId,
        userId,
        typeKey,
        subject,
        purchaseDescription,
        duplicate?.ticket?.record_id || null,
        duplicate?.reason || 'Possible duplicate request.',
        Number(duplicate?.similarity || 0),
        Date.now()
    );

    return Number(result.lastInsertRowid);
}

async function findTicketMainMessage(channel) {
    const messages = await channel.messages.fetch({ limit: 100 });
    return messages.find(message => {
        if (!message.embeds?.length) return false;
        const embed = message.embeds[0];
        const hasTicketId = embed.fields?.some(field => field.name === 'Ticket ID');
        const hasTicketControls = message.components?.some(row =>
            row.components?.some(component => ['claim_ticket', 'unclaim_ticket', 'close_ticket'].includes(component.customId))
        );
        return hasTicketId && hasTicketControls;
    }) || null;
}

function makeInactivityDuration(hours) {
    const numeric = Number(hours);
    return `${numeric} hour${numeric === 1 ? '' : 's'}`;
}

function makeRatingStars(rating) {
    const score = Math.max(1, Math.min(5, Number(rating) || 1));
    return `${'★'.repeat(score)}${'☆'.repeat(5 - score)}`;
}

async function reconcileOpenTickets(guild) {
    await guild.channels.fetch();

    const openTickets = db.prepare(`
        SELECT record_id, channel_id
        FROM tickets
        WHERE guild_id = ? AND status = 'OPEN'
    `).all(guild.id);

    for (const ticket of openTickets) {
        if (ticket.channel_id && !guild.channels.cache.has(ticket.channel_id)) {
            db.prepare(`
                UPDATE tickets
                SET status = 'DELETED'
                WHERE record_id = ? AND status = 'OPEN'
            `).run(ticket.record_id);
        }
    }
}

// ========== CLIENT INITIALIZATION ==========
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.Channel]
});

client.commands = new Collection();

// ========== SLASH COMMANDS ==========
const commands = [
    {
        name: 'ticket',
        description: 'Ticket management commands for support staff.',
        default_member_permissions: PermissionsBitField.Flags.ManageChannels.toString(),
        options: [
            {
                name: 'dm',
                description: 'Send a direct message to the ticket owner.',
                type: 1,
                options: [{
                    name: 'message',
                    description: 'The message to send.',
                    type: 3,
                    required: true,
                }]
            }
        ]
    },
    {
        name: 'ticketpanel',
        description: 'Post the ticket creation panel in this channel.',
        default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
    },
    {
        name: 'close',
        description: 'Close the current ticket (Claimer or Support Staff only).',
    },
    {
        name: 'add',
        description: 'Add a user to the current ticket channel.',
        options: [
            {
                name: 'user',
                description: 'The user to add to this ticket.',
                type: 6,
                required: true,
            }
        ]
    },
    {
        name: 'staffstats',
        description: 'View support staff ticket statistics.',
        default_member_permissions: PermissionsBitField.Flags.ManageChannels.toString(),
        options: [
            {
                name: 'user',
                description: 'The staff member whose statistics you want to view.',
                type: 6,
                required: false,
            }
        ]
    },
    {
        name: 'priority',
        description: 'Change the priority of the current ticket.',
        default_member_permissions: PermissionsBitField.Flags.ManageChannels.toString(),
        options: [
            {
                name: 'level',
                description: 'The new ticket priority.',
                type: 3,
                required: true,
                choices: [
                    { name: 'Low', value: 'LOW' },
                    { name: 'Normal', value: 'NORMAL' },
                    { name: 'High', value: 'HIGH' },
                    { name: 'Urgent', value: 'URGENT' },
                ]
            }
        ]
    },
    {
        name: 'transfer',
        description: 'Transfer the current ticket to another support department.',
        default_member_permissions: PermissionsBitField.Flags.ManageChannels.toString(),
        options: [
            {
                name: 'department',
                description: 'The department to transfer this ticket to.',
                type: 3,
                required: true,
                choices: [
                    { name: 'General Support', value: 'general_support' },
                    { name: 'Report', value: 'report' },
                    { name: 'Partner Support', value: 'partner' },
                ]
            }
        ]
    },
    {
        name: 'escalate',
        description: 'Escalate the current ticket to the escalation team.',
        default_member_permissions: PermissionsBitField.Flags.ManageChannels.toString(),
        options: [
            {
                name: 'reason',
                description: 'Why this ticket needs escalation.',
                type: 3,
                required: true,
                max_length: 500,
            }
        ]
    }
];

// ========== DEPLOY COMMANDS ==========
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

async function deployCommands() {
    try {
        console.log('Started refreshing application (/) commands.');
        await rest.put(
            Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
            { body: commands },
        );
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('Failed to reload application commands:', error);
    }
}

// ========== RATING SYSTEM ==========
function buildRatingButtons(recordId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`rate_ticket_${recordId}_1`).setLabel('1').setEmoji('⭐').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`rate_ticket_${recordId}_2`).setLabel('2').setEmoji('⭐').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`rate_ticket_${recordId}_3`).setLabel('3').setEmoji('⭐').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`rate_ticket_${recordId}_4`).setLabel('4').setEmoji('⭐').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`rate_ticket_${recordId}_5`).setLabel('5').setEmoji('⭐').setStyle(ButtonStyle.Primary)
    );
}

async function updateTranscriptHeaderRating(ticketRecord, rating) {
    if (!ticketRecord?.transcript_message_id) return;

    try {
        const transcriptChannel = await client.channels.fetch(TRANSCRIPT_CHANNEL_ID);
        if (!transcriptChannel?.isTextBased()) return;

        const transcriptMessage = await transcriptChannel.messages.fetch(ticketRecord.transcript_message_id);
        const originalEmbed = transcriptMessage.embeds[0];
        if (!originalEmbed) return;

        const updatedFields = originalEmbed.fields.map(field => {
            if (field.name === 'Customer Rating') {
                return {
                    name: 'Customer Rating',
                    value: `${makeRatingStars(rating)}  \`${rating}/5\``,
                    inline: true
                };
            }
            return field;
        });

        const updatedEmbed = EmbedBuilder.from(originalEmbed).setFields(updatedFields);
        await transcriptMessage.edit({ embeds: [updatedEmbed] });
    } catch (error) {
        console.error('[Rating] Could not update transcript header rating:', error);
    }
}

async function handleRatingButton(interaction) {
    const match = interaction.customId.match(/^rate_ticket_(\d+)_([1-5])$/);
    if (!match) return false;

    const recordId = Number(match[1]);
    const rating = Number(match[2]);

    const ticketRecord = db.prepare('SELECT * FROM tickets WHERE record_id = ?').get(recordId);

    if (!ticketRecord) {
        await interaction.reply({
            content: 'This rating request could not be found.',
            ephemeral: true
        });
        return true;
    }

    if (ticketRecord.owner_id !== interaction.user.id) {
        await interaction.reply({
            content: 'This rating request belongs to the user who opened the ticket.',
            ephemeral: true
        });
        return true;
    }

    if (ticketRecord.rating !== null && ticketRecord.rating !== undefined) {
        await interaction.reply({
            content: 'A rating has already been submitted for this ticket.',
            ephemeral: true
        });
        return true;
    }

    const updateResult = db.prepare(`
        UPDATE tickets
        SET rating = ?, rated_at = ?
        WHERE record_id = ? AND rating IS NULL
    `).run(rating, Date.now(), recordId);

    if (!Number(updateResult.changes || 0)) {
        await interaction.reply({
            content: 'A rating has already been submitted for this ticket.',
            ephemeral: true
        });
        return true;
    }

    const rawStaffId = ticketRecord.assigned_staff_id || ticketRecord.claimed_by || ticketRecord.closed_by;
    const staffId = rawStaffId && rawStaffId !== client.user?.id ? rawStaffId : null;

    if (staffId) {
        changeStaffStats(ticketRecord.guild_id, staffId, {
            ratingTotal: rating,
            ratingCount: 1,
        });
    }

    const ticketType = TICKET_TYPES[ticketRecord.type_key];
    const typeLabel = ticketType?.label || 'Ticket';
    const stars = makeRatingStars(rating);

    const thankYouEmbed = new EmbedBuilder()
        .setAuthor({ name: `${CONSTANTS.BRAND_NAME} Support` })
        .setColor(CONSTANTS.COLORS.DEFAULT)
        .setTitle('Thank You for Your Feedback')
        .setDescription(
            `Your rating for ticket **#${ticketRecord.ticket_id}** has been recorded.\n\n` +
            `**${stars}  ${rating}/5**`
        )
        .setFooter({ text: `${CONSTANTS.BRAND_NAME} • Support Quality` })
        .setTimestamp();

    await interaction.update({
        embeds: [thankYouEmbed],
        components: []
    });

    try {
        const ratingChannel = await client.channels.fetch(CONSTANTS.RATING_CHANNEL_ID);

        if (ratingChannel?.isTextBased()) {
            const ratingEmbed = new EmbedBuilder()
                .setAuthor({
                    name: `${CONSTANTS.BRAND_NAME} • Support Quality`,
                    iconURL: ratingChannel.guild?.iconURL({ size: 256 }) || undefined,
                })
                .setColor(CONSTANTS.COLORS.DEFAULT)
                .setTitle(`SUPPORT RATING • ${rating}/5`)
                .setDescription(
                    `A customer has submitted feedback for ticket **#${ticketRecord.ticket_id}**.\n\n` +
                    `### ${stars}`
                )
                .addFields(
                    {
                        name: 'Ticket',
                        value: `\`#${ticketRecord.ticket_id}\` • ${typeLabel}`,
                        inline: true
                    },
                    {
                        name: 'Customer',
                        value: `<@${ticketRecord.owner_id}>`,
                        inline: true
                    },
                    {
                        name: 'Staff Member',
                        value: staffId ? `<@${staffId}>` : '`Not Assigned`',
                        inline: true
                    },
                    {
                        name: 'Rating',
                        value: `**${rating}/5**`,
                        inline: true
                    },
                    {
                        name: 'Closed By',
                        value: ticketRecord.closed_by ? `<@${ticketRecord.closed_by}>` : '`Unknown`',
                        inline: true
                    },
                    {
                        name: 'Submitted',
                        value: `<t:${Math.floor(Date.now() / 1000)}:R>`,
                        inline: true
                    }
                )
                .setFooter({ text: `${CONSTANTS.BRAND_NAME} • Verified Ticket Feedback` })
                .setTimestamp();

            await ratingChannel.send({ embeds: [ratingEmbed] });
        }
    } catch (error) {
        console.error(`[Rating] Could not send rating to channel ${CONSTANTS.RATING_CHANNEL_ID}:`, error);
    }

    const refreshedTicket = db.prepare('SELECT * FROM tickets WHERE record_id = ?').get(recordId);
    await updateTranscriptHeaderRating(refreshedTicket, rating);

    console.log(`[Rating] Ticket #${ticketRecord.ticket_id} received ${rating}/5 from ${interaction.user.tag}.`);
    return true;
}


async function sendPartnerQuestionnaire(channel, userId, guild, ticketId) {
    const partnerQuestionsEmbed = new EmbedBuilder()
        .setAuthor({
            name: `${CONSTANTS.BRAND_NAME} • Partnerships`,
            iconURL: guild.iconURL({ size: 256 }) || undefined,
        })
        .setColor(CONSTANTS.COLORS.DEFAULT)
        .setTitle('PARTNERSHIP QUESTIONS')
        .setDescription(
            `Hey <@${userId}>, thanks for wanting to partner with **${CONSTANTS.BRAND_NAME}**.\n` +
            'Just a couple of quick questions to help us review your partnership request.'
        )
        .addFields(
            {
                name: '01 • What server are you from?',
                value: 'Please provide the name of the server or community you are representing.',
                inline: false
            },
            {
                name: '02 • How many members does the server have?',
                value: 'Please provide the current approximate member count.',
                inline: false
            },
            {
                name: '03 • What do we get out of the partnership?',
                value: `Explain what you can offer ${CONSTANTS.BRAND_NAME} as part of the partnership.`,
                inline: false
            },
            {
                name: '04 • For how long do you want to partner?',
                value: 'Tell us how long you would like the partnership to remain active.',
                inline: false
            }
        )
        .setFooter({ text: `${CONSTANTS.BRAND_NAME} • Partner Support • Ticket ${ticketId}` })
        .setTimestamp();

    await channel.send({
        content: `<@${userId}>`,
        embeds: [partnerQuestionsEmbed]
    });
}

async function openTicketChannel({
    guild,
    userId,
    typeKey,
    subject,
    purchaseDescription = null,
    priority = 'NORMAL',
    ticketIdOverride = null,
    reopenedFromRecordId = null,
    reopenCount = 0,
    openingStatus = 'OPEN • AWAITING STAFF',
    openingDescriptionOverride = null,
}) {
    const ticketType = TICKET_TYPES[typeKey];
    if (!ticketType) throw new Error(`Unknown ticket type: ${typeKey}`);

    const normalizedPriority = normalizePriority(priority);
    const priorityMeta = getPriorityMeta(normalizedPriority);
    const ticketId = ticketIdOverride || getNextTicketId(guild);
    const channelName = `${ticketType.channelPrefix}${ticketId}`;

    let channel = null;
    let recordId = null;

    try {
        recordId = insertTicketRecord({
            ticketId,
            guildId: guild.id,
            channelName,
            ownerId: userId,
            typeKey,
            subject,
            purchaseDescription,
            priority: normalizedPriority,
            reopenedFromRecordId,
            reopenCount,
        });

        channel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: getTicketCategoryId(typeKey),
            topic: buildTicketTopic({ ownerId: userId, typeKey, ticketId, recordId }),
            permissionOverwrites: [
                {
                    id: guild.roles.everyone.id,
                    deny: [PermissionsBitField.Flags.ViewChannel]
                },
                {
                    id: userId,
                    allow: [
                        PermissionsBitField.Flags.ViewChannel,
                        PermissionsBitField.Flags.SendMessages,
                        PermissionsBitField.Flags.ReadMessageHistory,
                        PermissionsBitField.Flags.AttachFiles
                    ]
                },
                ...getTicketAccessRoleIds(typeKey).map(roleId => ({
                    id: roleId,
                    allow: [
                        PermissionsBitField.Flags.ViewChannel,
                        PermissionsBitField.Flags.SendMessages,
                        PermissionsBitField.Flags.ReadMessageHistory,
                        PermissionsBitField.Flags.AttachFiles
                    ]
                })),
            ],
        });

        updateTicketChannel(recordId, channel);

        const createdTimestamp = Math.floor(Date.now() / 1000);
        const openingDescription = openingDescriptionOverride || ticketType.openingDescription;

        const embed = new EmbedBuilder()
            .setAuthor({
                name: `${CONSTANTS.BRAND_NAME} • Support Center`,
                iconURL: guild.iconURL({ size: 256 }) || undefined,
            })
            .setTitle(`${ticketType.emoji} ${ticketType.openingTitle}  |  #${ticketId}`)
            .setDescription(
                `${openingDescription}\n\n` +
                '> **Please keep this ticket focused on one request.** This helps our team handle it quickly and keeps the transcript easy to review.'
            )
            .setColor(priorityMeta.color)
            .addFields(
                { name: 'Ticket ID', value: `\`${ticketId}\``, inline: true },
                { name: 'Category', value: ticketType.label, inline: true },
                { name: 'Status', value: `\`${openingStatus}\``, inline: true },
                { name: 'Priority', value: priorityMeta.display, inline: true },
                { name: 'Opened By', value: `<@${userId}>`, inline: true },
                { name: 'Created', value: `<t:${createdTimestamp}:R>`, inline: true },
                { name: 'Department', value: ticketType.label, inline: true },
                {
                    name: ticketType.requestFieldName.toUpperCase(),
                    value: truncateEmbedValue(subject),
                    inline: false
                }
            )
            .setFooter({ text: `${CONSTANTS.BRAND_NAME} • ${ticketType.label} • Ticket ${ticketId}` })
            .setTimestamp();

        if (purchaseDescription) {
            embed.addFields({
                name: 'PRODUCT / SERVICE',
                value: truncateEmbedValue(purchaseDescription),
                inline: false
            });
        }

        embed.addFields({
            name: 'BEFORE YOU CONTINUE',
            value: ticketType.guidance,
            inline: false
        });

        const controls = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('claim_ticket')
                .setLabel('Claim')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('close_ticket')
                .setLabel('Close')
                .setStyle(ButtonStyle.Danger)
        );

        const pingRoleId = getTicketPingRoleId(typeKey);
        await channel.send({
            content: `<@${userId}>  |  <@&${pingRoleId}>`,
            embeds: [embed],
            components: [controls],
            allowedMentions: {
                users: [userId],
                roles: [pingRoleId]
            }
        });

        if (typeKey === 'partner') {
            await sendPartnerQuestionnaire(channel, userId, guild, ticketId);
        }

        return { channel, ticketId, recordId, channelName };
    } catch (error) {
        if (channel) {
            await channel.delete('Ticket creation failed before setup completed.').catch(() => null);
        }

        if (recordId) {
            try {
                deleteTicketRecord(recordId);
            } catch (databaseError) {
                console.error('[Ticket Database] Could not clean failed ticket record:', databaseError);
            }
        }

        throw error;
    }
}

async function submitDuplicateForApproval(interaction, typeKey, subject, purchaseDescription, duplicate) {
    const existingPending = getPendingDuplicateRequest(interaction.guild.id, interaction.user.id);
    if (existingPending) {
        return interaction.editReply({
            content: `You already have a ticket request waiting for staff approval. Review request ID: **${existingPending.request_id}**.`
        });
    }

    const approvalChannel = await client.channels.fetch(CONSTANTS.DUPLICATE_APPROVAL_CHANNEL_ID).catch(() => null);
    if (!approvalChannel?.isTextBased?.()) {
        console.error(`[Duplicate Review] Approval channel ${CONSTANTS.DUPLICATE_APPROVAL_CHANNEL_ID} could not be accessed.`);
        return interaction.editReply({
            content: 'Your request looks like a possible duplicate, but the review channel is currently unavailable. Please contact support staff.'
        });
    }

    const requestId = createPendingTicketRequest({
        guildId: interaction.guild.id,
        userId: interaction.user.id,
        typeKey,
        subject,
        purchaseDescription,
        duplicate,
    });

    const duplicateTicket = duplicate?.ticket || null;
    const duplicateType = duplicateTicket ? (TICKET_TYPES[duplicateTicket.type_key]?.label || duplicateTicket.type_key || 'Unknown') : 'Unknown';
    const duplicateTicketId = duplicateTicket?.ticket_id ? `#${duplicateTicket.ticket_id}` : 'Unknown';
    const duplicateChannel = duplicateTicket?.channel_id ? `<#${duplicateTicket.channel_id}>` : '`No active channel`';
    const similarityPercent = Math.round(Number(duplicate?.similarity || 0) * 100);

    const reviewEmbed = new EmbedBuilder()
        .setAuthor({
            name: `${CONSTANTS.BRAND_NAME} • Duplicate Review`,
            iconURL: interaction.guild.iconURL({ size: 256 }) || undefined,
        })
        .setTitle('POSSIBLE DUPLICATE TICKET')
        .setColor(PRIORITIES.HIGH.color)
        .setDescription(
            'A customer attempted to open a ticket that may duplicate an existing or recent request. ' +
            'Review the information below and choose whether the new ticket should be opened.'
        )
        .addFields(
            { name: 'Review ID', value: `\`${requestId}\``, inline: true },
            { name: 'Customer', value: `<@${interaction.user.id}>`, inline: true },
            { name: 'Requested Department', value: TICKET_TYPES[typeKey]?.label || typeKey, inline: true },
            { name: 'Possible Match', value: `${duplicateTicketId} • ${duplicateType}`, inline: true },
            { name: 'Matched Channel', value: duplicateChannel, inline: true },
            { name: 'Similarity', value: similarityPercent ? `\`${similarityPercent}%\`` : '`Open ticket detected`', inline: true },
            { name: 'Reason Flagged', value: truncateEmbedValue(duplicate?.reason || 'Possible duplicate request.'), inline: false },
            { name: 'New Request', value: truncateEmbedValue(subject), inline: false }
        )
        .setFooter({ text: `${CONSTANTS.BRAND_NAME} • Duplicate Ticket Approval` })
        .setTimestamp();

    if (purchaseDescription) {
        reviewEmbed.addFields({
            name: 'PRODUCT / SERVICE',
            value: truncateEmbedValue(purchaseDescription),
            inline: false
        });
    }

    const controls = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`duplicate_approve_${requestId}`)
            .setLabel('Approve & Open')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`duplicate_deny_${requestId}`)
            .setLabel('Deny Ticket')
            .setStyle(ButtonStyle.Danger)
    );

    let reviewMessage;
    try {
        reviewMessage = await approvalChannel.send({
            content: `<@&${SUPPORT_ROLE_ID}>`,
            embeds: [reviewEmbed],
            components: [controls],
            allowedMentions: { roles: [SUPPORT_ROLE_ID] }
        });
    } catch (error) {
        db.prepare('DELETE FROM pending_ticket_requests WHERE request_id = ?').run(requestId);
        throw error;
    }

    db.prepare(`
        UPDATE pending_ticket_requests
        SET approval_message_id = ?
        WHERE request_id = ?
    `).run(reviewMessage.id, requestId);

    return interaction.editReply({
        content:
            `Your request was flagged as a possible duplicate and has been sent to the ${CONSTANTS.BRAND_NAME} team for approval. ` +
            `Review request ID: **${requestId}**. You will be notified when it is approved or denied.`
    });
}

async function handleDuplicateApprovalButton(interaction) {
    const match = interaction.customId.match(/^duplicate_(approve|deny)_(\d+)$/);
    if (!match) return false;

    const action = match[1];
    const requestId = Number(match[2]);
    const member = interaction.member;
    const canReview = Boolean(
        member?.roles?.cache?.has(SUPPORT_ROLE_ID) ||
        member?.permissions?.has(PermissionsBitField.Flags.ManageChannels) ||
        member?.permissions?.has(PermissionsBitField.Flags.Administrator)
    );

    if (!canReview) {
        await interaction.reply({
            content: 'You do not have permission to review duplicate ticket requests.',
            ephemeral: true
        }).catch(() => null);
        return true;
    }

    const pending = db.prepare(`
        SELECT *
        FROM pending_ticket_requests
        WHERE request_id = ?
    `).get(requestId);

    if (!pending) {
        await interaction.reply({ content: 'This duplicate review request no longer exists.', ephemeral: true }).catch(() => null);
        return true;
    }

    if (pending.status !== 'PENDING') {
        await interaction.reply({
            content: `This request has already been resolved as **${pending.status}**.`,
            ephemeral: true
        }).catch(() => null);
        return true;
    }

    if (action === 'deny') {
        db.prepare(`
            UPDATE pending_ticket_requests
            SET status = 'DENIED', reviewed_by = ?, reviewed_at = ?
            WHERE request_id = ? AND status = 'PENDING'
        `).run(interaction.user.id, Date.now(), requestId);

        const deniedEmbed = interaction.message.embeds?.[0]
            ? EmbedBuilder.from(interaction.message.embeds[0])
                .setColor(CONSTANTS.COLORS.ERROR)
                .addFields({ name: 'Decision', value: `Denied by <@${interaction.user.id}>`, inline: false })
            : new EmbedBuilder().setTitle('Duplicate Ticket Denied').setColor(CONSTANTS.COLORS.ERROR);

        await interaction.update({ embeds: [deniedEmbed], components: [] });

        const customer = await client.users.fetch(pending.user_id).catch(() => null);
        if (customer) {
            const dm = new EmbedBuilder()
                .setAuthor({ name: `${CONSTANTS.BRAND_NAME} Support` })
                .setTitle('Ticket Request Not Opened')
                .setColor(CONSTANTS.COLORS.ERROR)
                .setDescription(
                    `Your support request was reviewed and was not opened because it appears to duplicate an existing or recent ticket.\n\n` +
                    `Review ID: \`${requestId}\``
                )
                .setFooter({ text: `${CONSTANTS.BRAND_NAME} • Duplicate Review` })
                .setTimestamp();
            await customer.send({ embeds: [dm] }).catch(() => null);
        }

        return true;
    }

    await interaction.deferUpdate();

    try {
        const guild = await client.guilds.fetch(pending.guild_id).catch(() => null);
        if (!guild) throw new Error('Guild not found for duplicate approval.');

        const memberRecord = await guild.members.fetch(pending.user_id).catch(() => null);
        if (!memberRecord) throw new Error('Customer is no longer a member of the server.');

        await guild.channels.fetch();

        const result = await openTicketChannel({
            guild,
            userId: pending.user_id,
            typeKey: pending.type_key,
            subject: pending.subject,
            purchaseDescription: pending.purchase_description,
        });

        db.prepare(`
            UPDATE pending_ticket_requests
            SET status = 'APPROVED', reviewed_by = ?, reviewed_at = ?
            WHERE request_id = ? AND status = 'PENDING'
        `).run(interaction.user.id, Date.now(), requestId);

        const approvedEmbed = interaction.message.embeds?.[0]
            ? EmbedBuilder.from(interaction.message.embeds[0])
                .setColor(CONSTANTS.COLORS.SUCCESS)
                .addFields(
                    { name: 'Decision', value: `Approved by <@${interaction.user.id}>`, inline: true },
                    { name: 'Opened Ticket', value: `<#${result.channel.id}>`, inline: true }
                )
            : new EmbedBuilder().setTitle('Duplicate Ticket Approved').setColor(CONSTANTS.COLORS.SUCCESS);

        await interaction.message.edit({ embeds: [approvedEmbed], components: [] });

        const customer = await client.users.fetch(pending.user_id).catch(() => null);
        if (customer) {
            const dm = new EmbedBuilder()
                .setAuthor({ name: `${CONSTANTS.BRAND_NAME} Support` })
                .setTitle('Ticket Request Approved')
                .setColor(CONSTANTS.COLORS.SUCCESS)
                .setDescription(`Your request was approved and ticket **#${result.ticketId}** has been opened.`)
                .addFields({ name: 'Open Ticket', value: `<#${result.channel.id}>`, inline: true })
                .setFooter({ text: `${CONSTANTS.BRAND_NAME} • Duplicate Review` })
                .setTimestamp();
            await customer.send({ embeds: [dm] }).catch(() => null);
        }
    } catch (error) {
        console.error(`[Duplicate Review] Could not approve request ${requestId}:`, error);

        const failedEmbed = interaction.message.embeds?.[0]
            ? EmbedBuilder.from(interaction.message.embeds[0])
                .setColor(CONSTANTS.COLORS.ERROR)
                .addFields({ name: 'Approval Error', value: truncateEmbedValue(error.message || 'Unknown error.'), inline: false })
            : new EmbedBuilder().setTitle('Duplicate Approval Failed').setColor(CONSTANTS.COLORS.ERROR);

        await interaction.message.edit({ embeds: [failedEmbed], components: interaction.message.components }).catch(() => null);
    }

    return true;
}

// ========== TICKET SYSTEM ==========
async function closeTicket(interaction, channel, closerUser, options = {}) {
    try {
        const transcriptChannel = await client.channels.fetch(TRANSCRIPT_CHANNEL_ID);
        const closeReason = options.closeReason || 'Closed by support staff.';
        const autoClose = Boolean(options.autoClose);
        const closerId = closerUser?.id || client.user?.id || null;
        const closerTag = closerUser?.tag || `${CONSTANTS.BRAND_NAME} Automation`;

        const ticketOwnerId = getTicketOwnerId(channel) || 'N/A';
        const ticketOwner = await client.users.fetch(ticketOwnerId).catch(() => ({
            tag: 'Unknown User',
            id: ticketOwnerId,
            send: async () => null,
        }));

        const ticketId = getTicketId(channel) || channel.name;
        const typeKey = getTicketTypeKey(channel);
        const typeLabel = TICKET_TYPES[typeKey]?.label || 'Legacy Ticket';
        let ticketRecord = getTicketRecord(channel);

        // New Eternity tickets always have a database record. This fallback keeps
        // transcript/rating support working for older ticket channels as well.
        if (!ticketRecord && ticketOwnerId !== 'N/A') {
            const fallbackRecordId = insertTicketRecord({
                ticketId: String(ticketId).slice(-32),
                guildId: channel.guild.id,
                channelName: channel.name,
                ownerId: ticketOwnerId,
                typeKey: typeKey || 'legacy',
                subject: 'Legacy ticket imported when closed.',
                purchaseDescription: null,
            });

            updateTicketChannel(fallbackRecordId, channel);
            ticketRecord = db.prepare('SELECT * FROM tickets WHERE record_id = ?').get(fallbackRecordId);
        }

        const claimedBy = ticketRecord?.claimed_by || null;
        const assignedStaffId = claimedBy || ticketRecord?.assigned_staff_id || (!autoClose ? closerId : null);
        const openedAt = ticketRecord?.opened_at || channel.createdTimestamp || Date.now();
        const closedAt = Date.now();
        const priority = normalizePriority(ticketRecord?.priority);
        const priorityMeta = getPriorityMeta(priority);

        if (ticketRecord) {
            db.prepare(`
                UPDATE tickets
                SET status = 'CLOSED',
                    assigned_staff_id = ?,
                    closed_by = ?,
                    closed_at = ?
                WHERE record_id = ?
            `).run(assignedStaffId, closerId, closedAt, ticketRecord.record_id);
        }

        if (!options.skipStaffStats && closerId && closerId !== client.user?.id) {
            changeStaffStats(channel.guild.id, closerId, { closed: 1 });
        }

        const attachment = await discordTranscripts.createTranscript(channel, {
            filename: `TicketCore-Transcript-${ticketId}.html`,
            saveImages: true,
            poweredBy: false,
            footerText: `${CONSTANTS.BRAND_NAME} Support • Ticket ${ticketId}`,
        });

        // Professional transcript header shown above the HTML transcript.
        const transcriptEmbed = new EmbedBuilder()
            .setAuthor({
                name: `${CONSTANTS.BRAND_NAME} • Transcript Archive`,
                iconURL: channel.guild.iconURL({ size: 256 }) || undefined,
            })
            .setTitle(`${CONSTANTS.BRAND_NAME} • TRANSCRIPT #${ticketId}`)
            .setColor(priorityMeta.color)
            .setDescription('Official archived support transcript. The attached HTML file contains the complete ticket conversation.')
            .addFields(
                { name: 'Ticket ID', value: `\`${ticketId}\``, inline: true },
                { name: 'Category', value: typeLabel, inline: true },
                { name: 'Priority', value: priorityMeta.display, inline: true },
                { name: 'Status', value: '`CLOSED • ARCHIVED`', inline: true },
                { name: 'Opened By', value: `<@${ticketOwner.id}>`, inline: true },
                { name: 'Handled By', value: assignedStaffId ? `<@${assignedStaffId}>` : '`Not Claimed`', inline: true },
                { name: 'Closed By', value: closerId ? `<@${closerId}>` : '`Automation`', inline: true },
                { name: 'Opened At', value: `<t:${Math.floor(openedAt / 1000)}:F>`, inline: true },
                { name: 'Closed At', value: `<t:${Math.floor(closedAt / 1000)}:F>`, inline: true },
                { name: 'Close Reason', value: closeReason, inline: false },
                { name: 'Customer Rating', value: '`Awaiting Rating`', inline: true }
            )
            .setFooter({ text: `${CONSTANTS.BRAND_NAME} • Secure Transcript Archive` })
            .setTimestamp();

        if (Number(ticketRecord?.transfer_count || 0) > 0) {
            transcriptEmbed.addFields({
                name: 'Transfers',
                value: `\`${Number(ticketRecord.transfer_count)}\``,
                inline: true
            });
        }

        if (ticketRecord?.escalated_at) {
            transcriptEmbed.addFields(
                {
                    name: 'Escalated By',
                    value: ticketRecord.escalated_by ? `<@${ticketRecord.escalated_by}>` : '`Unknown`',
                    inline: true
                },
                {
                    name: 'Escalated At',
                    value: `<t:${Math.floor(Number(ticketRecord.escalated_at) / 1000)}:F>`,
                    inline: true
                },
                {
                    name: 'Escalation Reason',
                    value: truncateEmbedValue(ticketRecord.escalation_reason || 'No reason stored.'),
                    inline: false
                }
            );
        }

        const transcriptMessage = await transcriptChannel.send({
            embeds: [transcriptEmbed],
            files: [attachment]
        });

        if (ticketRecord) {
            db.prepare(`
                UPDATE tickets
                SET transcript_message_id = ?
                WHERE record_id = ?
            `).run(transcriptMessage.id, ticketRecord.record_id);
        }

        const closeDescription = autoClose
            ? `Your **${typeLabel}** ticket was closed automatically because we did not receive a customer response within **${makeInactivityDuration(CONSTANTS.INACTIVITY_CLOSE_HOURS)}**.`
            : `Your **${typeLabel}** ticket has been closed by **${closerTag}**.`;

        const dmCloseEmbed = new EmbedBuilder()
            .setAuthor({
                name: `${CONSTANTS.BRAND_NAME} Support`,
                iconURL: channel.guild.iconURL({ size: 256 }) || undefined,
            })
            .setTitle('Your Ticket Has Been Closed')
            .setColor(priorityMeta.color)
            .setDescription(
                `${closeDescription}\n\n` +
                'A copy of the transcript is attached below. You can rate the support you received or reopen the ticket during the reopen window.'
            )
            .addFields(
                { name: 'Ticket ID', value: `\`${ticketId}\``, inline: true },
                { name: 'Category', value: typeLabel, inline: true },
                { name: 'Priority', value: priorityMeta.display, inline: true },
                { name: 'Rating', value: '`Select 1-5 stars below`', inline: true },
                { name: 'Reopen Window', value: `\`${makeInactivityDuration(CONSTANTS.REOPEN_WINDOW_HOURS)}\``, inline: true },
                { name: 'Close Reason', value: closeReason, inline: false }
            )
            .setFooter({ text: `${CONSTANTS.BRAND_NAME} • Support Quality` })
            .setTimestamp();

        const dmPayload = {
            embeds: [dmCloseEmbed],
            files: [attachment],
        };

        if (ticketRecord?.record_id) {
            dmPayload.components = [
                buildRatingButtons(ticketRecord.record_id),
                buildReopenButton(ticketRecord.record_id),
            ];
        }

        await ticketOwner.send(dmPayload)
            .catch(() => console.log(`[Ticket Close] Could not DM transcript/rating request to ${ticketOwner.tag}.`));

        if (interaction?.isChatInputCommand?.() && interaction.deferred) {
            await interaction.editReply({
                content: 'Ticket closed successfully. The transcript has been saved and this channel will be deleted in 3 seconds.'
            });
        }

        const deleteDelayMs = Number(options.deleteDelayMs || 3000);
        setTimeout(() => {
            channel.delete(`Ticket closed by ${closerTag}.`)
                .catch(err => console.error('[Ticket Delete] Failed to delete channel:', err));
        }, deleteDelayMs);

    } catch (error) {
        console.error('[Ticket Close] Failed to save transcript or close ticket:', error);
        const errorMsg = 'There was a critical error saving the transcript. Please close this ticket manually to prevent data loss.';

        if (interaction?.isChatInputCommand?.() && interaction.deferred) {
            await interaction.editReply({ content: errorMsg });
        } else if (channel?.isTextBased?.()) {
            await channel.send(errorMsg).catch(() => null);
        }
    }
}

function buildReopenButton(recordId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`reopen_ticket_${recordId}`)
            .setLabel('Reopen Ticket')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('♻️')
    );
}

async function handleReopenButton(interaction) {
    const match = interaction.customId.match(/^reopen_ticket_(\d+)$/);
    if (!match) return false;

    const closedRecordId = Number(match[1]);
    const closedRecord = db.prepare('SELECT * FROM tickets WHERE record_id = ?').get(closedRecordId);

    if (!closedRecord) {
        await interaction.reply({ content: 'This ticket record could not be found.' }).catch(() => null);
        return true;
    }

    if (String(closedRecord.owner_id) !== String(interaction.user.id)) {
        await interaction.reply({ content: 'Only the user who opened this ticket can reopen it.' }).catch(() => null);
        return true;
    }

    if (closedRecord.status !== 'CLOSED' || !closedRecord.closed_at) {
        await interaction.reply({ content: 'This ticket is not currently eligible to be reopened.' }).catch(() => null);
        return true;
    }

    const reopenWindowMs = CONSTANTS.REOPEN_WINDOW_HOURS * 60 * 60 * 1000;
    if ((Date.now() - Number(closedRecord.closed_at)) > reopenWindowMs) {
        await interaction.reply({
            content: `The reopen window for this ticket has expired. Tickets can be reopened for ${makeInactivityDuration(CONSTANTS.REOPEN_WINDOW_HOURS)} after closure.`
        }).catch(() => null);
        return true;
    }

    const alreadyReopened = db.prepare(`
        SELECT record_id
        FROM tickets
        WHERE reopened_from_record_id = ?
        LIMIT 1
    `).get(closedRecordId);

    if (alreadyReopened) {
        await interaction.reply({ content: 'This closed ticket has already been reopened.' }).catch(() => null);
        return true;
    }

    const guild = await client.guilds.fetch(closedRecord.guild_id || GUILD_ID).catch(() => null);
    if (!guild) {
        await interaction.reply({ content: `The ${CONSTANTS.BRAND_NAME} support server could not be found.` }).catch(() => null);
        return true;
    }

    const member = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member) {
        await interaction.reply({ content: 'You must still be a member of the server to reopen this ticket.' }).catch(() => null);
        return true;
    }

    await guild.channels.fetch();
    const existingChannel = guild.channels.cache.find(existing =>
        isTicketChannel(existing) && getTicketOwnerId(existing) === interaction.user.id
    );

    if (existingChannel) {
        await interaction.reply({ content: `You already have an open ticket: <#${existingChannel.id}>` }).catch(() => null);
        return true;
    }

    const typeKey = closedRecord.type_key;
    const ticketType = TICKET_TYPES[typeKey];
    if (!ticketType) {
        await interaction.reply({ content: 'This ticket type can no longer be reopened automatically.' }).catch(() => null);
        return true;
    }

    const ticketId = String(closedRecord.ticket_id).padStart(4, '0');

    if (isTicketIdInUse(guild, ticketId)) {
        await interaction.reply({
            content: `Ticket ID **#${ticketId}** is currently in use by another open ticket, so this closed ticket cannot be reopened with the same ID.`
        }).catch(() => null);
        return true;
    }

    const channelName = `${ticketType.channelPrefix}${ticketId}`;
    const priority = normalizePriority(closedRecord.priority);
    const priorityMeta = getPriorityMeta(priority);
    const reopenCount = Number(closedRecord.reopen_count || 0) + 1;

    let channel = null;
    let newRecordId = null;

    try {
        newRecordId = insertTicketRecord({
            ticketId,
            guildId: guild.id,
            channelName,
            ownerId: interaction.user.id,
            typeKey,
            subject: closedRecord.subject,
            purchaseDescription: closedRecord.purchase_description,
            priority,
            reopenedFromRecordId: closedRecordId,
            reopenCount,
        });

        const topic = `${CONSTANTS.TICKET_TOPIC_MARKER} | Owner:${interaction.user.id} | Type:${typeKey} | TicketID:${ticketId} | DBID:${newRecordId}`;

        channel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: getTicketCategoryId(typeKey),
            topic,
            permissionOverwrites: [
                { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                {
                    id: interaction.user.id,
                    allow: [
                        PermissionsBitField.Flags.ViewChannel,
                        PermissionsBitField.Flags.SendMessages,
                        PermissionsBitField.Flags.ReadMessageHistory,
                        PermissionsBitField.Flags.AttachFiles
                    ]
                },
                ...getTicketAccessRoleIds(typeKey).map(roleId => ({
                    id: roleId,
                    allow: [
                        PermissionsBitField.Flags.ViewChannel,
                        PermissionsBitField.Flags.SendMessages,
                        PermissionsBitField.Flags.ReadMessageHistory,
                        PermissionsBitField.Flags.AttachFiles
                    ]
                })),
            ],
        });

        updateTicketChannel(newRecordId, channel);

        const reopenedTimestamp = Math.floor(Date.now() / 1000);
        const reopenEmbed = new EmbedBuilder()
            .setAuthor({
                name: `${CONSTANTS.BRAND_NAME} • Support Center`,
                iconURL: guild.iconURL({ size: 256 }) || undefined,
            })
            .setTitle(`${ticketType.emoji} ${ticketType.openingTitle}  |  #${ticketId}`)
            .setColor(priorityMeta.color)
            .setDescription(
                `Ticket **#${ticketId}** has been reopened and routed back to **${ticketType.label}**.\n\n` +
                '> A support team member will review the reopened request as soon as possible.'
            )
            .addFields(
                { name: 'Ticket ID', value: `\`${ticketId}\``, inline: true },
                { name: 'Category', value: ticketType.label, inline: true },
                { name: 'Status', value: '`REOPENED • AWAITING STAFF`', inline: true },
                { name: 'Priority', value: priorityMeta.display, inline: true },
                { name: 'Opened By', value: `<@${interaction.user.id}>`, inline: true },
                { name: 'Reopened', value: `<t:${reopenedTimestamp}:R>`, inline: true },
                { name: 'Reopen Count', value: `\`${reopenCount}\``, inline: true },
                {
                    name: ticketType.requestFieldName.toUpperCase(),
                    value: closedRecord.subject || 'No request details stored.',
                    inline: false
                }
            )
            .setFooter({ text: `${CONSTANTS.BRAND_NAME} • ${ticketType.label} • Ticket ${ticketId}` })
            .setTimestamp();

        if (closedRecord.purchase_description) {
            reopenEmbed.addFields({
                name: 'PRODUCT / SERVICE',
                value: closedRecord.purchase_description,
                inline: false
            });
        }

        const controls = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('claim_ticket').setLabel('Claim').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('close_ticket').setLabel('Close').setStyle(ButtonStyle.Danger)
        );

        await channel.send({
            content: `<@${interaction.user.id}>  |  <@&${getTicketPingRoleId(typeKey)}>`,
            embeds: [reopenEmbed],
            components: [controls]
        });

        await interaction.reply({
            content: `Ticket **#${ticketId}** has been reopened: <#${channel.id}>`
        }).catch(() => null);

        console.log(`[Ticket Reopen] ${interaction.user.tag} reopened ticket #${ticketId} as DB record ${newRecordId}.`);
    } catch (error) {
        console.error('[Ticket Reopen] Failed to reopen ticket:', error);

        if (channel) {
            await channel.delete('Ticket reopen failed before setup completed.').catch(() => null);
        }
        if (newRecordId) {
            deleteTicketRecord(newRecordId);
        }

        await interaction.reply({ content: 'An error occurred while reopening your ticket.' }).catch(() => null);
    }

    return true;
}

async function createTicket(interaction, typeKey, subject, purchaseDescription = null) {
    const user = interaction.user;
    const guild = interaction.guild;
    const ticketType = TICKET_TYPES[typeKey];

    await interaction.deferReply({ ephemeral: true });

    if (!ticketType) {
        return interaction.editReply({ content: 'Invalid ticket category selected.' });
    }

    try {
        await guild.channels.fetch();

        const existingPending = getPendingDuplicateRequest(guild.id, user.id);
        if (existingPending) {
            return interaction.editReply({
                content: `You already have a ticket request waiting for staff approval. Review request ID: **${existingPending.request_id}**.`
            });
        }

        let duplicate = findPotentialDuplicate(guild.id, user.id, typeKey, subject);

        // Legacy/open channels that are not in the database are still treated as
        // possible duplicates and routed to the approval queue instead of being blocked.
        if (!duplicate) {
            const existingChannel = guild.channels.cache.find(existing =>
                isTicketChannel(existing) && getTicketOwnerId(existing) === user.id
            );

            if (existingChannel) {
                duplicate = {
                    ticket: {
                        record_id: null,
                        ticket_id: getTicketId(existingChannel) || existingChannel.name,
                        type_key: getTicketTypeKey(existingChannel) || 'legacy',
                        channel_id: existingChannel.id,
                    },
                    reason: `The customer already has another open ${CONSTANTS.BRAND_NAME} ticket.`,
                    similarity: 0,
                };
            }
        }

        if (duplicate) {
            return submitDuplicateForApproval(interaction, typeKey, subject, purchaseDescription, duplicate);
        }

        const result = await openTicketChannel({
            guild,
            userId: user.id,
            typeKey,
            subject,
            purchaseDescription,
        });

        const createdEmbed = new EmbedBuilder()
            .setAuthor({
                name: `${CONSTANTS.BRAND_NAME} • Support Center`,
                iconURL: guild.iconURL({ size: 256 }) || undefined,
            })
            .setColor(CONSTANTS.COLORS.DEFAULT)
            .setTitle('Ticket Created Successfully')
            .setDescription(`Your **${ticketType.label}** request is now open and ready for review.`)
            .addFields(
                { name: 'Ticket', value: `\`${result.channelName}\``, inline: true },
                { name: 'ID', value: `\`${result.ticketId}\``, inline: true },
                { name: 'Open Ticket', value: `<#${result.channel.id}>`, inline: true }
            )
            .setFooter({ text: `${CONSTANTS.BRAND_NAME} • Secure Support System` })
            .setTimestamp();

        return interaction.editReply({ embeds: [createdEmbed] });
    } catch (error) {
        console.error('[Ticket Creation] Failed to create ticket:', error);
        return interaction.editReply({
            content: 'An error occurred while creating your ticket. Please ensure the bot has the correct permissions and try again later.'
        });
    }
}

// ========== CUSTOMER INACTIVITY TRACKER ==========
const inactivityClosingTickets = new Set();
let inactivityInterval = null;

async function recordTicketMessageActivity(message) {
    if (!message?.guild || !message.channel || message.author?.bot) return;
    if (!isTicketChannel(message.channel)) return;

    const ticketRecord = getTicketRecord(message.channel);
    if (!ticketRecord || ticketRecord.status !== 'OPEN') return;

    const now = Date.now();

    if (String(message.author.id) === String(ticketRecord.owner_id)) {
        db.prepare(`
            UPDATE tickets
            SET last_customer_message_at = ?,
                inactivity_warned_at = NULL
            WHERE record_id = ? AND status = 'OPEN'
        `).run(now, ticketRecord.record_id);
        return;
    }

    const isSupport = memberIsSupportForTicket(message.member, message.channel);
    if (isSupport) {
        db.prepare(`
            UPDATE tickets
            SET last_staff_message_at = ?,
                inactivity_warned_at = NULL
            WHERE record_id = ? AND status = 'OPEN'
        `).run(now, ticketRecord.record_id);
    }
}

async function checkCustomerInactivity() {
    if (!db || !client.isReady()) return;

    const warnMs = CONSTANTS.INACTIVITY_WARN_HOURS * 60 * 60 * 1000;
    const closeMs = CONSTANTS.INACTIVITY_CLOSE_HOURS * 60 * 60 * 1000;
    const now = Date.now();

    const waitingTickets = db.prepare(`
        SELECT *
        FROM tickets
        WHERE guild_id = ?
          AND status = 'OPEN'
          AND last_staff_message_at IS NOT NULL
          AND last_staff_message_at > COALESCE(last_customer_message_at, 0)
    `).all(GUILD_ID);

    for (const ticket of waitingTickets) {
        const staffMessageAt = Number(ticket.last_staff_message_at || 0);
        if (!staffMessageAt) continue;

        const inactiveFor = now - staffMessageAt;
        const channelId = ticket.channel_id;
        if (!channelId) continue;

        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased?.()) {
            db.prepare(`
                UPDATE tickets
                SET status = 'DELETED'
                WHERE record_id = ? AND status = 'OPEN'
            `).run(ticket.record_id);
            continue;
        }

        if (inactiveFor >= closeMs) {
            if (inactivityClosingTickets.has(ticket.record_id)) continue;
            inactivityClosingTickets.add(ticket.record_id);

            try {
                const ticketId = ticket.ticket_id || getTicketId(channel) || channel.name;
                const autoCloseEmbed = new EmbedBuilder()
                    .setAuthor({
                        name: `${CONSTANTS.BRAND_NAME} • Inactivity System`,
                        iconURL: channel.guild.iconURL({ size: 256 }) || undefined,
                    })
                    .setTitle('Ticket Closed for Inactivity')
                    .setColor(PRIORITIES.HIGH.color)
                    .setDescription(
                        `<@${ticket.owner_id}>, ticket **#${ticketId}** is being closed because no customer response was received within ` +
                        `**${makeInactivityDuration(CONSTANTS.INACTIVITY_CLOSE_HOURS)}** after the latest staff response.`
                    )
                    .setFooter({ text: `${CONSTANTS.BRAND_NAME} • Customer Inactivity Protection` })
                    .setTimestamp();

                await channel.send({ content: `<@${ticket.owner_id}>`, embeds: [autoCloseEmbed] }).catch(() => null);

                await closeTicket(null, channel, client.user, {
                    autoClose: true,
                    skipStaffStats: true,
                    closeReason: `Automatically closed after ${makeInactivityDuration(CONSTANTS.INACTIVITY_CLOSE_HOURS)} without a customer response.`,
                    deleteDelayMs: 5000,
                });
            } catch (error) {
                console.error(`[Inactivity] Failed to auto-close ticket record ${ticket.record_id}:`, error);
            } finally {
                inactivityClosingTickets.delete(ticket.record_id);
            }

            continue;
        }

        if (inactiveFor >= warnMs && !ticket.inactivity_warned_at) {
            const remainingHours = Math.max(1, CONSTANTS.INACTIVITY_CLOSE_HOURS - CONSTANTS.INACTIVITY_WARN_HOURS);
            const ticketId = ticket.ticket_id || getTicketId(channel) || channel.name;
            const priorityMeta = getPriorityMeta(ticket.priority);

            const warningEmbed = new EmbedBuilder()
                .setAuthor({
                    name: `${CONSTANTS.BRAND_NAME} • Inactivity System`,
                    iconURL: channel.guild.iconURL({ size: 256 }) || undefined,
                })
                .setTitle('Customer Response Required')
                .setColor(priorityMeta.color === PRIORITIES.LOW.color ? PRIORITIES.HIGH.color : priorityMeta.color)
                .setDescription(
                    `<@${ticket.owner_id}>, we are still waiting for your response in ticket **#${ticketId}**.\n\n` +
                    `If there is no response within the next **${makeInactivityDuration(remainingHours)}**, this ticket will be closed automatically.`
                )
                .addFields(
                    { name: 'Inactive For', value: `\`${makeInactivityDuration(CONSTANTS.INACTIVITY_WARN_HOURS)}+\``, inline: true },
                    { name: 'Auto-Close At', value: `<t:${Math.floor((staffMessageAt + closeMs) / 1000)}:R>`, inline: true }
                )
                .setFooter({ text: `${CONSTANTS.BRAND_NAME} • Reply in this ticket to reset the inactivity timer` })
                .setTimestamp();

            const sent = await channel.send({
                content: `<@${ticket.owner_id}>`,
                embeds: [warningEmbed]
            }).catch(error => {
                console.error(`[Inactivity] Could not warn ticket #${ticketId}:`, error);
                return null;
            });

            if (sent) {
                db.prepare(`
                    UPDATE tickets
                    SET inactivity_warned_at = ?
                    WHERE record_id = ? AND status = 'OPEN'
                `).run(now, ticket.record_id);
            }
        }
    }
}

function startInactivityTracker() {
    if (inactivityInterval) return;

    const intervalMs = CONSTANTS.INACTIVITY_CHECK_MINUTES * 60 * 1000;
    console.log(
        `[Inactivity] Warning after ${CONSTANTS.INACTIVITY_WARN_HOURS}h, auto-close after ${CONSTANTS.INACTIVITY_CLOSE_HOURS}h, ` +
        `checking every ${CONSTANTS.INACTIVITY_CHECK_MINUTES} minute(s).`
    );

    setTimeout(() => {
        checkCustomerInactivity().catch(error => console.error('[Inactivity] Initial check failed:', error));
    }, 10000);

    inactivityInterval = setInterval(() => {
        checkCustomerInactivity().catch(error => console.error('[Inactivity] Scheduled check failed:', error));
    }, intervalMs);

    inactivityInterval.unref?.();
}

// ========== EVENT HANDLERS ==========
client.once(Events.ClientReady, async (c) => {
    console.log(`Logged in as ${c.user.tag}`);
    console.log(`[Ticket Database] Driver: ${DATABASE_DRIVER}`);
    console.log(`[Ticket Database] File: ${CONSTANTS.DATABASE_FILE}`);
    console.log(`[Ticket Database] Next ticket ID: ${formatTicketId(getCurrentTicketCounter())}`);
    console.log(`[Ticket Ratings] Log channel: ${CONSTANTS.RATING_CHANNEL_ID}`);

    try {
        const guild = await client.guilds.fetch(GUILD_ID);
        await reconcileOpenTickets(guild);
    } catch (error) {
        console.error('[Ticket Database] Could not reconcile open tickets:', error);
    }

    startInactivityTracker();
});

client.on(Events.Error, (error) => {
    console.error('Discord Client Error:', error);
});

client.on(Events.MessageCreate, async (message) => {
    try {
        await recordTicketMessageActivity(message);
    } catch (error) {
        console.error('[Inactivity] Could not record ticket message activity:', error);
    }
});

client.on(Events.ChannelDelete, (channel) => {
    if (!channel?.id) return;

    try {
        db.prepare(`
            UPDATE tickets
            SET status = 'DELETED'
            WHERE channel_id = ? AND status = 'OPEN'
        `).run(channel.id);
    } catch (error) {
        console.error('[Ticket Database] Could not mark deleted ticket:', error);
    }
});

client.on(Events.InteractionCreate, async (interaction) => {
    try {
        if (interaction.isButton() && interaction.customId.startsWith('rate_ticket_')) {
            await handleRatingButton(interaction);
            return;
        }

        if (interaction.isButton() && interaction.customId.startsWith('reopen_ticket_')) {
            await handleReopenButton(interaction);
            return;
        }

        if (interaction.isButton() && interaction.customId.startsWith('duplicate_')) {
            await handleDuplicateApprovalButton(interaction);
            return;
        }

        if (interaction.isChatInputCommand()) {
            await handleCommand(interaction);
        } else if (interaction.isStringSelectMenu()) {
            await handleSelectMenu(interaction);
        } else if (interaction.isModalSubmit()) {
            await handleModal(interaction);
        } else if (interaction.isButton()) {
            await handleButton(interaction);
        }
    } catch (error) {
        console.error('[Interaction] Unhandled interaction error:', error);

        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: 'An unexpected error occurred while processing that action.',
                ephemeral: true
            }).catch(() => null);
        }
    }
});

async function handleCommand(interaction) {
    const { commandName, member, channel } = interaction;
    const isSupport = memberIsSupportForTicket(member, channel);

    if (commandName === 'ticketpanel') {
        const panelEmbed = new EmbedBuilder()
            .setAuthor({
                name: `${CONSTANTS.BRAND_NAME} Support`,
                iconURL: interaction.guild.iconURL({ size: 256 }) || undefined,
            })
            .setTitle(`${CONSTANTS.BRAND_NAME} • SUPPORT CENTER`)
            .setColor(CONSTANTS.COLORS.DEFAULT)
            .setDescription(
                'Need assistance? Select the department that best matches your request below.\n\n' +
                '> Choose one category only. Opening duplicate tickets may delay your response.'
            )
            .addFields(
                {
                    name: '🔷  GENERAL SUPPORT',
                    value: '`Questions • Technical Help • Account Support`\nFor general assistance or anything that does not fit another department.',
                    inline: false
                },
                {
                    name: '🚨  REPORT',
                    value: '`Users • Incidents • Evidence`\nFor reporting users, suspicious activity, abuse, scams, or other concerns.',
                    inline: false
                },
                {
                    name: '🤝  PARTNER',
                    value: '`Partnerships • Collaborations • Partner Support`\nFor partnership proposals, collaboration requests, or existing partner assistance.',
                    inline: false
                }
            )
            .setFooter({ text: `${CONSTANTS.BRAND_NAME} • Support Center` })
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('select_ticket_category')
                .setPlaceholder('Select a support category...')
                .addOptions([
                    {
                        label: 'General Support',
                        description: 'General questions and technical assistance',
                        value: 'general_support',
                        emoji: '🔷'
                    },
                    {
                        label: 'Report',
                        description: 'Report a user, incident or other concern',
                        value: 'report',
                        emoji: '🚨'
                    },
                    {
                        label: 'Partner',
                        description: 'Partnerships and collaboration requests',
                        value: 'partner',
                        emoji: '🤝'
                    },
                ])
        );

        await interaction.channel.send({ embeds: [panelEmbed], components: [row] });
        return interaction.reply({ content: 'Ticket panel posted successfully.', ephemeral: true });
    }

    if (commandName === 'staffstats') {
        if (!isSupport && !member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.reply({
                content: 'You do not have permission to view staff statistics.',
                ephemeral: true
            });
        }

        const targetUser = interaction.options.getUser('user') || interaction.user;
        const stats = getStaffStats(interaction.guild.id, targetUser.id);
        const activeTickets = getActiveAssignedTickets(interaction.guild.id, targetUser.id);
        const ratingCount = Number(stats.rating_count || 0);
        const averageRating = ratingCount > 0
            ? (Number(stats.rating_total || 0) / ratingCount).toFixed(2)
            : 'N/A';

        const ratingDisplay = ratingCount > 0
            ? `**${averageRating}/5**\n${makeRatingStars(Math.round(Number(averageRating)))}`
            : '`No ratings yet`';

        const statsEmbed = new EmbedBuilder()
            .setAuthor({
                name: `${CONSTANTS.BRAND_NAME} • Staff Performance`,
                iconURL: interaction.guild.iconURL({ size: 256 }) || undefined,
            })
            .setColor(CONSTANTS.COLORS.DEFAULT)
            .setTitle(`${CONSTANTS.BRAND_NAME} • STAFF STATISTICS`)
            .setDescription(`Support performance overview for <@${targetUser.id}>.`)
            .addFields(
                { name: 'Tickets Claimed', value: `\`${Number(stats.tickets_claimed || 0)}\``, inline: true },
                { name: 'Tickets Closed', value: `\`${Number(stats.tickets_closed || 0)}\``, inline: true },
                { name: 'Currently Assigned', value: `\`${activeTickets}\``, inline: true },
                { name: 'Average Rating', value: ratingDisplay, inline: true },
                { name: 'Ratings Received', value: `\`${ratingCount}\``, inline: true },
                { name: 'Staff Member', value: `<@${targetUser.id}>`, inline: true }
            )
            .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
            .setFooter({ text: `${CONSTANTS.BRAND_NAME} • Support Statistics` })
            .setTimestamp();

        return interaction.reply({ embeds: [statsEmbed] });
    }

    if (commandName === 'priority') {
        if (!isTicketChannel(channel)) {
            return interaction.reply({
                content: 'This command can only be used inside a ticket channel.',
                ephemeral: true
            });
        }

        if (!isSupport && !member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.reply({
                content: 'You do not have permission to change ticket priority.',
                ephemeral: true
            });
        }

        const ticketRecord = getTicketRecord(channel);
        if (!ticketRecord) {
            return interaction.reply({
                content: 'This ticket does not have a database record, so its priority cannot be changed.',
                ephemeral: true
            });
        }

        const priority = normalizePriority(interaction.options.getString('level'));
        const priorityMeta = getPriorityMeta(priority);

        db.prepare(`
            UPDATE tickets
            SET priority = ?
            WHERE record_id = ?
        `).run(priority, ticketRecord.record_id);

        try {
            const ticketMessage = await findTicketMainMessage(channel);
            if (ticketMessage?.embeds?.[0]) {
                const originalEmbed = ticketMessage.embeds[0];
                const updatedEmbed = EmbedBuilder.from(originalEmbed)
                    .setColor(priorityMeta.color)
                    .setFields(updatePriorityField(originalEmbed.fields || [], priority));

                await ticketMessage.edit({ embeds: [updatedEmbed] });
            }
        } catch (error) {
            console.error('[Priority] Could not update the main ticket embed:', error);
        }

        return interaction.reply({
            content: `Ticket priority changed to **${priorityMeta.label}**.`,
            ephemeral: true
        });
    }

    if (commandName === 'transfer') {
        if (!isTicketChannel(channel)) {
            return interaction.reply({
                content: 'This command can only be used inside a ticket channel.',
                ephemeral: true
            });
        }

        if (!isSupport && !member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.reply({
                content: 'You do not have permission to transfer tickets.',
                ephemeral: true
            });
        }

        const ticketRecord = getTicketRecord(channel);
        if (!ticketRecord || ticketRecord.status !== 'OPEN') {
            return interaction.reply({
                content: 'This ticket does not have an active database record.',
                ephemeral: true
            });
        }

        const targetTypeKey = interaction.options.getString('department');
        const targetType = TICKET_TYPES[targetTypeKey];
        const currentTypeKey = ticketRecord.type_key;
        const currentType = TICKET_TYPES[currentTypeKey];

        if (!targetType) {
            return interaction.reply({ content: 'Invalid destination department.', ephemeral: true });
        }

        if (currentTypeKey === targetTypeKey) {
            return interaction.reply({
                content: `This ticket is already assigned to **${targetType.label}**.`,
                ephemeral: true
            });
        }

        await interaction.deferReply({ ephemeral: true });

        try {
            const ticketId = String(ticketRecord.ticket_id || getTicketId(channel) || '').padStart(4, '0');
            const newChannelName = `${targetType.channelPrefix}${ticketId}`;
            const newTopic = buildTicketTopic({
                ownerId: ticketRecord.owner_id,
                typeKey: targetTypeKey,
                ticketId,
                recordId: ticketRecord.record_id,
            });

            // Update the channel name, topic, and department category in one Discord API request.
            // Keeping this as a single edit avoids unnecessary per-channel edit rate limits
            // when staff transfer the same ticket more than once.
            await channel.edit({
                name: newChannelName,
                topic: newTopic,
                parent: getTicketCategoryId(targetTypeKey),
                reason: `Ticket transferred by ${interaction.user.tag}`
            });

            db.prepare(`
                UPDATE tickets
                SET type_key = ?,
                    channel_name = ?,
                    transfer_count = COALESCE(transfer_count, 0) + 1
                WHERE record_id = ?
            `).run(targetTypeKey, newChannelName, ticketRecord.record_id);

            const ticketMessage = await findTicketMainMessage(channel).catch(() => null);
            if (ticketMessage?.embeds?.[0]) {
                const originalEmbed = ticketMessage.embeds[0];
                const oldRequestName = currentType?.requestFieldName?.toUpperCase();
                const newRequestName = targetType.requestFieldName.toUpperCase();

                let fields = (originalEmbed.fields || []).map(field => {
                    if (field.name === 'Category') {
                        return { name: 'Category', value: targetType.label, inline: true };
                    }
                    if (field.name === 'Department') {
                        return { name: 'Department', value: targetType.label, inline: true };
                    }
                    if (oldRequestName && field.name === oldRequestName) {
                        return { name: newRequestName, value: field.value, inline: false };
                    }
                    return { name: field.name, value: field.value, inline: field.inline };
                });

                const updatedEmbed = EmbedBuilder.from(originalEmbed)
                    .setTitle(`${targetType.emoji} ${targetType.openingTitle}  |  #${ticketId}`)
                    .setDescription(
                        `${targetType.openingDescription}\n\n` +
                        `> This ticket was transferred from **${currentType?.label || currentTypeKey}** to **${targetType.label}** by <@${interaction.user.id}>.`
                    )
                    .setFields(fields)
                    .setFooter({ text: `${CONSTANTS.BRAND_NAME} • ${targetType.label} • Ticket ${ticketId}` });

                await ticketMessage.edit({ embeds: [updatedEmbed] });
            }

            const transferEmbed = new EmbedBuilder()
                .setAuthor({
                    name: `${CONSTANTS.BRAND_NAME} • Ticket Transfer`,
                    iconURL: interaction.guild.iconURL({ size: 256 }) || undefined,
                })
                .setTitle('Ticket Transferred')
                .setColor(CONSTANTS.COLORS.DEFAULT)
                .setDescription(`Ticket **#${ticketId}** has been transferred to **${targetType.label}**.`)
                .addFields(
                    { name: 'From', value: currentType?.label || currentTypeKey, inline: true },
                    { name: 'To', value: targetType.label, inline: true },
                    { name: 'Transferred By', value: `<@${interaction.user.id}>`, inline: true }
                )
                .setFooter({ text: `${CONSTANTS.BRAND_NAME} • Ticket Management` })
                .setTimestamp();

            // Keep ticket permissions correct after transfers.
            // All current Eternity ticket departments use the normal Support role.
            const baseOverwrites = [
                {
                    id: interaction.guild.roles.everyone.id,
                    deny: [PermissionsBitField.Flags.ViewChannel]
                },
                {
                    id: ticketRecord.owner_id,
                    allow: [
                        PermissionsBitField.Flags.ViewChannel,
                        PermissionsBitField.Flags.SendMessages,
                        PermissionsBitField.Flags.ReadMessageHistory,
                        PermissionsBitField.Flags.AttachFiles
                    ]
                },
            ];

            const departmentRoleIds = getTicketAccessRoleIds(targetTypeKey);
            for (const roleId of departmentRoleIds) {
                baseOverwrites.push({
                    id: roleId,
                    allow: [
                        PermissionsBitField.Flags.ViewChannel,
                        PermissionsBitField.Flags.SendMessages,
                        PermissionsBitField.Flags.ReadMessageHistory,
                        PermissionsBitField.Flags.AttachFiles
                    ]
                });
            }

            await channel.permissionOverwrites.set(
                baseOverwrites,
                `Ticket department permissions updated by ${interaction.user.tag}`
            );

            await channel.send({ embeds: [transferEmbed] });

            if (targetTypeKey === 'partner' && currentTypeKey !== 'partner') {
                await sendPartnerQuestionnaire(channel, ticketRecord.owner_id, interaction.guild, ticketId);
            }

            return interaction.editReply({
                content: `Ticket transferred to **${targetType.label}** and renamed to \`${newChannelName}\`.`
            });
        } catch (error) {
            console.error('[Ticket Transfer] Failed:', error);
            return interaction.editReply({
                content: 'The ticket could not be transferred. Check the bot\'s Manage Channels permissions and try again.'
            });
        }
    }

    if (commandName === 'escalate') {
        if (!isTicketChannel(channel)) {
            return interaction.reply({
                content: 'This command can only be used inside a ticket channel.',
                ephemeral: true
            });
        }

        if (!isSupport && !member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.reply({
                content: 'You do not have permission to escalate tickets.',
                ephemeral: true
            });
        }

        const ticketRecord = getTicketRecord(channel);
        if (!ticketRecord || ticketRecord.status !== 'OPEN') {
            return interaction.reply({
                content: 'This ticket does not have an active database record.',
                ephemeral: true
            });
        }

        if (ticketRecord.escalated_at) {
            return interaction.reply({
                content: `This ticket was already escalated by <@${ticketRecord.escalated_by || '0'}>.`,
                ephemeral: true
            });
        }

        const reason = interaction.options.getString('reason');
        const escalationRole = interaction.guild.roles.cache.get(CONSTANTS.ESCALATION_ROLE_ID)
            || await interaction.guild.roles.fetch(CONSTANTS.ESCALATION_ROLE_ID).catch(() => null);

        if (!escalationRole) {
            return interaction.reply({
                content: `The escalation role (${CONSTANTS.ESCALATION_ROLE_ID}) could not be found.`,
                ephemeral: true
            });
        }

        await interaction.deferReply({ ephemeral: true });

        try {
            const escalatedAt = Date.now();
            const ticketId = ticketRecord.ticket_id || getTicketId(channel) || channel.name;

            await channel.permissionOverwrites.edit(escalationRole.id, {
                ViewChannel: true,
                SendMessages: true,
                ReadMessageHistory: true,
                AttachFiles: true,
            }, `Ticket escalated by ${interaction.user.tag}`);

            db.prepare(`
                UPDATE tickets
                SET priority = 'URGENT',
                    escalated_by = ?,
                    escalated_at = ?,
                    escalation_reason = ?
                WHERE record_id = ?
            `).run(interaction.user.id, escalatedAt, reason, ticketRecord.record_id);

            const ticketMessage = await findTicketMainMessage(channel).catch(() => null);
            if (ticketMessage?.embeds?.[0]) {
                const originalEmbed = ticketMessage.embeds[0];
                let fields = updatePriorityField(originalEmbed.fields || [], 'URGENT');
                fields = updateNamedField(fields, 'Status', '`ESCALATED • MANAGEMENT REVIEW`', true);

                const updatedEmbed = EmbedBuilder.from(originalEmbed)
                    .setColor(PRIORITIES.URGENT.color)
                    .setFields(fields);

                await ticketMessage.edit({ embeds: [updatedEmbed] });
            }

            const escalationEmbed = new EmbedBuilder()
                .setAuthor({
                    name: `${CONSTANTS.BRAND_NAME} • Escalation`,
                    iconURL: interaction.guild.iconURL({ size: 256 }) || undefined,
                })
                .setTitle(`URGENT ESCALATION • #${ticketId}`)
                .setColor(PRIORITIES.URGENT.color)
                .setDescription('This ticket has been escalated and requires review from the escalation team.')
                .addFields(
                    { name: 'Escalated By', value: `<@${interaction.user.id}>`, inline: true },
                    { name: 'Escalation Team', value: `<@&${CONSTANTS.ESCALATION_ROLE_ID}>`, inline: true },
                    { name: 'Priority', value: PRIORITIES.URGENT.display, inline: true },
                    { name: 'Reason', value: truncateEmbedValue(reason), inline: false }
                )
                .setFooter({ text: `${CONSTANTS.BRAND_NAME} • Escalation System` })
                .setTimestamp();

            await channel.send({
                content: `<@&${CONSTANTS.ESCALATION_ROLE_ID}>`,
                embeds: [escalationEmbed],
                allowedMentions: { roles: [CONSTANTS.ESCALATION_ROLE_ID] }
            });

            return interaction.editReply({
                content: `Ticket **#${ticketId}** has been escalated and <@&${CONSTANTS.ESCALATION_ROLE_ID}> has been notified.`,
                allowedMentions: { roles: [] }
            });
        } catch (error) {
            console.error('[Ticket Escalation] Failed:', error);
            return interaction.editReply({
                content: 'The ticket could not be escalated. Check the bot\'s role and channel permissions and try again.'
            });
        }
    }

    if (commandName === 'ticket') {
        if (!isTicketChannel(channel)) {
            return interaction.reply({
                content: 'This command can only be used inside a ticket channel.',
                ephemeral: true
            });
        }

        if (!isSupport) {
            return interaction.reply({
                content: 'You do not have permission to use this command.',
                ephemeral: true
            });
        }

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'dm') {
            const ticketOwnerId = getTicketOwnerId(channel);

            if (!ticketOwnerId) {
                return interaction.reply({
                    content: 'Could not identify the ticket owner.',
                    ephemeral: true
                });
            }

            const ticketOwner = await client.users.fetch(ticketOwnerId).catch(() => null);
            const message = interaction.options.getString('message');
            const ticketId = getTicketId(channel) || channel.name;

            if (ticketOwner) {
                try {
                    const dmEmbed = new EmbedBuilder()
                        .setAuthor({
                            name: `${CONSTANTS.BRAND_NAME} Support`,
                            iconURL: interaction.guild.iconURL({ size: 256 }) || undefined,
                        })
                        .setTitle('Support Message')
                        .setDescription(
                            `You have received a message from **${interaction.user.tag}** regarding ticket **#${ticketId}**.\n\n` +
                            `> ${message}`
                        )
                        .setColor(CONSTANTS.COLORS.DEFAULT)
                        .setFooter({ text: `${CONSTANTS.BRAND_NAME} • Ticket #${ticketId}` })
                        .setTimestamp();

                    await ticketOwner.send({ embeds: [dmEmbed] });
                    await interaction.reply({
                        content: `Message sent to ${ticketOwner.tag}.`,
                        ephemeral: true
                    });
                } catch {
                    await interaction.reply({
                        content: 'Could not DM the user.',
                        ephemeral: true
                    });
                }
            } else {
                await interaction.reply({
                    content: 'Could not find the ticket owner.',
                    ephemeral: true
                });
            }
        }
    }

    if (commandName === 'close') {
        if (!isTicketChannel(channel)) {
            return interaction.reply({
                content: 'This command can only be used inside a ticket channel.',
                ephemeral: true
            });
        }

        let isClaimer = false;

        if (!isSupport) {
            const ticketRecord = getTicketRecord(channel);
            isClaimer = ticketRecord?.claimed_by === member.id;

            if (!isClaimer) {
                const messages = await channel.messages.fetch({ limit: 10 });
                const ticketMessage = messages.find(message =>
                    message.embeds.length > 0 &&
                    message.embeds[0].fields &&
                    message.embeds[0].fields.some(field => field.name === 'Status')
                );

                if (ticketMessage) {
                    const claimedByField = ticketMessage.embeds[0].fields.find(field => field.name === 'Claimed By');
                    isClaimer = claimedByField && claimedByField.value === `<@${member.id}>`;
                }
            }

            if (!isClaimer) {
                return interaction.reply({
                    content: 'You must be the claimer of this ticket or have the Support role to close it.',
                    ephemeral: true
                });
            }
        }

        await interaction.deferReply({ ephemeral: true });
        await closeTicket(interaction, channel, interaction.user);
    }

    if (commandName === 'add') {
        if (!isTicketChannel(channel)) {
            return interaction.reply({
                content: 'This command can only be used inside a ticket channel.',
                ephemeral: true
            });
        }

        const ticketOwnerId = getTicketOwnerId(channel);
        const isOwner = ticketOwnerId === member.id;

        let isClaimer = false;
        const ticketRecord = getTicketRecord(channel);
        if (ticketRecord?.claimed_by === member.id) {
            isClaimer = true;
        } else {
            const messages = await channel.messages.fetch({ limit: 10 });
            const ticketMessage = messages.find(message =>
                message.embeds.length > 0 &&
                message.embeds[0].fields &&
                message.embeds[0].fields.some(field => field.name === 'Status')
            );

            if (ticketMessage) {
                const claimedByField = ticketMessage.embeds[0].fields.find(field => field.name === 'Claimed By');
                isClaimer = claimedByField && claimedByField.value === `<@${member.id}>`;
            }
        }

        if (!isSupport && !isOwner && !isClaimer) {
            return interaction.reply({
                content: 'You must be the ticket owner, the claimer, or have the Support role to add users to this ticket.',
                ephemeral: true
            });
        }

        const targetUser = interaction.options.getUser('user');
        const permissions = channel.permissionsFor(targetUser.id);

        if (permissions && permissions.has(PermissionsBitField.Flags.ViewChannel)) {
            return interaction.reply({
                content: `<@${targetUser.id}> already has access to this ticket channel.`,
                ephemeral: true
            });
        }

        try {
            await channel.permissionOverwrites.edit(targetUser.id, {
                ViewChannel: true,
                SendMessages: true,
                ReadMessageHistory: true,
                AttachFiles: true
            });

            const ticketId = getTicketId(channel) || channel.name;
            const addEmbed = new EmbedBuilder()
                .setTitle('User Added to Ticket')
                .setDescription(`<@${targetUser.id}> has been granted access to ticket **#${ticketId}** by <@${interaction.user.id}>.`)
                .setColor(CONSTANTS.COLORS.DEFAULT)
                .setFooter({ text: `${CONSTANTS.BRAND_NAME} • Ticket Management` })
                .setTimestamp();

            await interaction.reply({ embeds: [addEmbed] });
            await channel.send({
                content: `<@${targetUser.id}>, you have been added to this ticket by <@${interaction.user.id}>.`
            });

            console.log(`[Ticket Add] ${interaction.user.tag} added ${targetUser.tag} to ${channel.name}`);
        } catch (error) {
            console.error('[Ticket Add] Failed to add user:', error);
            await interaction.reply({
                content: 'An error occurred while adding the user to this ticket. Please ensure the bot has the correct permissions.',
                ephemeral: true
            });
        }
    }
}

async function handleButton(interaction) {
    const { customId, channel, member } = interaction;
    const isSupport = memberIsSupportForTicket(member, channel);

    if (!isSupport && ['claim_ticket', 'unclaim_ticket', 'close_ticket', 'confirm_close_ticket'].includes(customId)) {
        return interaction.reply({
            content: 'You do not have permission to use these buttons.',
            ephemeral: true
        });
    }

    if (!isTicketChannel(channel) && customId !== 'cancel_close') {
        return interaction.reply({
            content: 'This button can only be used inside a ticket channel.',
            ephemeral: true
        });
    }

    if (customId === 'claim_ticket') {
        const originalEmbed = interaction.message.embeds[0];

        if (originalEmbed.fields.some(field => field.name === 'Claimed By')) {
            return interaction.reply({
                content: 'This ticket has already been claimed.',
                ephemeral: true
            });
        }

        const updatedFields = originalEmbed.fields.map(field => {
            if (field.name === 'Status') {
                return { name: 'Status', value: '`IN PROGRESS • CLAIMED`', inline: true };
            }
            return field;
        });

        updatedFields.push({
            name: 'Claimed By',
            value: `<@${interaction.user.id}>`,
            inline: true
        });

        const newEmbed = EmbedBuilder.from(originalEmbed).setFields(updatedFields);
        const newButtons = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('unclaim_ticket')
                .setLabel('Unclaim')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('↩️'),
            new ButtonBuilder()
                .setCustomId('close_ticket')
                .setLabel('Close')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('✖️')
        );

        const ticketRecord = getTicketRecord(channel);
        if (ticketRecord) {
            db.prepare(`
                UPDATE tickets
                SET claimed_by = ?, claimed_at = ?, assigned_staff_id = ?
                WHERE record_id = ? AND status = 'OPEN'
            `).run(interaction.user.id, Date.now(), interaction.user.id, ticketRecord.record_id);

            changeStaffStats(channel.guild.id, interaction.user.id, { claimed: 1 });
        }

        await interaction.message.edit({ embeds: [newEmbed], components: [newButtons] });

        return interaction.reply({
            content: `Ticket claimed by <@${interaction.user.id}>.`,
            ephemeral: false
        });
    }

    if (customId === 'unclaim_ticket') {
        const originalEmbed = interaction.message.embeds[0];
        const claimedByField = originalEmbed.fields.find(field => field.name === 'Claimed By');

        if (!claimedByField) {
            return interaction.reply({
                content: 'This ticket is not currently claimed.',
                ephemeral: true
            });
        }

        const ticketRecord = getTicketRecord(channel);
        const previousClaimer = ticketRecord?.claimed_by || claimedByField.value.match(/<@(\d+)>/)?.[1] || null;

        const updatedFields = originalEmbed.fields
            .filter(field => field.name !== 'Claimed By')
            .map(field => {
                if (field.name === 'Status') {
                    return { name: 'Status', value: '`OPEN • AWAITING STAFF`', inline: true };
                }
                return field;
            });

        const newEmbed = EmbedBuilder.from(originalEmbed).setFields(updatedFields);
        const newButtons = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('claim_ticket')
                .setLabel('Claim')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('✅'),
            new ButtonBuilder()
                .setCustomId('close_ticket')
                .setLabel('Close')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('✖️')
        );

        if (ticketRecord) {
            db.prepare(`
                UPDATE tickets
                SET claimed_by = NULL,
                    claimed_at = NULL,
                    assigned_staff_id = NULL
                WHERE record_id = ? AND status = 'OPEN'
            `).run(ticketRecord.record_id);
        }

        if (previousClaimer) {
            changeStaffStats(channel.guild.id, previousClaimer, { claimed: -1 });
        }

        await interaction.message.edit({ embeds: [newEmbed], components: [newButtons] });

        return interaction.reply({
            content: `Ticket unclaimed by <@${interaction.user.id}>.`,
            ephemeral: false
        });
    }

    if (customId === 'close_ticket') {
        const ticketId = getTicketId(channel) || channel.name;

        const confirmEmbed = new EmbedBuilder()
            .setAuthor({
                name: `${CONSTANTS.BRAND_NAME} • Ticket Management`,
                iconURL: channel.guild.iconURL({ size: 256 }) || undefined,
            })
            .setTitle('Close Ticket')
            .setColor(CONSTANTS.COLORS.DEFAULT)
            .setDescription(
                `Are you sure you want to close ticket **#${ticketId}**?\n\n` +
                'A branded transcript will be generated, the ticket will be archived, and the customer will receive a rating request.'
            )
            .setFooter({ text: `${CONSTANTS.BRAND_NAME} • Ticket Management` });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('confirm_close_ticket')
                .setLabel('Confirm Close')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('✅'),
            new ButtonBuilder()
                .setCustomId('cancel_close')
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('✖️')
        );

        return interaction.reply({
            embeds: [confirmEmbed],
            components: [row],
            ephemeral: true,
        });
    }

    if (customId === 'confirm_close_ticket') {
        await interaction.update({
            content: 'Saving transcript and closing ticket...',
            embeds: [],
            components: []
        });
        await closeTicket(interaction, channel, interaction.user);
    }

    if (customId === 'cancel_close') {
        await interaction.update({
            content: 'Ticket closure cancelled.',
            embeds: [],
            components: []
        });
    }
}

async function handleSelectMenu(interaction) {
    const { customId, values } = interaction;

    if (customId === 'select_ticket_category') {
        const category = values[0];
        const ticketType = TICKET_TYPES[category];

        if (!ticketType) {
            return interaction.reply({
                content: 'Invalid ticket category selected.',
                ephemeral: true
            });
        }

        // Partner tickets open immediately. The user answers the dedicated
        // partnership questionnaire inside the newly created ticket channel.
        if (category === 'partner') {
            return createTicket(interaction, 'partner', 'Partnership Application');
        }

        const modal = new ModalBuilder()
            .setCustomId(`ticket_modal_${category}`)
            .setTitle(`${ticketType.label} Ticket`);

        let subjectLabel = 'How can we help you?';
        let subjectPlaceholder = 'Describe your request in as much detail as possible...';

        if (category === 'report') {
            subjectLabel = 'What are you reporting?';
            subjectPlaceholder = 'Describe what happened and include the important details...';
        }

        const subjectInput = new TextInputBuilder()
            .setCustomId('ticket_subject')
            .setLabel(subjectLabel)
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder(subjectPlaceholder)
            .setMinLength(10)
            .setMaxLength(1000)
            .setRequired(true);

        const subjectRow = new ActionRowBuilder().addComponents(subjectInput);
        modal.addComponents(subjectRow);

        await interaction.showModal(modal);
    }
}

async function handleModal(interaction) {
    const { customId } = interaction;

    if (customId.startsWith('ticket_modal_')) {
        const category = customId.replace('ticket_modal_', '');
        const ticketType = TICKET_TYPES[category];

        if (!ticketType) {
            return interaction.reply({
                content: 'Invalid ticket category.',
                ephemeral: true
            });
        }

        const subject = interaction.fields.getTextInputValue('ticket_subject');

        await createTicket(interaction, category, subject, null);
    }
}

async function startBot() {
    try {
        await initializeDatabase();
        await deployCommands();
        await client.login(DISCORD_TOKEN);
    } catch (error) {
        console.error('FATAL: Bot startup failed.', error);
        process.exit(1);
    }
}

startBot();
