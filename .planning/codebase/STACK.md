# Technology Stack

**Analysis Date:** 2026-03-27

## Languages

**Primary:**
- TypeScript 5.7.0 - Complete codebase (src/)
- JavaScript (Node.js) - Runtime execution

**Configuration:**
- Markdown with gray-matter frontmatter - Vault data format, configuration files

## Runtime

**Environment:**
- Node.js >= 20.0.0 (specified in package.json engines)
- ESM (ES Modules) - Type set to "module" in package.json

**Package Manager:**
- npm - Lock file: package-lock.json present

## Frameworks

**Core AI/Agent:**
- @anthropic-ai/claude-agent-sdk 0.2.81 - Agent orchestration with Claude Code SDK
- @anthropic-ai/sdk 0.78.0 - Base Anthropic API client

**CLI & Command:**
- commander 13.1.0 - CLI command parsing and structure
- @inquirer/prompts 7.0.0 - Interactive terminal prompts (setup wizard)

**Web Server & Dashboard:**
- express 4.21.0 - HTTP server for web dashboard on localhost:3030

**Message Handling:**
- Model Context Protocol (@modelcontextprotocol/sdk 1.12.0) - MCP stdio server for tools
- pino 9.6.0 - Structured logging

**Testing:**
- vitest 4.1.1 - Test runner and framework
- Config: `vitest.config.ts`

**Build/Dev:**
- tsx 4.19.0 - TypeScript execution and development
- typescript 5.7.0 - TypeScript compiler

## Key Dependencies

**Critical:**
- @anthropic-ai/claude-agent-sdk 0.2.81 - Enables agent layer with tool calling and memory
- better-sqlite3 11.7.0 - Embedded SQLite FTS5 for memory search (zero-latency)
- @modelcontextprotocol/sdk 1.12.0 - MCP tool framework for extensible tools

**Channel Integrations:**
- discord.js 14.18.0 - Discord bot client and event handling
- @slack/bolt 4.2.0 - Slack bot framework with Socket Mode
- grammy 1.35.0 - Telegram bot framework
- twilio 5.5.0 - WhatsApp messaging via Twilio API

**Data & Configuration:**
- gray-matter 4.0.3 - YAML/JSON frontmatter parsing for vault notes
- zod 4.3.6 - TypeScript-first schema validation
- cron-parser 5.5.0 - Parse and handle CRON expressions
- node-cron 3.0.3 - Cron job scheduling

## Configuration

**Environment:**
- Read from `.env` file located at `~/.clementine/.env`
- Never pollutes process.env to isolate secrets from subprocess
- Fallback: macOS Keychain lookup via `security find-generic-password`
- Configuration file paths in `src/config.ts`

**Build:**
- TypeScript config: `tsconfig.json`
  - Target: ES2022
  - Module: Node16 (ESM support)
  - Output: `dist/`
  - Strict mode enabled
  - Declaration maps for debugging
  - Source maps included
- Vitest config: `vitest.config.ts`
  - Test directory: `tests/**/*.test.ts`
  - Global test utilities enabled

**Compilation:**
- Build command: `npm run build` → `tsc && chmod +x dist/cli/index.js`
- Watch mode available via `tsx`
- Built CLI executable: `dist/cli/index.js`

## Platform Requirements

**Development:**
- Node.js 20+
- macOS (Keychain integration for secrets)
- Better-sqlite3 compilation via npm rebuild hook

**Production:**
- Node.js 20+
- Standalone CLI tool deployed as npm package
- Data directory: `~/.clementine/` (vault, database, logs, config)
- Code directory: Wherever npm installs the package

**Deployment:**
- Distributed as npm package (`clemmy-ts`)
- Executable: `clementine` command (symlinked to dist/cli/index.js)
- Includes vault template and README in package files

---

*Stack analysis: 2026-03-27*
