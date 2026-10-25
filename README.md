# TicketCore Discord Bot

A self-hosted Discord ticket bot with private support channels, HTML transcripts, staff tools, customer ratings, and persistent SQLite history. Built with discord.js v14 and sql.js.

**Version 1.4.1 · MIT License · One Discord server per instance**

## Features

- General Support, Report, and Partner departments, with a partnership questionnaire.
- Private ticket channels with a persistent, collision-aware 0000–9999 ticket counter.
- Claim/unclaim controls, confirmation before button-based closure, and staff statistics.
- Low, Normal, High, and Urgent priorities; department transfers and escalation.
- Duplicate detection with a staff approval/denial queue.
- HTML transcripts archived to a staff channel and sent to the ticket owner by DM.
- One-time 1–5 star ratings linked to staff statistics and transcript headers.
- Reopen buttons, defaulting to a 48-hour window after closure.
- Customer inactivity warnings after 48 hours and automatic closure after 72 hours, measured from the latest unanswered staff message.
- Legacy Eternity/Spector ticket recognition and database migrations. Existing Store/Nitro records remain readable and closable; those departments are not offered for new tickets.

## Quick start

1. Install Node.js **22.12 or newer** (tested on Node.js 24.21.0).
2. Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications).
3. Enable **Server Members Intent** and **Message Content Intent** on the bot's settings page. Follow Discord's approval requirements if your application needs privileged-intent review. Message content access is needed for complete transcripts; see [Discord's intent documentation](https://docs.discord.com/developers/events/gateway#privileged-intents).
4. Invite the bot with the `bot` and `applications.commands` scopes. Grant View Channels, Send Messages, Read Message History, Embed Links, Attach Files, Manage Channels, and Manage Roles (for channel permission overwrites). Place its role above the roles it needs to manage. Assign the configured Support role to the bot itself so it can access newly created private tickets.
5. Create a ticket category, Support and Escalation roles, and transcript, rating, and duplicate-review text channels. Keep review and transcript channels staff-only: they contain ticket content and user identifiers.
6. Download or clone this repository and install the locked dependencies:

```sh
git clone https://github.com/RyannTechh/TicketCore-Discord-Bot.git
cd TicketCore-Discord-Bot
npm ci
```

Copy `.env.example` to `.env` (`cp .env.example .env` on Linux/macOS, or `Copy-Item .env.example .env` in PowerShell). Fill in every required value, then run:

```sh
npm start
```

On startup the bot creates/loads its database and refreshes this application's guild slash commands. Use a dedicated bot application: this refresh replaces its command list in the configured server. Run `/ticketpanel` in the channel where members should open tickets.

## Configuration

Enable Developer Mode in Discord to copy server, role, category, and channel IDs. IDs are text, not names. Never put the bot token in source code or an issue.

| Required variable | Purpose |
| --- | --- |
| `DISCORD_TOKEN` | Bot token from the Developer Portal |
| `CLIENT_ID` | Application ID |
| `GUILD_ID` | Server ID |
| `SUPPORT_ROLE_ID` | Support staff role; also assign it to the bot |
| `TICKET_CATEGORY_ID` | Category for all new, reopened, and transferred tickets |
| `TRANSCRIPT_CHANNEL_ID` | Staff-only transcript archive |
| `RATING_CHANNEL_ID` | Rating log channel |
| `ESCALATION_ROLE_ID` | Escalation team role |
| `DUPLICATE_APPROVAL_CHANNEL_ID` | Staff-only duplicate review channel |

| Optional variable | Default |
| --- | --- |
| `BRAND_NAME` | `TicketCore` (maximum 80 characters) |
| `DATABASE_FILE` | `ticketcore-tickets.sqlite` in the bot directory |
| `TICKET_DUPLICATE_LOOKBACK_DAYS` | `30` |
| `TICKET_DUPLICATE_SIMILARITY_THRESHOLD` | `0.60` (range 0.25–1) |
| `TICKET_INACTIVITY_WARN_HOURS` | `48` |
| `TICKET_INACTIVITY_CLOSE_HOURS` | `72`; must exceed the warning time |
| `TICKET_INACTIVITY_CHECK_MINUTES` | `10` |
| `TICKET_REOPEN_WINDOW_HOURS` | `48` |

An existing open ticket always enters duplicate review. Recent closed/deleted tickets in the same department are compared by word overlap; recent Partner requests are treated as duplicates automatically. Inactivity timers apply only while a staff reply is awaiting a customer response.

`DATABASE_FILE` may be absolute or relative to the bot folder. Its parent directory must already exist and be writable. Run only one process per database file; sql.js writes the database back to disk after changes. Configure persistent storage on a container or hosting panel.

## Commands and controls

| Command | Purpose |
| --- | --- |
| `/ticketpanel` | Post the department selector (Administrator by default) |
| `/close` | Close a ticket (support staff or its claimer) |
| `/add user` | Add a participant (owner, claimer, or support staff) |
| `/staffstats [user]` | Show staff ticket counts and ratings |
| `/priority level` | Change priority |
| `/transfer department` | Move a ticket between current departments |
| `/escalate reason` | Give the escalation team access and mark Urgent |
| `/ticket dm message` | DM the ticket owner |

Staff commands have Discord command-permission defaults as well as runtime role checks. Adjust access under Server Settings → Integrations for your Support role where necessary. Ticket buttons provide Claim, Unclaim, and Close. Customer DMs provide rating and reopen controls; DM delivery depends on the customer's privacy settings.

## Migrating an existing Eternity instance

1. Stop the old bot and make a private backup of its database and environment configuration.
2. Install TicketCore in a separate directory. Keep the same application, server, and staff/channel IDs in your private `.env`; copy the four formerly hardcoded IDs into their corresponding variables.
3. Copy the existing database privately and set `DATABASE_FILE=eternity-tickets.sqlite` (or its actual path). Do not start with an empty database if you need existing ticket history, ratings, or reopen buttons.
4. Optionally set `BRAND_NAME` to your community name. Enable Message Content Intent before starting this release.
5. Start only the new instance. Existing `ETERNITY_TICKET` and `SPECTOR_TICKET` topics remain recognized; new tickets use `TICKETCORE_TICKET`. The existing `ticket-counter.json` import remains available for older deployments.

The database schema, department keys, slash commands, and button IDs are retained. Database migrations add missing columns without clearing records.

## Privacy and operation

The public repository contains no live token, server-specific IDs, ticket database, or transcripts. `.gitignore` excludes common credentials, database files, transcripts, logs, and backups. If you choose a custom database filename without a usual database extension, add it to `.gitignore` yourself.

Ticket history stores user IDs, request details, assignment history, timestamps, and ratings. Transcripts include conversation content and images. Restrict archive access, keep backups private, and establish a retention policy appropriate to your community. Do not upload production archives to GitHub. Rotate any token that has been publicly exposed.

This release preserves the supplied bot's workflows. Transfers rebuild channel permissions, so manually added participants and escalation access may need to be reapplied afterward. If transcript generation fails during closure, the channel stays available for manual recovery; inspect the ticket/database status before retrying. Discord rate limits, attachment limits, and DM privacy settings still apply.

## Development and verification

```sh
npm run check
npm test
```

Tests run offline with synthetic identities and an isolated temporary database; they never log in to Discord. They cover configuration validation, ticket lifecycle helpers, SQLite persistence, legacy recognition, and duplicate/rating/reopen behavior. Live Discord permissions and delivery require a staging-server check before deployment.

## Release provenance

Version 1.4.1 is the public packaging of the owner's running source supplied on 25 October 2026. The source archive's package manifest still identified itself as 1.4.0; this release does not claim that metadata proved an earlier 1.4.1 build. The complete original script was retained with configuration, branding, and message-content intent changes; it was not replaced with a smaller implementation. See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE) © 2026 RyannTechh. Dependency licenses remain with their respective authors.
