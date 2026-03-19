/**
 * Clementine TypeScript — Main entry point.
 *
 * Initializes all layers (agent, gateway, heartbeat, cron, channels)
 * and runs them concurrently.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
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

  // Check better-sqlite3 native module
  try {
    require.resolve('better-sqlite3');
    // If resolve works, try actually loading it
    execSync('node -e "require(\'better-sqlite3\')"', { stdio: 'pipe', timeout: 5000 });
  } catch {
    errors.push(
      'better-sqlite3 native module is broken (Node version mismatch).\n' +
      '  Fix: npm rebuild better-sqlite3\n' +
      '  Run: clementine doctor',
    );
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
  const BOLD = '\x1b[1m';
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
    config.DAILY_NOTES_DIR,
    config.PEOPLE_DIR,
    config.PROJECTS_DIR,
    config.TOPICS_DIR,
    config.TASKS_DIR,
    config.TEMPLATES_DIR,
    config.INBOX_DIR,
    config.PROFILES_DIR,
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
}

// ── Timer checker ─────────────────────────────────────────────────────

interface TimerEntry {
  id: string;
  message: string;
  fireAt: number;
  createdAt: number;
}

const TIMERS_FILE = path.join(config.BASE_DIR, '.timers.json');
const TIMER_CHECK_INTERVAL = 30_000; // 30 seconds

function startTimerChecker(
  dispatcher: import('./gateway/notifications.js').NotificationDispatcher,
  gateway?: import('./gateway/router.js').Gateway,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    try {
      if (!existsSync(TIMERS_FILE)) return;
      const timers: TimerEntry[] = JSON.parse(readFileSync(TIMERS_FILE, 'utf-8'));
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
    } catch {
      // Non-fatal — will retry next interval
    }
  }, TIMER_CHECK_INTERVAL);
}

// ── Async main ───────────────────────────────────────────────────────

// ── Restart sentinel ─────────────────────────────────────────────────

const SENTINEL_PATH = path.join(config.BASE_DIR, '.restart-sentinel.json');

function readAndClearSentinel(): RestartSentinel | null {
  if (!existsSync(SENTINEL_PATH)) return null;
  try {
    const sentinel = JSON.parse(readFileSync(SENTINEL_PATH, 'utf-8')) as RestartSentinel;
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

  // ── Initialize layers ────────────────────────────────────────────

  // Agent layer
  const { PersonalAssistant } = await import('./agent/assistant.js');
  const assistant = new PersonalAssistant();

  // Gateway layer
  const { Gateway } = await import('./gateway/router.js');
  const gateway = new Gateway(assistant);

  // Wire approval callback
  const { setApprovalCallback } = await import('./agent/hooks.js');
  setApprovalCallback(async (desc: string) => {
    const result = await gateway.requestApproval(desc);
    return result === true;
  });

  // Notification dispatcher
  const { NotificationDispatcher } = await import('./gateway/notifications.js');
  const dispatcher = new NotificationDispatcher();

  // Heartbeat + Cron schedulers
  const { HeartbeatScheduler, CronScheduler } = await import('./gateway/heartbeat.js');
  const heartbeat = new HeartbeatScheduler(gateway, dispatcher);
  const cronScheduler = new CronScheduler(gateway, dispatcher);

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
  const timerInterval = startTimerChecker(dispatcher, gateway);

  // Deliver pending team messages every 15s (picks up MCP-written messages)
  const teamDeliveryInterval = setInterval(() => {
    try { gateway.getTeamBus().deliverPending(); } catch { /* non-fatal */ }
  }, 15_000);

  // Watch for pending source edits from MCP tools (every 10s)
  const PENDING_SOURCE_SIGNAL = path.join(config.BASE_DIR, '.pending-source-edit');
  const PENDING_UPDATE_SIGNAL = path.join(config.BASE_DIR, '.pending-update');
  const PENDING_SOURCE_DIR = path.join(config.SELF_IMPROVE_DIR, 'pending-source-changes');

  const sourceEditInterval = setInterval(async () => {
    try {
      // Check for pending source edits
      if (existsSync(PENDING_SOURCE_SIGNAL)) {
        const signal = JSON.parse(readFileSync(PENDING_SOURCE_SIGNAL, 'utf-8'));
        unlinkSync(PENDING_SOURCE_SIGNAL);

        const pendingFile = path.join(PENDING_SOURCE_DIR, `${signal.id}.json`);
        if (existsSync(pendingFile)) {
          const pending = JSON.parse(readFileSync(pendingFile, 'utf-8'));
          unlinkSync(pendingFile);

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

  // ── Deliver restart sentinel notification ──────────────────────
  if (sentinel) {
    let msg: string;
    if (sentinel.reason === 'source-edit') {
      msg = `Restart complete. Source change applied${sentinel.changedFiles ? ` (${sentinel.changedFiles.join(', ')})` : ''}.`;
    } else if (sentinel.reason === 'update' && sentinel.updateDetails) {
      const d = sentinel.updateDetails;
      const parts: string[] = [];

      // Version info
      if (d.commitHash) {
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

  // Close graph store FIRST — FalkorDBLite's cleanup.js registers an
  // uncaughtException handler that re-throws errors.  If a Redis socket
  // drops during the drain wait, that handler crashes the process.
  // Closing (and unregistering) before draining prevents this.
  if (graphStore) {
    try { await graphStore.close(); } catch { /* non-fatal */ }
    graphStore = null;
  }

  // Drain active sessions BEFORE tearing down heartbeat/cron —
  // active sessions may still need those services.
  if (restartRequested) {
    await drainActiveSessions(gateway);
  }

  // Now safe to tear down remaining infrastructure
  heartbeat.stop();
  cronScheduler.stop();

  // ── Self-restart (enhanced with health check + rollback) ────────
  if (restartRequested) {
    // Clear our PID file BEFORE spawning the child, so ensureSingleton()
    // in the child doesn't see our PID and kill us during the handoff.
    cleanupPid();

    const { spawn } = await import('node:child_process');
    const entry = process.argv[1];
    const args = process.argv.slice(2);
    logger.info({ entry, args }, 'Spawning new instance');
    const child = spawn(process.execPath, [entry, ...args], {
      detached: true,
      stdio: 'ignore',
      cwd: process.cwd(),
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
          execSync('npx tsc', { cwd: config.PKG_DIR, stdio: 'pipe', timeout: 120_000 });
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
