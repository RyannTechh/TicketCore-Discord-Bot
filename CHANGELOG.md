# Changelog

## 1.4.1 — 2026-10-25

First public TicketCore distribution of the owner's supplied running Eternity bot.

- Preserve the complete ticket workflow, SQLite schema/migrations, staff tools, transcripts, ratings, duplicate review, transfers, escalation, reopening, and inactivity tracking.
- Move every hardcoded role/channel ID into validated environment configuration.
- Add configurable community branding and database location.
- Use TicketCore branding and new ticket topics while recognizing legacy Eternity/Spector topics and keeping existing interaction IDs.
- Request Message Content Intent for transcript content; document required Discord intent settings.
- Add setup/migration documentation, a blank environment template, exclusions for private runtime data, an MIT license, and offline regression checks.
- Update compatible dependencies to address the audit findings; pin the working transcript renderer to 3.2.0 and override its HTTP dependency to patched undici 6.29.1 or newer. The original manifest reported 1.4.0; 1.4.1 identifies this public release.

No production credentials, ticket data, or transcripts are distributed.
