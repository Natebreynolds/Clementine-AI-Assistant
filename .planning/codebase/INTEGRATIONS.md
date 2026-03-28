# External Integrations

**Analysis Date:** 2026-03-27

## APIs & External Services

**Chat Platforms:**
- Discord - Personal assistant bot
  - SDK/Client: discord.js 14.18.0
  - Auth: DISCORD_TOKEN (in src/config.ts via getSecret)
  - Features: Slash commands, streaming responses, DM-only, message reactions
  - Implementation: `src/channels/discord.ts`, `src/channels/discord-agent-bot.ts`

- Slack - Team collaboration bot
  - SDK/Client: @slack/bolt 4.2.0
  - Auth: SLACK_BOT_TOKEN, SLACK_APP_TOKEN
  - Features: Socket Mode (no public URL), markdown conversion, message chunking
  - Implementation: `src/channels/slack.ts`, `src/channels/slack-agent-bot.ts`

- Telegram - Messaging bot
  - SDK/Client: grammy 1.35.0
  - Auth: TELEGRAM_BOT_TOKEN
  - Features: Text-based interaction
  - Implementation: `src/channels/telegram.ts`

- WhatsApp (via Twilio)
  - SDK/Client: twilio 5.5.0
  - Auth: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
  - Features: Webhook receiver (Express), signature validation, chunked sending
  - Implementation: `src/channels/whatsapp.ts`
  - Webhook Port: WHATSAPP_WEBHOOK_PORT (default 8421)

**AI & LLM:**
- Anthropic Claude API
  - SDK: @anthropic-ai/sdk 0.78.0, @anthropic-ai/claude-agent-sdk 0.2.81
  - Auth: ANTHROPIC_API_KEY (in src/config.ts)
  - Models: haiku (claude-haiku-4-5-20251001), sonnet (claude-sonnet-4-6), opus (claude-opus-4-6)
  - Default: Configurable via DEFAULT_MODEL_TIER, defaults to sonnet
  - Used for: Agent queries, memory extraction, transcription, team coordination
  - Implementation: `src/agent/assistant.ts`

**Voice & Audio (Optional):**
- Groq API - Speech-to-text
  - SDK/Client: N/A (REST API)
  - Auth: GROQ_API_KEY
  - Purpose: Voice input transcription
  - Status: Optional integration

- ElevenLabs - Text-to-speech
  - SDK/Client: N/A (REST API)
  - Auth: ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID
  - Purpose: Voice output generation
  - Status: Optional integration

**Video & Media (Optional):**
- Google API - Video processing
  - SDK/Client: N/A (REST API)
  - Auth: GOOGLE_API_KEY
  - Purpose: Video analysis and processing
  - Status: Optional integration

**CRM & Business Applications:**
- Salesforce CRM
  - SDK/Client: REST API (custom implementation)
  - Auth: SF_CLIENT_ID, SF_CLIENT_SECRET, SF_USERNAME, SF_PASSWORD, SF_INSTANCE_URL
  - API Version: SF_API_VERSION (default v62.0)
  - Features: OAuth, bidirectional sync, 7 MCP tools
  - Implementation: MCP tools in `src/tools/mcp-server.ts`
  - Status: Full integration with recent enhancements

- Microsoft 365 / Outlook (Microsoft Graph)
  - SDK/Client: REST API (custom implementation)
  - Auth: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_USER_EMAIL
  - Features: Email calendar integration
  - Implementation: MCP tools in `src/tools/mcp-server.ts`
  - Status: Optional integration

## Data Storage

**Databases:**
- SQLite with FTS5 (Full-Text Search)
  - Type: Local embedded database
  - Location: `~/.clementine/vault/.memory.db`
  - Connection: better-sqlite3 11.7.0
  - ORM/Client: Direct SQL via better-sqlite3
  - Purpose: Vault indexing, memory search, transcript logging, usage tracking
  - Schema: Tables for chunks, file_hashes, transcripts, feedback, extractions
  - Concurrency: WAL mode for concurrent readers, serialized writes
  - Implementation: `src/memory/store.ts`

**File Storage:**
- Local filesystem only
  - Vault location: `~/.clementine/vault/`
  - Contains: Daily notes, people profiles, projects, topics, tasks, templates, inbox
  - Format: Markdown with gray-matter frontmatter
  - Directory structure: 00-System, 01-Daily-Notes, 02-People, 03-Projects, 04-Topics, 05-Tasks, 06-Templates, 07-Inbox
  - Code location: `src/`

**Caching & Session Data:**
- In-memory session store
  - Session Key: Channel + user identifier (e.g., "discord:123456")
  - Persisted in: SQLite transcripts table
  - Retention: 10 exchange history per session, 24-hour expiry on inactivity

## Authentication & Identity

**Auth Provider:**
- Custom per-channel
  - Discord: Bot token + owner user ID verification
  - Slack: OAuth tokens (bot + app level)
  - Telegram: Bot token + owner ID
  - Twilio/WhatsApp: Account SID + auth token + phone verification
  - Salesforce: OAuth2 with username/password grant
  - Microsoft: Client credentials with tenant

**Authorization:**
- Owner-based (single user mode)
  - Owner IDs: DISCORD_OWNER_ID, SLACK_OWNER_USER_ID, TELEGRAM_OWNER_ID, WHATSAPP_OWNER_PHONE
  - Security: ALLOW_ALL_USERS flag (default false = owner only)
  - Member channel access: Secondary permission level

**Secrets Management:**
- Source: `~/.clementine/.env`
- Fallback: macOS Keychain via `security find-generic-password`
- Never in process.env (isolation from subprocess)
- Implementation: `src/config.ts` functions getSecret() and validateSecrets()

## Monitoring & Observability

**Error Tracking:**
- None detected (no Sentry, Rollbar integration)

**Logs:**
- Pino structured logger
  - Format: JSON output to stderr (MCP), stdout for normal operations
  - Levels: Configurable via LOG_LEVEL env var
  - Implementation: Used throughout codebase with `pino()` instances
  - Output: Console + optional file logging
  - Modules: discord, slack, telegram, whatsapp, gateway, memory, agent, etc.

**Metrics & Analytics:**
- Dashboard built-in
  - Time saved estimates: 5 min per cron task, 2 min per exchange
  - Success rates per job
  - Per-job breakdown available
  - Implementation: `src/cli/dashboard.ts` with web SPA

**Activity Tracking:**
- Session transcript logging: SQLite transcripts table
- Tool usage: Extraction logging with user message + tool input
- Feedback collection: Rating + comment per response
- Memory access: Salience tracking for chunk importance

## CI/CD & Deployment

**Hosting:**
- Local CLI tool (standalone)
- Web dashboard: Localhost:3030 (Express)
- Daemon mode: Background process with heartbeat scheduler

**CI Pipeline:**
- None detected (no GitHub Actions workflows active)

**Build:**
- npm run build → TypeScript compilation to dist/
- Prepublish: npm run typecheck
- Postinstall: sqlite rebuild hook

## Environment Configuration

**Required env vars (Core):**
- ANTHROPIC_API_KEY - Claude API authentication (critical)
- ASSISTANT_NAME - Assistant identity (default: "Clementine")
- ASSISTANT_NICKNAME - Short name (default: "Clemmy")
- DEFAULT_MODEL_TIER - Model selection: haiku, sonnet, opus (default: sonnet)
- TIMEZONE - User timezone (fallback: system detected)

**Required env vars (By Channel):**
- Discord: DISCORD_TOKEN, DISCORD_OWNER_ID
- Slack: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_OWNER_USER_ID
- Telegram: TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_ID
- WhatsApp: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, WHATSAPP_OWNER_PHONE, WHATSAPP_FROM_PHONE
- Salesforce: SF_INSTANCE_URL, SF_CLIENT_ID, SF_CLIENT_SECRET, SF_USERNAME, SF_PASSWORD
- Microsoft: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_USER_EMAIL

**Optional env vars:**
- GROQ_API_KEY - Voice transcription (optional)
- ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID - Text-to-speech (optional)
- GOOGLE_API_KEY - Video processing (optional)
- OWNER_NAME - Display name
- ALLOW_ALL_USERS - Multi-user mode (default false)
- WORKSPACE_DIRS - Comma-separated paths for file operations
- TEAM_COMMS_CHANNEL - Team coordination channel
- HEARTBEAT_INTERVAL_MINUTES - Check-in frequency (default 30)
- HEARTBEAT_ACTIVE_START/END - Hours to run heartbeat (8-22)
- WEBHOOK_ENABLED, WEBHOOK_PORT, WEBHOOK_SECRET - Custom webhook ingestion

**Secrets location:**
- Primary: `~/.clementine/.env` file
- Fallback: macOS Keychain
- Never: process.env (isolation for subprocess safety)
- Example file: `.env.example` in repo root

**Secret Validation:**
- Fail-closed: Explicitly configured but unresolved secrets throw warnings
- Implementation: `src/config.ts` validateSecrets() function
- Companion key checking: Some secrets require paired keys

## Webhooks & Callbacks

**Incoming:**
- WhatsApp webhook: POST /whatsapp (Twilio webhook receiver)
  - Port: WHATSAPP_WEBHOOK_PORT (default 8421)
  - Signature validation: Twilio HMAC-SHA1
  - Implementation: `src/channels/whatsapp.ts`

- Custom webhook endpoint (optional): POST /webhook
  - Port: WEBHOOK_PORT (default 8420)
  - Auth: WEBHOOK_SECRET
  - Status: WEBHOOK_ENABLED flag
  - Implementation: `src/channels/webhook.ts`

**Outgoing:**
- Discord notifications: Direct channel send
- Slack notifications: Message API
- Telegram notifications: sendMessage API
- WhatsApp notifications: Twilio REST API
- Email (via Salesforce/Microsoft integration): Autonomous sending with send policy

**Team Coordination:**
- Team comms channel: TEAM_COMMS_CHANNEL environment variable
- Handoff mechanism: Agent-to-agent spawn and completion
- Notification dispatcher: `src/gateway/notifications.ts`

---

*Integration audit: 2026-03-27*
