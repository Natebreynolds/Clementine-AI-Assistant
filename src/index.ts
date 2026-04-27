/**
 * Clementine TypeScript — Main entry point.
 *
 * Initializes all layers (agent, gateway, heartbeat, cron, channels)
 * and runs them concurrently.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import * as config from './config.js';
import type { RestartSentinel } from './types.js';

// Clear nested session guard so the SDK can spawn Claude CLI subprocesses
delete process.env['CLAUDECODE'];

import { lanes } from './gateway/lanes.js';

// ── Logging ──────────────────────────────────────────────────────────

import pino from 'pino';

const logger = pino({
  level: 'info',
  transport: {
    target: 'pino/file',
    options: { destination: 1 }, // stdout
  },
});

// ── PID management ──────────────────────────────────────────────────

const PID_FILE = path.join(config.BASE_DIR, `.${config.ASSISTANT_NAME.toLowerCase()}.pid`);
const LAUNCHD_LABEL = `com.${config.ASSISTANT_NAME.toLowerCase()}.assistant`;

function killPid(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }

  // Wait up to 5s for graceful shutdown
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // dead
    }
    // Sync sleep ~100ms via busy wait
    const wait = Date.now() + 100;
    while (Date.now() < wait) { /* spin */ }
  }

  logger.warn({ pid }, 'Force-killing process');
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already dead
  }
}

function stopLaunchdService(): boolean {
  if (process.platform !== 'darwin') return false;
  const home = process.env.HOME ?? '';
  const plist = path.join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  if (!existsSync(plist)) return false;

  try {
    execSync(`launchctl list ${LAUNCHD_LABEL}`, { stdio: 'pipe' });
  } catch {
    return false; // not loaded
  }

  logger.info({ label: LAUNCHD_LABEL }, 'Unloading launchd service');
  try {
    execSync(`launchctl unload "${plist}"`, { stdio: 'pipe' });
  } catch {
    // ignore
  }
  return true;
}

function ensureSingleton(): void {
  stopLaunchdService();

  const myPid = process.pid;

  if (existsSync(PID_FILE)) {
    try {
      const oldPid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
      if (!isNaN(oldPid) && oldPid !== myPid) {
        try {
          process.kill(oldPid, 0); // test if alive
          logger.info({ pid: oldPid }, 'Stopping previous instance');
          killPid(oldPid);
          // Verify it's actually dead
          try {
            process.kill(oldPid, 0);
            logger.warn({ pid: oldPid }, 'Previous instance still alive after kill — forcing SIGKILL');
            try { process.kill(oldPid, 'SIGKILL'); } catch { /* already dead */ }
          } catch {
            // dead — good
          }
        } catch {
          // not running
        }
      }
    } catch {
      // bad pid file
    }
  }

  writeFileSync(PID_FILE, String(myPid));
}

function cleanupPid(): void {
  try {
    if (existsSync(PID_FILE)) {
      const content = readFileSync(PID_FILE, 'utf-8').trim();
      if (content === String(process.pid)) {
        unlinkSync(PID_FILE);
      }
    }
  } catch {
    // ignore
  }
}

// ── Startup verification ─────────────────────────────────────────────

function verifySetup(): string[] {
  const errors: string[] = [];

  // Check Node version range (20–24 LTS)
  const major = parseInt(process.version.slice(1), 10);
  if (major < 20 || major > 24) {
    errors.push(
      `Node.js v${major} detected. The Claude Code SDK requires Node 20–24 LTS.\n` +
      '  Install Node 22: `nvm install 22`',
    );
  }

  // Check claude CLI
  try {
    execSync('which claude', { stdio: 'pipe' });
  } catch {
    errors.push(
      'claude CLI not found. Install it: npm install -g @anthropic-ai/claude-code\n' +
      '  See: https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview',
    );
  }

  // Pre-flight: verify Claude CLI can actually execute in sandboxed env
  if (errors.length === 0) {
    try {
      execSync('claude --version', {
        stdio: 'pipe',
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          LANG: process.env.LANG ?? 'en_US.UTF-8',
          USER: process.env.USER ?? '',
          SHELL: process.env.SHELL ?? '',
        },
        timeout: 10000,
      });
    } catch (e) {
      errors.push(
        `Claude CLI failed to run in sandboxed env: ${e}\n` +
        '  This usually means a Node version incompatibility.\n' +
        '  Run: clementine doctor',
      );
    }
  }

  // Check better-sqlite3 native module — rebuild if Node version changed since last build
  const nodeStampFile = path.join(config.BASE_DIR, '.node-version-stamp');
  const currentNodeVersion = process.version;
  let needsRebuild = false;

  try {
    execSync('node -e "require(\'better-sqlite3\')"', { cwd: config.PKG_DIR, stdio: 'pipe', timeout: 5000 });
    // Module loads — stamp current version if not already stamped
    if (!existsSync(nodeStampFile) || readFileSync(nodeStampFile, 'utf-8').trim() !== currentNodeVersion) {
      writeFileSync(nodeStampFile, currentNodeVersion);
    }
  } catch {
    needsRebuild = true;
  }

  // Check if Node version changed since last successful build
  if (!needsRebuild && existsSync(nodeStampFile)) {
    const stamped = readFileSync(nodeStampFile, 'utf-8').trim();
    if (stamped !== currentNodeVersion) {
      logger.info({ stamped, current: currentNodeVersion }, 'Node version changed — rebuilding native modules');
      needsRebuild = true;
    }
  }

  if (needsRebuild) {
    try {
      execSync('npm rebuild better-sqlite3', {
        cwd: config.PKG_DIR,
        stdio: 'pipe',
        timeout: 30000,
      });
      execSync('node -e "require(\'better-sqlite3\')"', { cwd: config.PKG_DIR, stdio: 'pipe', timeout: 5000 });
      writeFileSync(nodeStampFile, currentNodeVersion);
      logger.info('better-sqlite3 rebuilt for Node ' + currentNodeVersion);
    } catch {
      errors.push(
        'better-sqlite3 native module is broken.\n' +
        '  Auto-rebuild failed. Fix manually: npm rebuild better-sqlite3\n' +
        '  Run: clementine doctor',
      );
    }
  }

  // Check vault system files
  const requiredFiles: Array<[string, string]> = [
    [config.SOUL_FILE, 'SOUL.md'],
    [config.AGENTS_FILE, 'AGENTS.md'],
  ];

  const missing = requiredFiles.filter(([p]) => !existsSync(p)).map(([, n]) => n);
  if (missing.length > 0) {
    errors.push(`Missing vault files: ${missing.join(', ')}`);
  }

  // At least one channel configured
  const anyChannel =
    config.CHANNEL_DISCORD ||
    config.CHANNEL_SLACK ||
    config.CHANNEL_TELEGRAM ||
    config.CHANNEL_WHATSAPP ||
    config.CHANNEL_WEBHOOK;

  if (!anyChannel) {
    errors.push(
      'No channels configured. Set at least one of:\n' +
      '  DISCORD_TOKEN, SLACK_BOT_TOKEN+SLACK_APP_TOKEN,\n' +
      '  TELEGRAM_BOT_TOKEN, TWILIO_ACCOUNT_SID+WHATSAPP_OWNER_PHONE, or WEBHOOK_ENABLED=true',
    );
  }

  // Discord token format
  if (config.CHANNEL_DISCORD && config.DISCORD_TOKEN.length < 50) {
    errors.push('DISCORD_TOKEN looks too short. Check your .env file.');
  }

  // Owner ID check
  if (config.CHANNEL_DISCORD && config.DISCORD_OWNER_ID === '0' && !config.ALLOW_ALL_USERS) {
    errors.push(
      'DISCORD_OWNER_ID not set and ALLOW_ALL_USERS is not true.\n' +
      '  Set DISCORD_OWNER_ID in .env, or set ALLOW_ALL_USERS=true to skip.',
    );
  }

  return errors;
}

// ── Banner ───────────────────────────────────────────────────────────

function printBanner(channels: string[], profiles: number, cronJobs: number, graphEnabled = false): void {
  const DIM = '\x1b[0;90m';
  const GREEN = '\x1b[0;32m';
  const CYAN = '\x1b[0;36m';
  const MAGENTA = '\x1b[0;35m';
  const RESET = '\x1b[0m';
  const ORANGE = '\x1b[38;5;208m';

  const name = config.ASSISTANT_NAME;
  const nick = config.ASSISTANT_NICKNAME;
  const modelName = (config.DEFAULT_MODEL_TIER as string).charAt(0).toUpperCase() +
    (config.DEFAULT_MODEL_TIER as string).slice(1);
  const owner = config.OWNER_NAME || 'not set';

  const modelColors: Record<string, string> = { Haiku: GREEN, Sonnet: CYAN, Opus: MAGENTA };
  const modelColor = modelColors[modelName] ?? CYAN;

  // Feature tags
  const tags: string[] = [];
  if (config.ENABLE_1M_CONTEXT) tags.push('1M context');
  if (config.GROQ_API_KEY) tags.push('voice');
  if (config.GOOGLE_API_KEY) tags.push('video');
  if (config.CHANNEL_OUTLOOK) tags.push('outlook');
  if (graphEnabled) tags.push('graph');
  if (profiles > 0) tags.push(`${profiles} profile${profiles !== 1 ? 's' : ''}`);

  // Block-letter banner
  const FONT: Record<string, string[]> = {
    C: [' ████', '██   ', '██   ', '██   ', ' ████'],
    L: ['██   ', '██   ', '██   ', '██   ', '█████'],
    E: ['█████', '██   ', '████ ', '██   ', '█████'],
    M: ['██   ██', '███ ███', '██ █ ██', '██   ██', '██   ██'],
    N: ['██  ██', '███ ██', '██████', '██ ███', '██  ██'],
    T: ['██████', '  ██  ', '  ██  ', '  ██  ', '  ██  '],
    I: ['██', '██', '██', '██', '██'],
  };

  const word = 'CLEMENTINE';
  const blockRows: string[] = [];
  for (let row = 0; row < 5; row++) {
    const line = [...word].map((ch) => FONT[ch]?.[row] ?? '').join(' ');
    blockRows.push(`  ${ORANGE}${line}${RESET}`);
  }

  console.log();
  console.log(blockRows.join('\n'));

  const subtitle = nick && nick !== name ? `${nick} — ` : '';
  console.log(`  ${DIM}${'─'.repeat(61)}${RESET}`);
  console.log(`  ${DIM}  ${subtitle}Personal AI Assistant${RESET}`);
  console.log();
  console.log(`      ${DIM}Model${RESET}       ${modelColor}${modelName}${RESET}`);
  console.log(`      ${DIM}Owner${RESET}       ${owner}`);
  console.log(`      ${DIM}Channels${RESET}    ${channels.join(', ')}`);
  if (cronJobs > 0) {
    console.log(`      ${DIM}Cron jobs${RESET}   ${cronJobs} scheduled`);
  }
  console.log(`      ${DIM}Heartbeat${RESET}   every ${config.HEARTBEAT_INTERVAL_MINUTES}min`);
  if (tags.length > 0) {
    console.log(`      ${DIM}Features${RESET}    ${tags.join(', ')}`);
  }
  console.log();

  // Hints for missing optional features
  const hints: Array<[string, string]> = [];
  if (!config.GROQ_API_KEY) hints.push(['GROQ_API_KEY', 'voice transcription']);
  if (!config.ELEVENLABS_API_KEY) hints.push(['ELEVENLABS_API_KEY', 'voice replies']);
  if (!config.GOOGLE_API_KEY) hints.push(['GOOGLE_API_KEY', 'video analysis']);
  if (!config.CHANNEL_OUTLOOK) hints.push(['MS_TENANT_ID + MS_CLIENT_ID + MS_CLIENT_SECRET', 'Outlook email & calendar']);
  if (!graphEnabled) hints.push(['clementine doctor', 'knowledge graph (run to diagnose)']);
  if (hints.length > 0) {
    console.log(`      ${DIM}Unlock more:${RESET}`);
    for (const [key, desc] of hints) {
      console.log(`      ${DIM}  + ${key} for ${desc}${RESET}`);
    }
    console.log();
  }

  console.log(`  ${DIM}${'─'.repeat(61)}${RESET}`);
  console.log();
}

// ── Ensure vault directories ─────────────────────────────────────────

function ensureVaultDirs(): void {
  const dirs = [
    config.SYSTEM_DIR,
    path.join(config.SYSTEM_DIR, 'skills'),
    config.AGENTS_DIR,
    path.join(config.BASE_DIR, 'tools'),
    config.DAILY_NOTES_DIR,
    config.PEOPLE_DIR,
    config.PROJECTS_DIR,
    config.TOPICS_DIR,
    config.TASKS_DIR,
    config.TEMPLATES_DIR,
    config.INBOX_DIR,
  ];

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  // Ensure logs directory
  const logDir = path.join(config.BASE_DIR, 'logs');
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  // Seed HEARTBEAT.md if it doesn't exist (new installs)
  if (!existsSync(config.HEARTBEAT_FILE)) {
    writeFileSync(config.HEARTBEAT_FILE, [
      '---',
      'type: core-system',
      'role: heartbeat-config',
      'interval: 30',
      'active_hours: "08:00-22:00"',
      'allow_tier2: false',
      'web_allowed: true',
      'tags:',
      '  - system',
      '  - heartbeat',
      '---',
      '',
      '# Heartbeat Standing Instructions',
      '',
      'Every **{{interval}} minutes** during active hours ({{active_hours}}), I run an autonomous check-in.',
      '',
      '## What I Do',
      '',
      'Check in like a colleague would — naturally and briefly. Lead with anything that needs attention. If everything is fine, say so in a sentence or two and move on.',
      '',
      '**Look for:**',
      '- Overdue tasks — check the task list for tasks past their due date. If any are overdue, flag them immediately.',
      '- Tasks due today that haven\'t been started yet.',
      '- New items in the Inbox — try to sort them to the right folder.',
      '- Recent cron/scheduled task outputs that are worth mentioning.',
      '- Goal progress — if a recent cron output advances a goal, update the goal\'s notes.',
      '',
      '## Proactive Actions',
      '',
      'During check-ins, I may take 1-2 small proactive actions per heartbeat (up to 6 per day):',
      '- Promote durable facts from today\'s daily note to MEMORY or topic/person notes',
      '- Update goal progress notes based on recent cron outputs',
      '- Flag interesting (not just urgent) findings for the owner',
      '- Create or update today\'s daily note if it doesn\'t exist',
      '',
      '## When to Alert',
      '',
      '- A task is overdue (always alert)',
      '- A task is due today and not started',
      '- Something I was monitoring has changed',
      '- A scheduled job produced results worth reporting',
      '- I found something interesting during a proactive check',
      '',
      '## When to Stay Quiet',
      '',
      '- Everything is on track',
      '- No overdue tasks, nothing new',
      '- Just log a brief note to today\'s daily log and move on',
      '',
      '## Limits',
      '',
      '- **Max turns:** 5 per heartbeat',
      '- **Tier 1 actions only** by default (read, write to vault, search)',
      '- **Tier 2** allowed if `allow_tier2: true` above (write outside vault, git commit, bash)',
      '- **Tier 3 never** — no pushing, no external comms, no deletions',
      '',
    ].join('\n'), 'utf-8');
  }
}

// ── Timer checker ─────────────────────────────────────────────────────

const TimerEntrySchema = z.object({
  id: z.string(),
  message: z.string(),
  fireAt: z.number(),
  createdAt: z.number(),
});

const TIMERS_FILE = path.join(config.BASE_DIR, '.timers.json');
const TIMER_CHECK_INTERVAL = 30_000; // 30 seconds

function startTimerChecker(
  dispatcher: import('./gateway/notifications.js').NotificationDispatcher,
  gateway?: import('./gateway/router.js').Gateway,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    try {
      if (!existsSync(TIMERS_FILE)) return;
      const raw = JSON.parse(readFileSync(TIMERS_FILE, 'utf-8'));
      const parsed = z.array(TimerEntrySchema).safeParse(raw);
      if (!parsed.success) {
        logger.warn({ error: parsed.error.message }, 'Invalid timers file — skipping');
        return;
      }
      const timers = parsed.data;
      if (timers.length === 0) return;

      const now = Date.now();
      const due = timers.filter((t) => t.fireAt <= now);
      const remaining = timers.filter((t) => t.fireAt > now);

      if (due.length === 0) return;

      // Update file first (remove fired timers)
      writeFileSync(TIMERS_FILE, JSON.stringify(remaining, null, 2));

      // Dispatch notifications and inject context so replies have reminder context
      for (const timer of due) {
        logger.info({ id: timer.id, message: timer.message }, 'Timer fired');
        const reminderText = `⏰ **Reminder:** ${timer.message}`;
        dispatcher.send(reminderText).catch((err) => {
          logger.error({ err, id: timer.id }, 'Failed to dispatch timer notification');
        });

        // Inject into owner's session so their reply has context about the reminder
        if (gateway && config.DISCORD_OWNER_ID) {
          gateway.injectContext(
            `discord:user:${config.DISCORD_OWNER_ID}`,
            `[Timer fired: ${timer.message}]`,
            reminderText,
          );
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Timer checker error — will retry next interval');
    }
  }, TIMER_CHECK_INTERVAL);
}

// ── Log rotation ─────────────────────────────────────────────────────

const LOG_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const LOG_MAX_BACKUPS = 7;

function rotateOne(logFile: string): void {
  if (!existsSync(logFile)) return;
  const size = statSync(logFile).size;
  if (size < LOG_MAX_BYTES) return;

  // Rotate: delete .log.7, shift .log.6→.log.7, ... .log→.log.1
  const oldest = `${logFile}.${LOG_MAX_BACKUPS}`;
  if (existsSync(oldest)) unlinkSync(oldest);

  for (let i = LOG_MAX_BACKUPS - 1; i >= 1; i--) {
    const src = `${logFile}.${i}`;
    if (existsSync(src)) renameSync(src, `${logFile}.${i + 1}`);
  }

  renameSync(logFile, `${logFile}.1`);
  writeFileSync(logFile, '');
}

function rotateLogIfNeeded(): void {
  // cron.log is appended to by launchd-spawned `clementine cron run` invocations
  // — each is a one-shot process that closes the FD after writing, so a
  // rename-rotate at daemon startup is safe.
  const logsDir = path.join(config.BASE_DIR, 'logs');
  for (const name of ['clementine.log', 'cron.log']) {
    try {
      rotateOne(path.join(logsDir, name));
    } catch (err) {
      logger.warn({ err, name }, 'Log rotation failed — continuing startup');
    }
  }
}

// ── Async main ───────────────────────────────────────────────────────

// ── Restart sentinel ─────────────────────────────────────────────────

const SENTINEL_PATH = path.join(config.BASE_DIR, '.restart-sentinel.json');

function readAndClearSentinel(): RestartSentinel | null {
  if (!existsSync(SENTINEL_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(SENTINEL_PATH, 'utf-8'));
    const sentinel: RestartSentinel = {
      previousPid: Number(raw.previousPid) || 0,
      restartedAt: String(raw.restartedAt ?? ''),
      reason: raw.reason,
      sourceChangeId: raw.sourceChangeId,
      sessionKey: raw.sessionKey,
      changedFiles: raw.changedFiles,
      updateDetails: raw.updateDetails,
    };
    unlinkSync(SENTINEL_PATH);
    return sentinel;
  } catch {
    try { unlinkSync(SENTINEL_PATH); } catch { /* ignore */ }
    return null;
  }
}

// ── Drain helper ─────────────────────────────────────────────────────

async function drainActiveSessions(
  gateway: import('./gateway/router.js').Gateway,
  timeoutMs = 60_000,
): Promise<void> {
  gateway.setDraining(true);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = lanes.status();
    let active = 0;
    for (const s of Object.values(status)) {
      active += s.active;
    }
    if (active === 0) break;
    logger.info({ totalActive: active }, 'Draining active sessions...');
    await new Promise(r => setTimeout(r, 500));
  }
}

async function asyncMain(): Promise<void> {
  // ── Rotate log if over size limit ───────────────────────────────
  rotateLogIfNeeded();

  // ── Read restart sentinel (from a previous self-edit / update) ───
  const sentinel = readAndClearSentinel();
  if (sentinel) {
    logger.info(
      { reason: sentinel.reason, previousPid: sentinel.previousPid, changedFiles: sentinel.changedFiles },
      'Restart sentinel detected — this process is a post-restart instance',
    );
  }

  // ── Validate secrets (fail closed on misconfiguration) ──────────
  const secretWarnings = config.validateSecrets();
  for (const warning of secretWarnings) {
    logger.warn(warning);
  }

  // ── Resolve keychain-backed secrets before anything reads process.env ──
  try {
    const { hydrateSecretsFromEnv } = await import('./secrets/resolver.js');
    hydrateSecretsFromEnv();
  } catch { /* non-fatal — non-macOS systems, or keychain unavailable */ }

  // ── Surface keychain resolution failures with a clear remediation hint ──
  // If any keychain ref couldn't be read at module-init time, the user is
  // probably hitting the per-process approval-dialog issue (entry written
  // with the wrong ACL). The fix is one command — print it loud so they
  // don't have to grep for the answer.
  const failedKcRefs = config.getFailedKeychainResolutions();
  if (failedKcRefs.length > 0) {
    logger.warn(
      { count: failedKcRefs.length, refs: failedKcRefs },
      `${failedKcRefs.length} keychain reference(s) could not be resolved at startup.`,
    );
    logger.warn(
      'Affected channels/integrations may be degraded. Fix in one command: clementine config keychain-fix-acl',
    );
    logger.warn(
      'See: https://github.com/Natebreynolds/Clementine-AI-Assistant#keychain-prompts',
    );
  }

  // ── Check MCP extension permissions ────────────────────────────
  try {
    const { checkPermissionsOnStartup, bootstrapClaudeIntegrationsFromAuditLog, probeAvailableTools } = await import('./agent/mcp-bridge.js');
    checkPermissionsOnStartup();
    bootstrapClaudeIntegrationsFromAuditLog(path.join(config.BASE_DIR, 'logs', 'audit.log'));
    // Probe the SDK's full tool inventory so buildOptions knows everything
    // Claude Code is surfacing (claude_ai_* connectors, plugins, etc.)
    // without per-user hardcoding. Cached 1h. On fresh probe, log a short
    // summary so the owner can verify which connectors were detected
    // without having to ask the assistant.
    // force=true on startup: the 1h cache from a prior daemon version may
    // have been taken with a stale probe config (e.g. before we started
    // passing mcpServers to the probe). Re-probe fresh so Extensions and
    // per-query MCP servers are discovered and whitelisted immediately.
    probeAvailableTools(true).then(async inv => {
      const integrations = new Set<string>();
      for (const t of inv.tools) {
        const m = t.match(/^mcp__claude_ai_([^_]+(?:_[^_]+)*)__/);
        if (m) integrations.add(m[1].replace(/_/g, ' '));
      }
      if (integrations.size > 0) {
        logger.info({ integrations: [...integrations].sort(), toolCount: inv.tools.length }, '🦞 Claude Desktop integrations detected');
      }
      // After inventory is live, fetch canonical schemas from every stdio
      // MCP server we can reach, then synthesize auto-skills for every
      // tool. This is the load-bearing pipeline for "Clementine knows how
      // to call any connector the user has" — no per-tool hardcoding.
      try {
        const { fetchAllSchemas } = await import('./agent/mcp-schemas.js');
        const { synthesizeSkillsFromSchemas } = await import('./agent/auto-skills.js');
        const schemas = await fetchAllSchemas();
        const result = synthesizeSkillsFromSchemas(schemas);
        logger.info(result, '📚 Auto-skills synthesized from MCP schemas');
      } catch (err) {
        logger.warn({ err }, 'Auto-skill synthesis failed (non-fatal)');
      }
    }).catch(() => { /* non-fatal, buildOptions falls back to baseline */ });
  } catch { /* non-fatal */ }

  // ── Initialize layers ────────────────────────────────────────────

  // Agent layer
  const { PersonalAssistant } = await import('./agent/assistant.js');
  const assistant = new PersonalAssistant();

  // Memory maintenance — startup + periodic (non-blocking)
  let maintenanceInterval: ReturnType<typeof setInterval> | undefined;
  {
    const memStore = assistant.getMemoryStore();
    if (memStore) {
      const { runStartupMaintenance, startPeriodicMaintenance } = await import('./memory/maintenance.js');
      // Fire-and-forget startup maintenance
      runStartupMaintenance(memStore).catch(() => {});
      // Periodic maintenance every 6 hours (consolidation needs an LLM caller)
      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      const llmCall = async (prompt: string): Promise<string> => {
        try {
          let result = '';
          const stream = query({ prompt, options: { model: 'claude-haiku-4-5-20251001', maxTurns: 1, systemPrompt: 'You are a memory consolidation assistant. Be concise.' } });
          for await (const msg of stream) {
            if (msg.type === 'result') result = (msg as any).result ?? '';
          }
          return result;
        } catch { return ''; }
      };
      maintenanceInterval = startPeriodicMaintenance(memStore, llmCall);
    }
  }

  // Gateway layer
  const { Gateway } = await import('./gateway/router.js');
  const gateway = new Gateway(assistant);

  // Wire approval callback
  const { setApprovalCallback, setSendPolicyChecker } = await import('./agent/hooks.js');
  setApprovalCallback(async (desc: string) => {
    const result = await gateway.requestApproval(desc);
    return result === true;
  });

  // Wire send policy checker — lightweight read-only DB access for suppression + daily cap
  {
    const Database = (await import('better-sqlite3')).default;
    const { MEMORY_DB_PATH } = await import('./config.js');
    const { existsSync } = await import('node:fs');
    if (existsSync(MEMORY_DB_PATH)) {
      const policyDb = new Database(MEMORY_DB_PATH, { readonly: true });
      policyDb.pragma('journal_mode = WAL');
      setSendPolicyChecker((agentSlug: string, recipientEmail: string) => {
        try {
          const suppRow = policyDb.prepare('SELECT 1 FROM suppression_list WHERE email = ?').get(recipientEmail.toLowerCase());
          const countRow = policyDb.prepare(
            `SELECT COUNT(*) as cnt FROM send_log WHERE agent_slug = ? AND sent_at >= date('now')`
          ).get(agentSlug) as { cnt: number };
          return { suppressed: !!suppRow, dailyCount: countRow?.cnt ?? 0 };
        } catch {
          // Tables may not exist yet (first run before MCP server initializes store)
          return { suppressed: false, dailyCount: 0 };
        }
      });
    }
  }

  // Notification dispatcher
  const { NotificationDispatcher } = await import('./gateway/notifications.js');
  const dispatcher = new NotificationDispatcher();
  gateway.setDispatcher(dispatcher);
  gateway.initSkillNotifications();

  // Crash recovery — surface any forensic dumps written before this start.
  // Fire-and-forget; if the dispatcher isn't ready yet, the next launch
  // catches it on retry (the .ack rename only happens after send succeeds).
  void (async () => {
    try {
      const { surfaceUnreadCrashReports } = await import('./agent/crash-forensics.js');
      const count = await surfaceUnreadCrashReports(config.BASE_DIR, async (msg) => { await dispatcher.send(msg); });
      if (count > 0) {
        logger.info({ count }, 'Surfaced crash recovery summary to owner');
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to surface crash recovery summary');
    }
  })();

  // Heartbeat + Cron schedulers
  const { HeartbeatScheduler, CronScheduler } = await import('./gateway/heartbeat.js');
  const heartbeat = new HeartbeatScheduler(gateway, dispatcher);
  const cronScheduler = new CronScheduler(gateway, dispatcher);
  heartbeat.setCronScheduler(cronScheduler);

  // Per-agent heartbeats — one cheap-path observer per registered specialist.
  // LLM tick fires on signal change with the agent's profile and routes
  // output to their Discord channel.
  const { AgentHeartbeatManager } = await import('./gateway/agent-heartbeat-manager.js');
  const agentHeartbeats = new AgentHeartbeatManager(gateway.getAgentManager(), gateway);

  // Self-improve loop — closes the gap between "trigger written" and
  // "fix applied." Every 10 min, scans self-improve/triggers/, classifies
  // failures, auto-applies safe cron-config fixes, escalates risky ones.
  const { SelfImproveLoop } = await import('./agent/self-improve-loop.js');
  const selfImproveLoop = new SelfImproveLoop(dispatcher);

  // ── Build channel tasks ──────────────────────────────────────────
  const channelTasks: Array<Promise<void>> = [];
  const activeChannels: string[] = [];

  if (config.CHANNEL_DISCORD) {
    const { startDiscord } = await import('./channels/discord.js');

    let botManager: import('./channels/discord-bot-manager.js').BotManager | undefined;
    try {
      const { BotManager } = await import('./channels/discord-bot-manager.js');
      botManager = new BotManager({
        gateway,
        ownerId: config.DISCORD_OWNER_ID,
        cronScheduler,
      });
      logger.info('BotManager: starting all agent bots...');
      const botOwnedChannels = await botManager.startAll();
      if (botOwnedChannels.length > 0) {
        logger.info({ channels: botOwnedChannels }, `Started ${botOwnedChannels.length} agent bot(s)`);
      }
    } catch (err) {
      logger.error({ err }, 'BotManager startup failed — continuing without agent bots');
    }

    // Register BotManager with gateway so TeamBus can resolve agent bot channels
    if (botManager) gateway.setBotManager(botManager);

    channelTasks.push(startDiscord(gateway, heartbeat, cronScheduler, dispatcher, botManager));
    if (botManager) botManager.startPolling(60_000);
    activeChannels.push('Discord');
  }

  if (config.CHANNEL_SLACK) {
    const { startSlack } = await import('./channels/slack.js');

    let slackBotManager: import('./channels/slack-bot-manager.js').SlackBotManager | undefined;
    try {
      const { SlackBotManager } = await import('./channels/slack-bot-manager.js');
      slackBotManager = new SlackBotManager({
        gateway,
        ownerId: config.SLACK_OWNER_USER_ID,
      });
      logger.info('SlackBotManager: starting all Slack agent bots...');
      const slackBotChannels = await slackBotManager.startAll();
      if (slackBotChannels.length > 0) {
        logger.info({ channels: slackBotChannels }, `Started ${slackBotChannels.length} Slack agent bot(s)`);
      }
    } catch (err) {
      logger.error({ err }, 'SlackBotManager startup failed — continuing without Slack agent bots');
    }

    if (slackBotManager) gateway.setSlackBotManager(slackBotManager);

    channelTasks.push(startSlack(gateway, dispatcher, slackBotManager));
    if (slackBotManager) slackBotManager.startPolling(60_000);
    activeChannels.push('Slack');
  }

  if (config.CHANNEL_TELEGRAM) {
    const { startTelegram } = await import('./channels/telegram.js');
    channelTasks.push(startTelegram(gateway, dispatcher));
    activeChannels.push('Telegram');
  }

  if (config.CHANNEL_WHATSAPP) {
    const { startWhatsApp } = await import('./channels/whatsapp.js');
    channelTasks.push(startWhatsApp(gateway, dispatcher));
    activeChannels.push(`WhatsApp (:${config.WHATSAPP_WEBHOOK_PORT})`);
  }

  if (config.CHANNEL_WEBHOOK) {
    const { startWebhook } = await import('./channels/webhook.js');
    channelTasks.push(startWebhook(gateway));
    activeChannels.push(`Webhook (:${config.WEBHOOK_PORT})`);
  }

  if (channelTasks.length === 0) {
    logger.error('No channels configured — nothing to start');
    return;
  }

  // Initialize graph store (non-blocking, graceful fallback)
  // The daemon owns the embedded FalkorDB server; other processes connect via socket.
  let graphAvailable = false;
  let graphStore: import('./memory/graph-store.js').GraphStore | null = null;
  try {
    const { GraphStore } = await import('./memory/graph-store.js');
    graphStore = new GraphStore(config.GRAPH_DB_DIR);
    await graphStore.initialize();
    if (graphStore.isAvailable()) {
      graphAvailable = true;
      const stats = await graphStore.syncFromVault(config.VAULT_DIR, config.AGENTS_DIR);
      if (stats.nodesCreated > 0) {
        logger.info(stats, 'Graph sync populated from vault');
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Graph store init failed — continuing without graph features');
  }

  // Start heartbeat + cron + timers
  heartbeat.start();
  cronScheduler.start();
  agentHeartbeats.start();
  selfImproveLoop.start();

  // Background-task hygiene: any task left in 'running' is from a prior
  // process. Mark them aborted so the lifecycle is honest. (P6b will add
  // resumability; for now fail-fast is clearer than silently re-running.)
  try {
    const { abortStaleRunningTasks } = await import('./agent/background-tasks.js');
    const aborted = abortStaleRunningTasks();
    if (aborted > 0) {
      logger.info({ count: aborted }, 'Aborted stale running background tasks from prior daemon');
    }
  } catch (err) {
    logger.warn({ err }, 'Background task hygiene check failed — non-fatal');
  }

  const timerInterval = startTimerChecker(dispatcher, gateway);

  // Start brain ingest scheduler (polls registered REST sources on their cron)
  try {
    const { getIngestScheduler } = await import('./brain/ingest-scheduler.js');
    await getIngestScheduler().start();
  } catch (err) {
    logger.warn({ err }, 'Brain ingest scheduler failed to start');
  }

  // Deliver pending team messages every 15s (picks up MCP-written messages)
  const teamDeliveryInterval = setInterval(() => {
    try { gateway.getTeamBus().deliverPending(); } catch (err) { logger.warn({ err }, 'Team delivery error'); }
  }, 15_000);

  // Watch for pending source edits from MCP tools (every 10s)
  const PENDING_SOURCE_SIGNAL = path.join(config.BASE_DIR, '.pending-source-edit');
  const PENDING_UPDATE_SIGNAL = path.join(config.BASE_DIR, '.pending-update');
  const PENDING_SOURCE_DIR = path.join(config.SELF_IMPROVE_DIR, 'pending-source-changes');

  const sourceEditInterval = setInterval(async () => {
    try {
      // Check for pending source edits
      if (existsSync(PENDING_SOURCE_SIGNAL)) {
        const signalRaw = JSON.parse(readFileSync(PENDING_SOURCE_SIGNAL, 'utf-8'));
        const signalParsed = z.object({ id: z.string() }).safeParse(signalRaw);
        unlinkSync(PENDING_SOURCE_SIGNAL);
        if (!signalParsed.success) {
          logger.warn({ error: signalParsed.error.message }, 'Invalid source-edit signal file');
        } else {
          const signal = signalParsed.data;
          const pendingFile = path.join(PENDING_SOURCE_DIR, `${signal.id}.json`);
          if (existsSync(pendingFile)) {
            const pendingRaw = JSON.parse(readFileSync(pendingFile, 'utf-8'));
            const pendingParsed = z.object({
              file: z.string(),
              content: z.string(),
              reason: z.string(),
            }).safeParse(pendingRaw);
            unlinkSync(pendingFile);

            if (!pendingParsed.success) {
              logger.warn({ error: pendingParsed.error.message }, 'Invalid pending source-edit file');
            } else {
              const pending = pendingParsed.data;
              logger.info({ id: signal.id, file: pending.file }, 'Processing pending source edit from MCP');
              const { safeSourceEdit } = await import('./agent/safe-restart.js');
              const result = await safeSourceEdit(config.PKG_DIR, [
                { relativePath: pending.file, content: pending.content },
              ], { reason: pending.reason, description: pending.reason });

              if (!result.success) {
                logger.error({ error: result.error, preflightErrors: result.preflightErrors }, 'Pending source edit failed');
                dispatcher.send(`Source edit failed: ${result.error}`).catch(() => {});
              }
            }
          }
        }
      }

      // Check for pending updates
      if (existsSync(PENDING_UPDATE_SIGNAL)) {
        unlinkSync(PENDING_UPDATE_SIGNAL);
        logger.info('Processing pending update from MCP');
        const { applyUpdate } = await import('./agent/auto-update.js');
        const result = await applyUpdate(config.PKG_DIR);
        if (!result.success) {
          logger.error({ error: result.error }, 'Pending update failed');
          dispatcher.send(`Update failed: ${result.error}`).catch(() => {});
        }
      }
    } catch (err) {
      logger.error({ err }, 'Source edit/update watcher error');
    }
  }, 10_000);

  // ── Banner ───────────────────────────────────────────────────────
  const profileCount = 0; // ProfileManager can be loaded later if needed
  const cronCount = 0; // Jobs loaded internally by CronScheduler.start()

  printBanner(activeChannels, profileCount, cronCount, graphAvailable);

  logger.info(`${config.ASSISTANT_NAME} is online`);

  // ── Initialize all channels ─────────────────────────────────────
  await Promise.all(channelTasks);

  // Warn if no notification channels registered — cron/heartbeat output will be lost
  if (!dispatcher.hasChannels) {
    logger.warn('⚠ No notification channels connected — cron and heartbeat output will not be delivered. Configure at least one channel (Discord, Slack, Telegram) to receive notifications.');
  }

  // ── Deliver restart sentinel notification ──────────────────────
  if (sentinel) {
    let msg: string;
    if (sentinel.reason === 'source-edit') {
      msg = `Restart complete. Source change applied${sentinel.changedFiles ? ` (${sentinel.changedFiles.join(', ')})` : ''}.`;
    } else if (sentinel.reason === 'update' && sentinel.updateDetails) {
      const d = sentinel.updateDetails;
      const parts: string[] = [];

      // Version info — prefer semver transition over commit hash for human readability.
      if (d.previousVersion && d.newVersion && d.previousVersion !== d.newVersion) {
        parts.push(`Updated v${d.previousVersion} → v${d.newVersion}`);
      } else if (d.newVersion) {
        parts.push(`Now on v${d.newVersion}`);
      } else if (d.commitHash) {
        parts.push(`Updated to ${d.commitHash}${d.commitDate ? ` (${d.commitDate})` : ''}`);
      } else {
        parts.push('Update applied');
      }

      // What changed upstream
      if (d.commitsBehind && d.commitsBehind > 0) {
        parts.push(`${d.commitsBehind} new commit${d.commitsBehind > 1 ? 's' : ''} pulled`);
      }
      if (d.summary) {
        parts.push(`Changes: ${d.summary}`);
      }

      // Source mod reconciliation
      const modParts: string[] = [];
      if (d.modsReapplied && d.modsReapplied > 0) modParts.push(`${d.modsReapplied} re-applied`);
      if (d.modsSuperseded && d.modsSuperseded > 0) modParts.push(`${d.modsSuperseded} already in upstream`);
      if (d.modsNeedReconciliation && d.modsNeedReconciliation > 0) modParts.push(`${d.modsNeedReconciliation} need my attention`);
      if (d.modsFailed && d.modsFailed > 0) modParts.push(`${d.modsFailed} failed`);
      if (modParts.length > 0) {
        parts.push(`Source mods: ${modParts.join(', ')}`);
      }

      msg = parts.join('. ') + '.';
    } else if (sentinel.reason === 'update') {
      msg = 'Restart complete. Update applied successfully.';
    } else {
      msg = 'Restart complete.';
    }

    dispatcher.send(msg).catch((err) => {
      logger.warn({ err }, 'Failed to deliver restart notification');
    });
    // Also inject context into the originating session if known
    if (sentinel.sessionKey) {
      gateway.injectContext(sentinel.sessionKey, '[System: restart triggered]', msg);
    }
  }

  // ── Keep alive until shutdown or restart signal ─────────────────
  // The event loop stays active via Discord's websocket, node-cron
  // timers, and heartbeat setInterval.  We just need to gate on
  // SIGTERM / SIGINT so cleanup runs before exit.
  // SIGUSR1 triggers a self-restart: cleanup then spawn a new instance.
  let restartRequested = false;

  await new Promise<void>((resolve) => {
    process.once('SIGTERM', resolve);
    process.once('SIGINT', resolve);
    process.once('SIGUSR1', () => {
      restartRequested = true;
      resolve();
    });
  });

  // ── Graceful cleanup ──────────────────────────────────────────

  logger.info(restartRequested ? 'Restart signal received — restarting' : 'Shutdown signal received — cleaning up');

  // Stop accepting new work immediately
  clearInterval(timerInterval);
  clearInterval(teamDeliveryInterval);
  clearInterval(sourceEditInterval);
  if (maintenanceInterval) clearInterval(maintenanceInterval);

  // Close graph store FIRST — FalkorDBLite's cleanup.js registers an
  // uncaughtException handler that re-throws errors.  If a Redis socket
  // drops during the drain wait, that handler crashes the process.
  // Closing (and unregistering) before draining prevents this.
  if (graphStore) {
    try { await graphStore.close(); } catch (err) { logger.warn({ err }, 'Graph store close error'); }
    graphStore = null;
  }

  // Drain active sessions BEFORE tearing down heartbeat/cron —
  // active sessions may still need those services.
  if (restartRequested) {
    await drainActiveSessions(gateway);
  }

  // Flush any pending debounced session writes before exit.
  try { assistant.flushSessions(); } catch (err) { logger.warn({ err }, 'Session flush on shutdown failed'); }

  // Now safe to tear down remaining infrastructure
  heartbeat.stop();
  cronScheduler.stop();
  agentHeartbeats.stop();
  selfImproveLoop.stop();

  // ── Self-restart (enhanced with health check + rollback) ────────
  if (restartRequested) {
    // Clear our PID file BEFORE spawning the child, so ensureSingleton()
    // in the child doesn't see our PID and kill us during the handoff.
    cleanupPid();

    const { spawn } = await import('node:child_process');
    const { openSync } = await import('node:fs');
    // Resolve the correct entry point — if started via `node -e` (e.g. from a
    // leaked smoke test), argv[1] would be `-e` which is wrong. Use the known
    // dist entry path instead.
    let entry = process.argv[1];
    let args = process.argv.slice(2);
    if (entry === '-e' || entry === '--eval') {
      entry = path.join(config.PKG_DIR, 'dist', 'index.js');
      args = [];
      logger.warn({ originalArgv: process.argv }, 'Self-restart: detected -e flag — using dist entry path instead');
    }
    logger.info({ entry, args }, 'Spawning new instance');

    // Redirect child stdout/stderr to log file so pino logs are preserved
    const logPath = path.join(config.BASE_DIR, 'logs', 'clementine.log');
    let childStdio: any = 'ignore';
    try {
      const logFd = openSync(logPath, 'a');
      childStdio = ['ignore', logFd, logFd];
    } catch { /* fallback to ignore if log file can't be opened */ }

    const child = spawn(process.execPath, [entry, ...args], {
      detached: true,
      stdio: childStdio,
      cwd: config.PKG_DIR,
      env: process.env,
    });
    child.unref();

    // Health check — wait up to 10s for the child to write a new PID
    const childAlive = await new Promise<boolean>((resolve) => {
      child.once('exit', () => resolve(false));
      const checkInterval = setInterval(() => {
        try {
          if (existsSync(PID_FILE)) {
            const newPid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
            if (!isNaN(newPid) && newPid !== process.pid) {
              clearInterval(checkInterval);
              resolve(true);
            }
          }
        } catch { /* ignore read errors */ }
      }, 500);
      setTimeout(() => {
        clearInterval(checkInterval);
        resolve(true); // Assume alive after 10s if no exit event
      }, 10_000);
    });

    // Rollback on crash — if child died and sentinel exists with changedFiles
    if (!childAlive) {
      logger.error('Restart failed — new process exited immediately');
      const crashSentinel = readAndClearSentinel();
      if (crashSentinel?.changedFiles && crashSentinel.changedFiles.length > 0) {
        logger.info({ changedFiles: crashSentinel.changedFiles }, 'Rolling back source edit...');
        try {
          // Roll back via source-mods registry (restores "before" snapshots)
          if (crashSentinel.sourceChangeId) {
            const { rollbackSourceMod } = await import('./agent/source-mods.js');
            rollbackSourceMod(crashSentinel.sourceChangeId, config.PKG_DIR);
          } else {
            // Fallback: reset src/ to git HEAD
            execSync('git checkout -- src/', { cwd: config.PKG_DIR, stdio: 'pipe' });
          }
          // Use tsc directly — `npm run build` does `rm -rf dist` which would
          // nuke the running process's code. tsc alone overwrites only changed .js files.
          execSync('./node_modules/.bin/tsc', { cwd: config.PKG_DIR, stdio: 'pipe', timeout: 120_000 });
          logger.info('Rollback successful — spawning clean instance');

          const retryChild = spawn(process.execPath, [entry, ...args], {
            detached: true,
            stdio: 'ignore',
            cwd: process.cwd(),
            env: process.env,
          });
          retryChild.unref();

          const retryAlive = await new Promise<boolean>((resolve) => {
            retryChild.once('exit', () => resolve(false));
            setTimeout(() => resolve(true), 5000);
          });

          if (!retryAlive) {
            logger.error('Rollback spawn also failed — exiting. launchd/systemd will respawn.');
          }

          process.exit(retryAlive ? 0 : 1);
        } catch (revertErr) {
          logger.error({ revertErr }, 'Rollback failed — exiting');
        }
      }
      logger.error('Run `clementine doctor` to diagnose.');
    }

    // Force exit — Discord websocket and other event loop handles
    // will keep this process alive indefinitely if we just return.
    process.exit(childAlive ? 0 : 1);
  }
}

// ── Main ─────────────────────────────────────────────────────────────

function main(): void {
  // Smoke test mode: verify the module loads then exit immediately.
  // Set by `clementine update` to validate the build without starting a full daemon.
  if (process.env.CLEMENTINE_SMOKE_TEST) {
    process.exit(0);
  }

  // Singleton enforcement
  ensureSingleton();
  process.on('exit', cleanupPid);

  // Global safety net — log unhandled errors instead of crashing the daemon
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'Uncaught exception — daemon staying alive');
  });
  process.on('unhandledRejection', (err) => {
    logger.error({ err }, 'Unhandled promise rejection — daemon staying alive');
  });

  // Crash forensics — write a JSON dump alongside the existing log line
  // so the next launch can surface "I crashed because X" via chat.
  // Fire-and-forget: failure to load shouldn't block daemon startup.
  import('./agent/crash-forensics.js')
    .then(({ installCrashHandlers }) => installCrashHandlers(config.BASE_DIR))
    .catch((err) => logger.warn({ err }, 'Failed to install crash forensics handlers — continuing without them'));

  // First-run auto-setup
  const envFile = path.join(config.BASE_DIR, '.env');
  if (!existsSync(envFile)) {
    console.log();
    console.log('  No .env file found — looks like a fresh install.');
    console.log('  Run: clementine config setup');
    console.log();
    process.exit(1);
  }

  // Startup verification
  const errors = verifySetup();
  if (errors.length > 0) {
    for (const err of errors) {
      logger.error(`Setup issue: ${err}`);
    }

    const anyChannel =
      config.CHANNEL_DISCORD ||
      config.CHANNEL_SLACK ||
      config.CHANNEL_TELEGRAM ||
      config.CHANNEL_WHATSAPP ||
      config.CHANNEL_WEBHOOK;

    if (!anyChannel) {
      process.exit(1);
    }
  }

  // Ensure vault directories
  ensureVaultDirs();

  // Run — SIGINT/SIGTERM are handled inside asyncMain (shutdown-signal gate).
  // When asyncMain resolves, cleanup has already run; just clean up the PID.
  asyncMain()
    .then(() => {
      cleanupPid();
    })
    .catch((err: unknown) => {
      logger.error({ err }, 'Fatal error');
      cleanupPid();
      process.exit(1);
    });
}

// ── Export for CLI and direct usage ──────────────────────────────────

export { main, asyncMain, verifySetup, printBanner };

main();
