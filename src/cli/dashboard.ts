/**
 * Clementine Command Center — Local web dashboard.
 *
 * Serves an inline HTML SPA with JSON API from Express on localhost.
 * Zero extra deps — uses express, gray-matter, better-sqlite3 (all already installed).
 */

import express from 'express';
import { spawn, execSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  statSync,
  readdirSync,
  mkdirSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import cron from 'node-cron';
import type { Gateway } from '../gateway/router.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_DIR = process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine');
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const DIST_ENTRY = path.join(PACKAGE_ROOT, 'dist', 'cli', 'index.js');
const ENV_PATH = path.join(BASE_DIR, '.env');
const VAULT_DIR = path.join(BASE_DIR, 'vault');
const CRON_FILE = path.join(VAULT_DIR, '00-System', 'CRON.md');
const MEMORY_DB_PATH = path.join(VAULT_DIR, '.memory.db');

// ── Lazy gateway for chat ────────────────────────────────────────────

let gatewayInstance: Gateway | null = null;
let gatewayInitializing = false;

async function getGateway(): Promise<Gateway> {
  if (gatewayInstance) return gatewayInstance;
  if (gatewayInitializing) {
    // Wait for in-progress init
    while (gatewayInitializing) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return gatewayInstance!;
  }
  gatewayInitializing = true;
  try {
    process.env.CLEMENTINE_HOME = BASE_DIR;
    delete process.env['CLAUDECODE'];
    const { PersonalAssistant } = await import('../agent/assistant.js');
    const assistant = new PersonalAssistant();
    const { Gateway: GatewayClass } = await import('../gateway/router.js');
    gatewayInstance = new GatewayClass(assistant);
    const { setApprovalCallback } = await import('../agent/hooks.js');
    setApprovalCallback(async () => false);
    return gatewayInstance;
  } finally {
    gatewayInitializing = false;
  }
}

// ── Memory search (direct DB access, read-only) ─────────────────────

async function searchMemory(query: string, limit = 20): Promise<Array<Record<string, unknown>>> {
  if (!existsSync(MEMORY_DB_PATH)) return [];
  try {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(MEMORY_DB_PATH, { readonly: true });
    const words = query.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) { db.close(); return []; }
    const ftsQuery = words.map((w) => `"${w.replace(/"/g, '')}"`).join(' OR ');
    const rows = db.prepare(
      `SELECT c.id, c.source_file, c.section, c.content, c.chunk_type,
              c.updated_at, c.salience, bm25(chunks_fts) as score
       FROM chunks_fts f
       JOIN chunks c ON c.id = f.rowid
       WHERE chunks_fts MATCH ?
       ORDER BY bm25(chunks_fts)
       LIMIT ?`,
    ).all(ftsQuery, limit) as Array<Record<string, unknown>>;
    db.close();
    return rows;
  } catch {
    return [];
  }
}

// ── Metrics computation ──────────────────────────────────────────────

function computeMetrics(): Record<string, unknown> {
  // Cron run stats
  const runsDir = path.join(BASE_DIR, 'cron', 'runs');
  let totalRuns = 0;
  let successRuns = 0;
  let errorRuns = 0;
  let totalDurationMs = 0;
  let runsToday = 0;
  let runsThisWeek = 0;
  const todayStr = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const jobStats: Array<{ name: string; runs: number; successes: number; avgDurationMs: number; lastRun: string }> = [];

  if (existsSync(runsDir)) {
    try {
      const files = readdirSync(runsDir).filter((f) => f.endsWith('.jsonl'));
      for (const file of files) {
        const filePath = path.join(runsDir, file);
        const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
        let jobRuns = 0;
        let jobSuccesses = 0;
        let jobDurationMs = 0;
        let lastRun = '';
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            totalRuns++;
            jobRuns++;
            if (entry.status === 'ok') { successRuns++; jobSuccesses++; }
            else if (entry.status === 'error') { errorRuns++; }
            if (entry.durationMs) { totalDurationMs += entry.durationMs; jobDurationMs += entry.durationMs; }
            if (entry.startedAt > lastRun) lastRun = entry.startedAt;
            if (entry.startedAt && entry.startedAt.startsWith(todayStr)) runsToday++;
            if (entry.startedAt && entry.startedAt >= weekAgo) runsThisWeek++;
          } catch { /* skip bad lines */ }
        }
        jobStats.push({
          name: file.replace('.jsonl', ''),
          runs: jobRuns,
          successes: jobSuccesses,
          avgDurationMs: jobRuns > 0 ? Math.round(jobDurationMs / jobRuns) : 0,
          lastRun,
        });
      }
    } catch { /* ignore */ }
  }

  // Session stats
  const sessionsFile = path.join(BASE_DIR, '.sessions.json');
  let totalSessions = 0;
  let totalExchanges = 0;
  if (existsSync(sessionsFile)) {
    try {
      const sessions = JSON.parse(readFileSync(sessionsFile, 'utf-8'));
      totalSessions = Object.keys(sessions).length;
      for (const s of Object.values(sessions) as Array<Record<string, unknown>>) {
        totalExchanges += Number(s.exchanges ?? 0);
      }
    } catch { /* ignore */ }
  }

  // Transcript stats from DB (sync — avoid async in this function)
  let transcriptCount = 0;
  let uniqueSessions = 0;

  // Estimate time saved: avg 5 min per cron task, 2 min per exchange
  const estimatedMinutesSaved = (successRuns * 5) + (totalExchanges * 2);

  return {
    cron: {
      totalRuns,
      successRuns,
      errorRuns,
      successRate: totalRuns > 0 ? Math.round((successRuns / totalRuns) * 100) : 0,
      totalDurationMs,
      avgDurationMs: totalRuns > 0 ? Math.round(totalDurationMs / totalRuns) : 0,
      runsToday,
      runsThisWeek,
      jobStats,
    },
    sessions: {
      activeSessions: totalSessions,
      totalExchanges,
      transcriptCount,
      uniqueSessions,
    },
    timeSaved: {
      estimatedMinutes: estimatedMinutesSaved,
      estimatedHours: Math.round(estimatedMinutesSaved / 60 * 10) / 10,
      breakdown: {
        cronMinutes: successRuns * 5,
        chatMinutes: totalExchanges * 2,
      },
    },
  };
}

// ── Helpers (mirrored from index.ts) ─────────────────────────────────

function getAssistantName(): string {
  if (existsSync(ENV_PATH)) {
    const content = readFileSync(ENV_PATH, 'utf-8');
    const match = content.match(/^ASSISTANT_NAME=(.+)$/m);
    if (match) return match[1].trim();
  }
  return 'Clementine';
}

function getPidFilePath(): string {
  const name = getAssistantName().toLowerCase();
  return path.join(BASE_DIR, `.${name}.pid`);
}

function readPid(): number | null {
  const pidFile = getPidFilePath();
  if (!existsSync(pidFile)) return null;
  try {
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getLaunchdLabel(): string {
  return `com.${getAssistantName().toLowerCase()}.assistant`;
}

function getLaunchdPlistPath(): string {
  const home = process.env.HOME ?? '';
  return path.join(home, 'Library', 'LaunchAgents', `${getLaunchdLabel()}.plist`);
}

// ── Data readers ─────────────────────────────────────────────────────

function getStatus(): Record<string, unknown> {
  const pid = readPid();
  const alive = pid ? isProcessAlive(pid) : false;
  const name = getAssistantName();

  let uptime = '';
  if (pid && alive) {
    try {
      const { mtimeMs } = statSync(getPidFilePath());
      const uptimeMs = Date.now() - mtimeMs;
      const hours = Math.floor(uptimeMs / 3600000);
      const minutes = Math.floor((uptimeMs % 3600000) / 60000);
      uptime = `${hours}h ${minutes}m`;
    } catch { /* ignore */ }
  }

  const channels: string[] = [];
  if (existsSync(ENV_PATH)) {
    const env = readFileSync(ENV_PATH, 'utf-8');
    if (/^DISCORD_TOKEN=.+$/m.test(env)) channels.push('Discord');
    if (/^SLACK_BOT_TOKEN=.+$/m.test(env) && /^SLACK_APP_TOKEN=.+$/m.test(env)) channels.push('Slack');
    if (/^TELEGRAM_BOT_TOKEN=.+$/m.test(env)) channels.push('Telegram');
    if (/^TWILIO_ACCOUNT_SID=.+$/m.test(env)) channels.push('WhatsApp');
    if (/^WEBHOOK_ENABLED=true$/m.test(env)) channels.push('Webhook');
  }

  let launchAgent: string | null = null;
  if (process.platform === 'darwin') {
    const plist = getLaunchdPlistPath();
    if (existsSync(plist)) {
      try {
        execSync(`launchctl list ${getLaunchdLabel()}`, { stdio: 'pipe' });
        launchAgent = 'loaded';
      } catch {
        launchAgent = 'installed';
      }
    } else {
      launchAgent = 'not installed';
    }
  }

  return { name, pid, alive, uptime, channels, launchAgent };
}

function getSessions(): Record<string, unknown> {
  const sessionsFile = path.join(BASE_DIR, '.sessions.json');
  if (!existsSync(sessionsFile)) return {};
  try {
    return JSON.parse(readFileSync(sessionsFile, 'utf-8'));
  } catch {
    return {};
  }
}

function getCronJobs(): Record<string, unknown> {
  let jobs: Array<Record<string, unknown>> = [];

  if (existsSync(CRON_FILE)) {
    try {
      const raw = readFileSync(CRON_FILE, 'utf-8');
      const parsed = matter(raw);
      jobs = (parsed.data.jobs ?? []) as Array<Record<string, unknown>>;
    } catch { /* ignore */ }
  }

  // Attach recent run history
  const runsDir = path.join(BASE_DIR, 'cron', 'runs');
  const enriched = jobs.map((job) => {
    const name = String(job.name ?? '');
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const logPath = path.join(runsDir, `${safe}.jsonl`);
    let recentRuns: unknown[] = [];
    if (existsSync(logPath)) {
      try {
        const lines = readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
        recentRuns = lines.slice(-10).map((l) => JSON.parse(l)).reverse();
      } catch { /* ignore */ }
    }
    return { ...job, recentRuns };
  });

  return { jobs: enriched };
}

function getTimers(): unknown[] {
  const timersFile = path.join(BASE_DIR, '.timers.json');
  if (!existsSync(timersFile)) return [];
  try {
    return JSON.parse(readFileSync(timersFile, 'utf-8'));
  } catch {
    return [];
  }
}

function getHeartbeat(): Record<string, unknown> {
  const hbFile = path.join(BASE_DIR, '.heartbeat_state.json');
  if (!existsSync(hbFile)) return {};
  try {
    return JSON.parse(readFileSync(hbFile, 'utf-8'));
  } catch {
    return {};
  }
}

async function getMemory(): Promise<Record<string, unknown>> {
  const memoryFile = path.join(VAULT_DIR, '00-System', 'MEMORY.md');
  let content = '';
  if (existsSync(memoryFile)) {
    try { content = readFileSync(memoryFile, 'utf-8'); } catch { /* ignore */ }
  }

  const dbPath = path.join(VAULT_DIR, '.memory.db');
  let dbStats: Record<string, unknown> = {};
  if (existsSync(dbPath)) {
    try {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(dbPath, { readonly: true });
      const chunkCount = (db.prepare('SELECT COUNT(*) as count FROM chunks').get() as { count: number }).count;
      const fileCount = (db.prepare('SELECT COUNT(DISTINCT source_file) as count FROM chunks').get() as { count: number }).count;
      const { size } = statSync(dbPath);
      dbStats = { chunks: chunkCount, files: fileCount, sizeBytes: size };
      db.close();
    } catch { /* ignore */ }
  }

  return { content: content.slice(0, 5000), dbStats };
}

function getLogs(lines: number): string {
  const logFile = path.join(BASE_DIR, 'logs', 'clementine.log');
  if (!existsSync(logFile)) return '';
  try {
    const content = readFileSync(logFile, 'utf-8');
    const allLines = content.split('\n');
    return allLines.slice(-lines).join('\n');
  } catch {
    return '';
  }
}

// ── CRON CRUD helpers ────────────────────────────────────────────────

function readCronFile(): { parsed: matter.GrayMatterFile<string>; jobs: Array<Record<string, unknown>> } {
  let parsed: matter.GrayMatterFile<string>;
  if (existsSync(CRON_FILE)) {
    const raw = readFileSync(CRON_FILE, 'utf-8');
    parsed = matter(raw);
  } else {
    const dir = path.dirname(CRON_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    parsed = matter('');
    parsed.data = {};
  }
  const jobs = (parsed.data.jobs ?? []) as Array<Record<string, unknown>>;
  return { parsed, jobs };
}

function writeCronFile(parsed: matter.GrayMatterFile<string>, jobs: Array<Record<string, unknown>>): void {
  parsed.data.jobs = jobs;
  const output = matter.stringify(parsed.content, parsed.data);
  writeFileSync(CRON_FILE, output);
}

// ── Express app ──────────────────────────────────────────────────────

export async function cmdDashboard(opts: { port?: string }): Promise<void> {
  const port = parseInt(opts.port ?? '3030', 10);
  const app = express();
  app.use(express.json());

  // ── GET routes ───────────────────────────────────────────────────

  app.get('/', (_req, res) => {
    res.type('html').send(getDashboardHTML());
  });

  app.get('/api/status', (_req, res) => {
    res.json(getStatus());
  });

  app.get('/api/sessions', (_req, res) => {
    res.json(getSessions());
  });

  app.get('/api/cron', (_req, res) => {
    res.json(getCronJobs());
  });

  app.get('/api/timers', (_req, res) => {
    res.json(getTimers());
  });

  app.get('/api/heartbeat', (_req, res) => {
    res.json(getHeartbeat());
  });

  app.get('/api/memory', async (_req, res) => {
    res.json(await getMemory());
  });

  app.get('/api/logs', (req, res) => {
    const lines = parseInt(String(req.query.lines ?? '200'), 10);
    res.json({ content: getLogs(lines) });
  });

  // ── POST routes (actions) ──────────────────────────────────────

  app.post('/api/cron/run/:job', (req, res) => {
    const jobName = req.params.job;
    try {
      const child = spawn('node', [DIST_ENTRY, 'cron', 'run', jobName], {
        detached: true,
        stdio: 'ignore',
        cwd: BASE_DIR,
        env: { ...process.env, CLEMENTINE_HOME: BASE_DIR },
      });
      child.unref();
      res.json({ ok: true, message: `Triggered cron job: ${jobName}` });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/restart', (_req, res) => {
    const pid = readPid();
    if (!pid || !isProcessAlive(pid)) {
      res.status(400).json({ error: 'Daemon is not running' });
      return;
    }
    try {
      process.kill(pid, 'SIGUSR1');
      res.json({ ok: true, message: 'Sent SIGUSR1 (restart signal)' });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/stop', (_req, res) => {
    const pid = readPid();
    if (!pid || !isProcessAlive(pid)) {
      res.status(400).json({ error: 'Daemon is not running' });
      return;
    }
    try {
      if (process.platform === 'darwin') {
        const plist = getLaunchdPlistPath();
        if (existsSync(plist)) {
          try { execSync(`launchctl unload "${plist}"`, { stdio: 'pipe' }); } catch { /* ignore */ }
        }
      }
      process.kill(pid, 'SIGTERM');
      res.json({ ok: true, message: `Sent SIGTERM to PID ${pid}` });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/launch', (_req, res) => {
    const pid = readPid();
    if (pid && isProcessAlive(pid)) {
      res.status(400).json({ error: 'Daemon is already running' });
      return;
    }
    try {
      const logDir = path.join(BASE_DIR, 'logs');
      if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
      const distEntry = path.join(PACKAGE_ROOT, 'dist', 'index.js');
      const child = spawn('node', [distEntry], {
        detached: true,
        stdio: 'ignore',
        cwd: BASE_DIR,
        env: { ...process.env, CLEMENTINE_HOME: BASE_DIR },
      });
      child.unref();
      if (child.pid) {
        writeFileSync(getPidFilePath(), String(child.pid));
      }
      res.json({ ok: true, message: `Daemon started (PID ${child.pid})` });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/sessions/:key/clear', (req, res) => {
    const key = req.params.key;
    const sessionsFile = path.join(BASE_DIR, '.sessions.json');
    try {
      if (!existsSync(sessionsFile)) {
        res.status(404).json({ error: 'No sessions file' });
        return;
      }
      const sessions = JSON.parse(readFileSync(sessionsFile, 'utf-8'));
      if (!(key in sessions)) {
        res.status(404).json({ error: `Session "${key}" not found` });
        return;
      }
      delete sessions[key];
      writeFileSync(sessionsFile, JSON.stringify(sessions, null, 2));
      res.json({ ok: true, message: `Cleared session: ${key}` });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/timers/:id/cancel', (req, res) => {
    const timerId = req.params.id;
    const timersFile = path.join(BASE_DIR, '.timers.json');
    try {
      if (!existsSync(timersFile)) {
        res.status(404).json({ error: 'No timers file' });
        return;
      }
      const timers = JSON.parse(readFileSync(timersFile, 'utf-8')) as unknown[];
      const idx = (timers as Array<Record<string, unknown>>).findIndex(
        (t) => String(t.id) === timerId,
      );
      if (idx === -1) {
        res.status(404).json({ error: `Timer "${timerId}" not found` });
        return;
      }
      timers.splice(idx, 1);
      writeFileSync(timersFile, JSON.stringify(timers, null, 2));
      res.json({ ok: true, message: `Cancelled timer: ${timerId}` });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── CRON CRUD routes ──────────────────────────────────────────

  app.post('/api/cron', (req, res) => {
    try {
      const { name, schedule, prompt, tier, enabled } = req.body;
      if (!name || !schedule || !prompt) {
        res.status(400).json({ error: 'name, schedule, and prompt are required' });
        return;
      }
      if (!cron.validate(schedule)) {
        res.status(400).json({ error: `Invalid cron expression: ${schedule}` });
        return;
      }
      const { parsed, jobs } = readCronFile();
      const duplicate = jobs.find(
        (j) => String(j.name ?? '').toLowerCase() === String(name).toLowerCase(),
      );
      if (duplicate) {
        res.status(409).json({ error: `A job named "${name}" already exists` });
        return;
      }
      const tierNum = parseInt(String(tier ?? '1'), 10);
      jobs.push({
        name: String(name),
        schedule: String(schedule),
        prompt: String(prompt),
        enabled: enabled !== false,
        tier: isNaN(tierNum) ? 1 : tierNum,
      });
      writeCronFile(parsed, jobs);
      res.json({ ok: true, message: `Created cron job: ${name}` });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.put('/api/cron/:name', (req, res) => {
    try {
      const jobName = req.params.name;
      const { parsed, jobs } = readCronFile();
      const idx = jobs.findIndex(
        (j) => String(j.name ?? '').toLowerCase() === jobName.toLowerCase(),
      );
      if (idx === -1) {
        res.status(404).json({ error: `Job "${jobName}" not found` });
        return;
      }
      const updates = req.body;
      if (updates.schedule && !cron.validate(updates.schedule)) {
        res.status(400).json({ error: `Invalid cron expression: ${updates.schedule}` });
        return;
      }
      // Apply updates
      if (updates.schedule !== undefined) jobs[idx].schedule = String(updates.schedule);
      if (updates.prompt !== undefined) jobs[idx].prompt = String(updates.prompt);
      if (updates.enabled !== undefined) jobs[idx].enabled = Boolean(updates.enabled);
      if (updates.tier !== undefined) {
        const t = parseInt(String(updates.tier), 10);
        if (!isNaN(t)) jobs[idx].tier = t;
      }
      if (updates.name !== undefined && updates.name !== jobName) {
        // Rename — check for duplicates
        const dup = jobs.find(
          (j, i) => i !== idx && String(j.name ?? '').toLowerCase() === String(updates.name).toLowerCase(),
        );
        if (dup) {
          res.status(409).json({ error: `A job named "${updates.name}" already exists` });
          return;
        }
        jobs[idx].name = String(updates.name);
      }
      writeCronFile(parsed, jobs);
      res.json({ ok: true, message: `Updated cron job: ${jobs[idx].name}` });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/cron/:name/toggle', (req, res) => {
    try {
      const jobName = req.params.name;
      const { parsed, jobs } = readCronFile();
      const idx = jobs.findIndex(
        (j) => String(j.name ?? '').toLowerCase() === jobName.toLowerCase(),
      );
      if (idx === -1) {
        res.status(404).json({ error: `Job "${jobName}" not found` });
        return;
      }
      jobs[idx].enabled = !jobs[idx].enabled;
      writeCronFile(parsed, jobs);
      const state = jobs[idx].enabled ? 'enabled' : 'disabled';
      res.json({ ok: true, message: `${jobName} is now ${state}` });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.delete('/api/cron/:name', (req, res) => {
    try {
      const jobName = req.params.name;
      const { parsed, jobs } = readCronFile();
      const idx = jobs.findIndex(
        (j) => String(j.name ?? '').toLowerCase() === jobName.toLowerCase(),
      );
      if (idx === -1) {
        res.status(404).json({ error: `Job "${jobName}" not found` });
        return;
      }
      jobs.splice(idx, 1);
      writeCronFile(parsed, jobs);
      res.json({ ok: true, message: `Deleted cron job: ${jobName}` });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Chat route ────────────────────────────────────────────────────

  app.post('/api/chat', async (req, res) => {
    const { message } = req.body;
    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'message is required' });
      return;
    }
    try {
      const gateway = await getGateway();
      const response = await gateway.handleMessage('dashboard:web', message);
      res.json({ ok: true, response });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Memory search route ───────────────────────────────────────────

  app.get('/api/memory/search', async (req, res) => {
    const q = String(req.query.q ?? '');
    if (!q.trim()) {
      res.json({ results: [] });
      return;
    }
    try {
      const results = await searchMemory(q, 20);
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Metrics route ─────────────────────────────────────────────────

  app.get('/api/metrics', (_req, res) => {
    res.json(computeMetrics());
  });

  // ── Start server (auto-increment port if taken) ──────────────────

  const maxAttempts = 10;
  let actualPort = port;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const server = app.listen(actualPort, '127.0.0.1');
        server.once('listening', () => {
          const name = getAssistantName();
          console.log();
          console.log(`  ${name} Command Center`);
          console.log(`  http://localhost:${actualPort}`);
          if (actualPort !== port) {
            console.log(`  (port ${port} was in use)`);
          }
          console.log();
          console.log('  Press Ctrl+C to stop');
          console.log();
          resolve();
        });
        server.once('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            server.close();
            reject(err);
          } else {
            reject(err);
          }
        });
      });
      break; // successfully listening
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        actualPort++;
        if (attempt === maxAttempts - 1) {
          console.error(`  Could not find an open port (tried ${port}-${actualPort}).`);
          process.exit(1);
        }
      } else {
        throw err;
      }
    }
  }

  // Try to open in browser
  try {
    if (process.platform === 'darwin') {
      execSync(`open http://localhost:${actualPort}`, { stdio: 'ignore' });
    }
  } catch { /* ignore */ }

  // Keep alive
  await new Promise<void>(() => {});
}

// ── Inline HTML Dashboard ────────────────────────────────────────────

function getDashboardHTML(): string {
  const name = getAssistantName();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} Command Center</title>
<style>
  :root {
    --bg-primary: #0a0e14;
    --bg-secondary: #11161d;
    --bg-card: #151b24;
    --bg-hover: #1a2230;
    --bg-input: #0d1219;
    --border: #1e2a3a;
    --border-light: #263245;
    --text-primary: #e6edf3;
    --text-secondary: #8b9eb0;
    --text-muted: #5a6a7e;
    --accent: #4d9eff;
    --accent-glow: rgba(77, 158, 255, 0.15);
    --green: #2ea043;
    --green-bg: rgba(46, 160, 67, 0.12);
    --red: #e5534b;
    --red-bg: rgba(229, 83, 75, 0.12);
    --yellow: #d4a72c;
    --yellow-bg: rgba(212, 167, 44, 0.12);
    --orange: #f0883e;
    --sidebar-w: 220px;
    --header-h: 56px;
    --radius: 8px;
    --radius-sm: 5px;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif;
    background: var(--bg-primary);
    color: var(--text-primary);
    min-height: 100vh;
    overflow: hidden;
  }

  /* ── Layout ─────────────────────────────── */
  .layout {
    display: grid;
    grid-template-columns: var(--sidebar-w) 1fr;
    grid-template-rows: var(--header-h) 1fr;
    height: 100vh;
  }

  /* ── Header ─────────────────────────────── */
  header {
    grid-column: 1 / -1;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
    padding: 0 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    z-index: 10;
  }
  .header-left {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .logo {
    width: 28px; height: 28px;
    border-radius: 50%;
    background: linear-gradient(135deg, var(--accent), #7c3aed);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    font-weight: 700;
    color: #fff;
    flex-shrink: 0;
  }
  header h1 {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-primary);
    letter-spacing: -0.01em;
  }
  header h1 span { color: var(--accent); }
  .header-right {
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .status-pill {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 12px;
    border-radius: 20px;
    font-size: 12px;
    font-weight: 500;
  }
  .status-pill.online { background: var(--green-bg); color: var(--green); }
  .status-pill.offline { background: var(--red-bg); color: var(--red); }
  .pulse-dot {
    width: 7px; height: 7px;
    border-radius: 50%;
    background: currentColor;
    animation: pulse 2s infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
  .header-meta {
    font-size: 11px;
    color: var(--text-muted);
  }

  /* ── Sidebar ────────────────────────────── */
  .sidebar {
    background: var(--bg-secondary);
    border-right: 1px solid var(--border);
    padding: 16px 0;
    overflow-y: auto;
  }
  .nav-section {
    padding: 0 12px;
    margin-bottom: 20px;
  }
  .nav-section-title {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    padding: 0 12px;
    margin-bottom: 6px;
  }
  .nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border-radius: var(--radius-sm);
    font-size: 13px;
    color: var(--text-secondary);
    cursor: pointer;
    transition: all 0.15s;
    user-select: none;
  }
  .nav-item:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .nav-item.active {
    background: var(--accent-glow);
    color: var(--accent);
  }
  .nav-icon {
    width: 18px;
    text-align: center;
    font-size: 14px;
    flex-shrink: 0;
  }
  .nav-badge {
    margin-left: auto;
    background: var(--bg-hover);
    color: var(--text-muted);
    font-size: 10px;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 10px;
    min-width: 18px;
    text-align: center;
  }
  .nav-item.active .nav-badge {
    background: var(--accent-glow);
    color: var(--accent);
  }

  /* ── Content ────────────────────────────── */
  .content {
    overflow-y: auto;
    padding: 24px;
  }
  .page { display: none; }
  .page.active { display: block; }
  .page-title {
    font-size: 20px;
    font-weight: 600;
    margin-bottom: 20px;
    color: var(--text-primary);
  }

  /* ── Cards ──────────────────────────────── */
  .card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 16px;
    overflow: hidden;
  }
  .card-header {
    padding: 14px 18px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
  }
  .card-body {
    padding: 18px;
    font-size: 13px;
    line-height: 1.7;
  }
  .grid-2 {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
    gap: 16px;
  }

  /* ── KV rows ────────────────────────────── */
  .kv-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 0;
    border-bottom: 1px solid rgba(30, 42, 58, 0.5);
  }
  .kv-row:last-child { border-bottom: none; }
  .kv-key { color: var(--text-secondary); font-size: 12px; }
  .kv-val { color: var(--text-primary); font-weight: 500; font-size: 13px; }

  /* ── Badges ─────────────────────────────── */
  .badge {
    display: inline-flex;
    align-items: center;
    padding: 3px 10px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 600;
    gap: 5px;
  }
  .badge-green { background: var(--green-bg); color: var(--green); }
  .badge-red { background: var(--red-bg); color: var(--red); }
  .badge-yellow { background: var(--yellow-bg); color: var(--yellow); }
  .badge-gray { background: rgba(90,106,126,0.15); color: var(--text-muted); }
  .badge-accent { background: var(--accent-glow); color: var(--accent); }
  .badge-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: currentColor;
  }

  /* ── Buttons ────────────────────────────── */
  button, .btn {
    background: var(--bg-hover);
    color: var(--text-primary);
    border: 1px solid var(--border-light);
    border-radius: var(--radius-sm);
    padding: 6px 14px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
    font-family: inherit;
  }
  button:hover, .btn:hover {
    background: var(--border-light);
  }
  .btn-sm { padding: 4px 10px; font-size: 11px; }
  .btn-primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .btn-primary:hover {
    background: #3d8ae8;
    border-color: #3d8ae8;
  }
  .btn-success {
    border-color: var(--green);
    color: var(--green);
  }
  .btn-success:hover { background: var(--green-bg); }
  .btn-danger {
    border-color: var(--red);
    color: var(--red);
  }
  .btn-danger:hover { background: var(--red-bg); }
  .btn-ghost {
    background: transparent;
    border-color: transparent;
    color: var(--text-secondary);
  }
  .btn-ghost:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .btn-group {
    display: flex;
    gap: 8px;
  }

  /* ── Tables ─────────────────────────────── */
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  th {
    text-align: left;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    color: var(--text-muted);
    font-weight: 500;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  td {
    padding: 10px 12px;
    border-bottom: 1px solid rgba(30, 42, 58, 0.4);
    vertical-align: middle;
  }
  tr:hover td {
    background: rgba(26, 34, 48, 0.5);
  }
  .empty-state {
    text-align: center;
    padding: 32px;
    color: var(--text-muted);
    font-size: 13px;
  }

  /* ── Forms ──────────────────────────────── */
  .form-group {
    margin-bottom: 16px;
  }
  .form-label {
    display: block;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-secondary);
    margin-bottom: 6px;
  }
  .form-hint {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 4px;
  }
  input[type="text"], textarea, select {
    width: 100%;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 9px 12px;
    font-size: 13px;
    font-family: inherit;
    color: var(--text-primary);
    transition: border-color 0.15s;
  }
  input[type="text"]:focus, textarea:focus, select:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-glow);
  }
  textarea {
    resize: vertical;
    min-height: 80px;
    line-height: 1.5;
  }
  select {
    cursor: pointer;
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%235a6a7e' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 10px center;
    padding-right: 30px;
  }
  .form-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .toggle {
    position: relative;
    width: 36px;
    height: 20px;
    background: var(--border-light);
    border-radius: 10px;
    cursor: pointer;
    transition: background 0.2s;
    flex-shrink: 0;
  }
  .toggle.on { background: var(--green); }
  .toggle::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #fff;
    transition: transform 0.2s;
  }
  .toggle.on::after { transform: translateX(16px); }

  /* ── Modal ──────────────────────────────── */
  .modal-overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.6);
    backdrop-filter: blur(4px);
    z-index: 100;
    align-items: center;
    justify-content: center;
  }
  .modal-overlay.show { display: flex; }
  .modal {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 12px;
    width: 520px;
    max-width: 90vw;
    max-height: 90vh;
    overflow-y: auto;
    box-shadow: 0 20px 60px rgba(0,0,0,0.5);
  }
  .modal-header {
    padding: 18px 22px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .modal-header h3 {
    font-size: 15px;
    font-weight: 600;
  }
  .modal-body { padding: 22px; }
  .modal-footer {
    padding: 14px 22px;
    border-top: 1px solid var(--border);
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  /* ── Logs ───────────────────────────────── */
  .log-viewer {
    background: var(--bg-input);
    border-radius: var(--radius);
    padding: 14px;
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace;
    font-size: 11px;
    line-height: 1.7;
    white-space: pre-wrap;
    word-break: break-all;
    color: var(--text-secondary);
    max-height: calc(100vh - 240px);
    overflow-y: auto;
  }
  .log-toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
  }
  .log-filter {
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 6px 10px;
    font-size: 12px;
    color: var(--text-primary);
    font-family: inherit;
    width: 240px;
  }
  .log-filter:focus {
    outline: none;
    border-color: var(--accent);
  }

  /* ── Memory ─────────────────────────────── */
  .memory-preview {
    background: var(--bg-input);
    border-radius: var(--radius);
    padding: 14px;
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 11px;
    line-height: 1.7;
    white-space: pre-wrap;
    color: var(--text-secondary);
    max-height: 400px;
    overflow-y: auto;
  }

  /* ── Toast ──────────────────────────────── */
  .toast-container {
    position: fixed;
    top: 68px;
    right: 20px;
    z-index: 200;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .toast {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 10px 16px;
    font-size: 13px;
    animation: toastIn 0.3s ease;
    box-shadow: 0 8px 24px rgba(0,0,0,0.3);
    max-width: 360px;
  }
  .toast.success { border-left: 3px solid var(--green); }
  .toast.error { border-left: 3px solid var(--red); }
  @keyframes toastIn {
    from { transform: translateX(40px); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }

  /* ── Cron run history detail ────────────── */
  .run-history {
    margin-top: 8px;
  }
  .run-entry {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 0;
    font-size: 11px;
    color: var(--text-muted);
  }
  .run-entry .badge { font-size: 10px; padding: 1px 6px; }

  /* ── Stat tiles ─────────────────────────── */
  .stat-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 12px;
    margin-bottom: 20px;
  }
  .stat-tile {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
  }
  .stat-value {
    font-size: 24px;
    font-weight: 700;
    color: var(--text-primary);
    margin-bottom: 4px;
  }
  .stat-label {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  /* ── Overview specific ──────────────────── */
  .overview-actions {
    display: flex;
    gap: 8px;
    margin-bottom: 20px;
  }

  /* ── Scrollbar ──────────────────────────── */
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--border-light); }

  /* ── Chat ───────────────────────────────── */
  .chat-bubble {
    max-width: 80%;
    padding: 10px 14px;
    border-radius: 12px;
    font-size: 13px;
    line-height: 1.6;
    margin-bottom: 10px;
    word-wrap: break-word;
    white-space: pre-wrap;
  }
  .chat-bubble.user {
    background: var(--accent);
    color: #fff;
    margin-left: auto;
    border-bottom-right-radius: 4px;
  }
  .chat-bubble.assistant {
    background: var(--bg-hover);
    color: var(--text-primary);
    border-bottom-left-radius: 4px;
  }
  .chat-bubble .chat-meta {
    font-size: 10px;
    color: rgba(255,255,255,0.6);
    margin-top: 4px;
  }
  .chat-bubble.assistant .chat-meta {
    color: var(--text-muted);
  }
  .chat-typing {
    display: flex;
    gap: 4px;
    padding: 12px 14px;
    align-items: center;
  }
  .chat-typing span {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--text-muted);
    animation: typing 1.2s infinite;
  }
  .chat-typing span:nth-child(2) { animation-delay: 0.2s; }
  .chat-typing span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes typing {
    0%, 100% { opacity: 0.3; transform: translateY(0); }
    50% { opacity: 1; transform: translateY(-3px); }
  }

  /* ── Search results ─────────────────────── */
  .search-result {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 18px;
    margin-bottom: 10px;
    transition: border-color 0.15s;
  }
  .search-result:hover { border-color: var(--accent); }
  .search-result-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }
  .search-result-file {
    font-size: 12px;
    font-weight: 600;
    color: var(--accent);
  }
  .search-result-section {
    font-size: 11px;
    color: var(--text-muted);
  }
  .search-result-content {
    font-size: 12px;
    color: var(--text-secondary);
    line-height: 1.6;
    white-space: pre-wrap;
    max-height: 120px;
    overflow: hidden;
  }
  .search-result-score {
    font-size: 10px;
    color: var(--text-muted);
  }

  /* ── Metrics ────────────────────────────── */
  .metric-hero {
    background: linear-gradient(135deg, var(--accent-glow), rgba(46,160,67,0.1));
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 28px;
    text-align: center;
    margin-bottom: 20px;
  }
  .metric-hero-value {
    font-size: 48px;
    font-weight: 800;
    color: var(--accent);
    line-height: 1;
  }
  .metric-hero-label {
    font-size: 14px;
    color: var(--text-secondary);
    margin-top: 6px;
  }
  .metric-hero-sub {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 4px;
  }
  .metric-bar-track {
    background: var(--bg-input);
    border-radius: 4px;
    height: 8px;
    overflow: hidden;
    margin-top: 4px;
  }
  .metric-bar-fill {
    height: 100%;
    border-radius: 4px;
    transition: width 0.5s ease;
  }
</style>
</head>
<body>
<div class="layout">
  <!-- Header -->
  <header>
    <div class="header-left">
      <div class="logo">${name.charAt(0).toUpperCase()}</div>
      <h1><span>${name}</span> Command Center</h1>
    </div>
    <div class="header-right">
      <div class="status-pill" id="header-status">
        <div class="pulse-dot"></div>
        <span>Loading...</span>
      </div>
      <div class="header-meta" id="last-update"></div>
    </div>
  </header>

  <!-- Sidebar -->
  <nav class="sidebar">
    <div class="nav-section">
      <div class="nav-section-title">Overview</div>
      <div class="nav-item active" data-page="overview">
        <span class="nav-icon">&#9679;</span> Dashboard
      </div>
      <div class="nav-item" data-page="metrics">
        <span class="nav-icon">&#128200;</span> Metrics
      </div>
    </div>
    <div class="nav-section">
      <div class="nav-section-title">Interact</div>
      <div class="nav-item" data-page="chat">
        <span class="nav-icon">&#128172;</span> Chat
      </div>
      <div class="nav-item" data-page="search">
        <span class="nav-icon">&#128269;</span> Search Memory
      </div>
    </div>
    <div class="nav-section">
      <div class="nav-section-title">Automation</div>
      <div class="nav-item" data-page="cron">
        <span class="nav-icon">&#9200;</span> Scheduled Tasks
        <span class="nav-badge" id="nav-cron-count">0</span>
      </div>
      <div class="nav-item" data-page="timers">
        <span class="nav-icon">&#9203;</span> Timers
        <span class="nav-badge" id="nav-timer-count">0</span>
      </div>
    </div>
    <div class="nav-section">
      <div class="nav-section-title">System</div>
      <div class="nav-item" data-page="sessions">
        <span class="nav-icon">&#128488;</span> Sessions
        <span class="nav-badge" id="nav-session-count">0</span>
      </div>
      <div class="nav-item" data-page="memory">
        <span class="nav-icon">&#129504;</span> Memory
      </div>
      <div class="nav-item" data-page="logs">
        <span class="nav-icon">&#128220;</span> Logs
      </div>
    </div>
  </nav>

  <!-- Content -->
  <div class="content">

    <!-- ═══ Overview Page ═══ -->
    <div class="page active" id="page-overview">
      <div class="page-title">Dashboard</div>
      <div class="stat-grid" id="stat-tiles"></div>
      <div class="overview-actions" id="daemon-controls"></div>
      <div class="grid-2">
        <div class="card">
          <div class="card-header">Daemon Status</div>
          <div class="card-body" id="panel-status"><div class="empty-state">Loading...</div></div>
        </div>
        <div class="card">
          <div class="card-header">Heartbeat</div>
          <div class="card-body" id="panel-heartbeat"><div class="empty-state">Loading...</div></div>
        </div>
        <div class="card" id="card-launchagent" style="display:none">
          <div class="card-header">LaunchAgent (macOS)</div>
          <div class="card-body" id="panel-launchagent"><div class="empty-state">Loading...</div></div>
        </div>
      </div>
    </div>

    <!-- ═══ Cron / Scheduled Tasks Page ═══ -->
    <div class="page" id="page-cron">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
        <div class="page-title" style="margin-bottom:0">Scheduled Tasks</div>
        <button class="btn-primary" onclick="openCreateCronModal()">+ New Task</button>
      </div>
      <div class="card">
        <div class="card-body" id="panel-cron" style="padding:0"><div class="empty-state">Loading...</div></div>
      </div>
    </div>

    <!-- ═══ Timers Page ═══ -->
    <div class="page" id="page-timers">
      <div class="page-title">Pending Timers</div>
      <div class="card">
        <div class="card-body" id="panel-timers"><div class="empty-state">Loading...</div></div>
      </div>
    </div>

    <!-- ═══ Sessions Page ═══ -->
    <div class="page" id="page-sessions">
      <div class="page-title">Active Sessions</div>
      <div class="card">
        <div class="card-body" id="panel-sessions"><div class="empty-state">Loading...</div></div>
      </div>
    </div>

    <!-- ═══ Memory Page ═══ -->
    <div class="page" id="page-memory">
      <div class="page-title">Memory</div>
      <div class="grid-2" id="memory-stats"></div>
      <div class="card">
        <div class="card-header">MEMORY.md</div>
        <div class="card-body" id="panel-memory"><div class="empty-state">Loading...</div></div>
      </div>
    </div>

    <!-- ═══ Logs Page ═══ -->
    <div class="page" id="page-logs">
      <div class="page-title">Logs</div>
      <div class="log-toolbar">
        <input type="text" class="log-filter" id="log-filter" placeholder="Filter logs...">
        <button onclick="refreshLogs()">Refresh</button>
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-secondary);cursor:pointer">
          <input type="checkbox" id="log-autoscroll" checked> Auto-scroll
        </label>
      </div>
      <div class="log-viewer" id="panel-logs"><div class="empty-state">Loading...</div></div>
    </div>

    <!-- ═══ Chat Page ═══ -->
    <div class="page" id="page-chat">
      <div class="page-title">Chat with ${name}</div>
      <div class="card" style="height:calc(100vh - 180px);display:flex;flex-direction:column">
        <div class="card-body" id="chat-messages" style="flex:1;overflow-y:auto;padding:16px">
          <div class="empty-state">Send a message to start a conversation.</div>
        </div>
        <div style="border-top:1px solid var(--border);padding:14px;display:flex;gap:10px">
          <input type="text" id="chat-input" placeholder="Type a message..." style="flex:1" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendChat()}">
          <button class="btn-primary" id="chat-send-btn" onclick="sendChat()">Send</button>
        </div>
      </div>
    </div>

    <!-- ═══ Search Memory Page ═══ -->
    <div class="page" id="page-search">
      <div class="page-title">Search Memory</div>
      <div style="display:flex;gap:10px;margin-bottom:16px">
        <input type="text" id="memory-search-input" placeholder="Search vault, notes, memory..." style="flex:1" onkeydown="if(event.key==='Enter')runMemorySearch()">
        <button class="btn-primary" onclick="runMemorySearch()">Search</button>
      </div>
      <div id="memory-search-results"></div>
    </div>

    <!-- ═══ Metrics Page ═══ -->
    <div class="page" id="page-metrics">
      <div class="page-title">Metrics & Analytics</div>
      <div id="metrics-content"><div class="empty-state">Loading metrics...</div></div>
    </div>

  </div><!-- /content -->
</div><!-- /layout -->

<!-- ═══ Create/Edit Cron Modal ═══ -->
<div class="modal-overlay" id="cron-modal">
  <div class="modal">
    <div class="modal-header">
      <h3 id="cron-modal-title">New Scheduled Task</h3>
      <button class="btn-ghost btn-sm" onclick="closeCronModal()">&times;</button>
    </div>
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">Task Name</label>
        <input type="text" id="cron-name" placeholder="e.g. morning-briefing">
        <div class="form-hint">Unique identifier. Use lowercase with dashes.</div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Schedule (cron expression)</label>
          <input type="text" id="cron-schedule" placeholder="0 9 * * *">
          <div class="form-hint" id="cron-schedule-hint">minute hour day month weekday</div>
        </div>
        <div class="form-group">
          <label class="form-label">Tier</label>
          <select id="cron-tier">
            <option value="1">Tier 1 (Standard)</option>
            <option value="2">Tier 2 (Extended)</option>
            <option value="3">Tier 3 (Full access)</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Prompt</label>
        <textarea id="cron-prompt" rows="5" placeholder="What should the AI do when this task runs?"></textarea>
        <div class="form-hint">The instruction sent to the AI agent when this task fires.</div>
      </div>
    </div>
    <div class="modal-footer">
      <button onclick="closeCronModal()">Cancel</button>
      <button class="btn-primary" id="cron-modal-save" onclick="saveCronJob()">Create Task</button>
    </div>
  </div>
</div>

<!-- ═══ Confirm Delete Modal ═══ -->
<div class="modal-overlay" id="confirm-modal">
  <div class="modal" style="width:380px">
    <div class="modal-header">
      <h3>Confirm Delete</h3>
      <button class="btn-ghost btn-sm" onclick="closeConfirmModal()">&times;</button>
    </div>
    <div class="modal-body">
      <p id="confirm-message" style="font-size:13px;color:var(--text-secondary)"></p>
    </div>
    <div class="modal-footer">
      <button onclick="closeConfirmModal()">Cancel</button>
      <button class="btn-danger" id="confirm-action">Delete</button>
    </div>
  </div>
</div>

<div class="toast-container" id="toasts"></div>

<script>
// ── Utilities ─────────────────────────────
function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s ?? '');
  return d.innerHTML;
}
function timeAgo(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return Math.round(ms/1000) + 's ago';
  if (ms < 3600000) return Math.round(ms/60000) + 'm ago';
  if (ms < 86400000) return Math.round(ms/3600000) + 'h ago';
  return Math.round(ms/86400000) + 'd ago';
}
function toast(msg, type) {
  const el = document.createElement('div');
  el.className = 'toast ' + (type || '');
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ── Navigation ────────────────────────────
let currentPage = 'overview';
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    const page = item.dataset.page;
    if (!page) return;
    currentPage = page;
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    item.classList.add('active');
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const el = document.getElementById('page-' + page);
    if (el) el.classList.add('active');
    // Refresh relevant data
    if (page === 'logs') refreshLogs();
    if (page === 'memory') refreshMemory();
    if (page === 'metrics') refreshMetrics();
    if (page === 'chat') document.getElementById('chat-input').focus();
  });
});

// ── API helpers ───────────────────────────
async function apiPost(url) {
  try {
    const r = await fetch(url, { method: 'POST' });
    const d = await r.json();
    if (d.ok) toast(d.message, 'success');
    else toast(d.error || 'Error', 'error');
    setTimeout(refreshAll, 1000);
  } catch(e) { toast(String(e), 'error'); }
}
async function apiJson(method, url, body) {
  try {
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (d.ok) toast(d.message, 'success');
    else toast(d.error || 'Error', 'error');
    setTimeout(refreshAll, 500);
    return d;
  } catch(e) { toast(String(e), 'error'); return null; }
}
async function apiDelete(url) {
  try {
    const r = await fetch(url, { method: 'DELETE' });
    const d = await r.json();
    if (d.ok) toast(d.message, 'success');
    else toast(d.error || 'Error', 'error');
    setTimeout(refreshAll, 500);
  } catch(e) { toast(String(e), 'error'); }
}

// ── Status + Overview ─────────────────────
let lastStatusData = {};
async function refreshStatus() {
  try {
    const r = await fetch('/api/status');
    const d = await r.json();
    lastStatusData = d;

    // Header status pill
    const pill = document.getElementById('header-status');
    pill.className = 'status-pill ' + (d.alive ? 'online' : 'offline');
    pill.innerHTML = '<div class="pulse-dot"></div><span>' + (d.alive ? 'Online' : 'Offline') + '</span>';

    // Stat tiles
    const tiles = document.getElementById('stat-tiles');
    tiles.innerHTML =
      '<div class="stat-tile"><div class="stat-value">' + (d.alive ? '<span style="color:var(--green)">Online</span>' : '<span style="color:var(--red)">Offline</span>') + '</div><div class="stat-label">Daemon</div></div>'
      + '<div class="stat-tile"><div class="stat-value">' + esc(d.uptime || '--') + '</div><div class="stat-label">Uptime</div></div>'
      + '<div class="stat-tile"><div class="stat-value">' + (d.channels ? d.channels.length : 0) + '</div><div class="stat-label">Channels</div></div>'
      + '<div class="stat-tile"><div class="stat-value" id="stat-cron-count">--</div><div class="stat-label">Scheduled Tasks</div></div>';

    // Daemon controls
    const controls = document.getElementById('daemon-controls');
    if (d.alive) {
      controls.innerHTML = '<button class="btn-success" onclick="apiPost(\\'/api/restart\\')">Restart Daemon</button>'
        + '<button class="btn-danger" onclick="apiPost(\\'/api/stop\\')">Stop Daemon</button>';
    } else {
      controls.innerHTML = '<button class="btn-primary" onclick="apiPost(\\'/api/launch\\')">Start Daemon</button>';
    }

    // Status card
    let html = '';
    html += kv('Status', '<span class="badge ' + (d.alive ? 'badge-green' : 'badge-red') + '"><span class="badge-dot"></span>' + (d.alive ? 'Running' : 'Stopped') + '</span>');
    if (d.pid) html += kv('PID', d.pid);
    if (d.uptime) html += kv('Uptime', d.uptime);
    if (d.channels && d.channels.length > 0) {
      html += kv('Channels', d.channels.map(c => '<span class="badge badge-accent">' + esc(c) + '</span> ').join(''));
    }
    document.getElementById('panel-status').innerHTML = html;

    // LaunchAgent
    if (d.launchAgent) {
      document.getElementById('card-launchagent').style.display = '';
      const laBadge = d.launchAgent === 'loaded' ? 'badge-green' : d.launchAgent === 'installed' ? 'badge-yellow' : 'badge-gray';
      document.getElementById('panel-launchagent').innerHTML = kv('Status', '<span class="badge ' + laBadge + '">' + esc(d.launchAgent) + '</span>');
    }
  } catch(e) { }
}

function kv(key, val) {
  return '<div class="kv-row"><span class="kv-key">' + esc(key) + '</span><span class="kv-val">' + val + '</span></div>';
}

// ── Sessions ──────────────────────────────
async function refreshSessions() {
  try {
    const r = await fetch('/api/sessions');
    const d = await r.json();
    const keys = Object.keys(d);
    document.getElementById('nav-session-count').textContent = keys.length;
    if (keys.length === 0) {
      document.getElementById('panel-sessions').innerHTML = '<div class="empty-state">No active sessions</div>';
      return;
    }
    let html = '<table><tr><th>Session</th><th>Exchanges</th><th>Last Active</th><th style="width:80px"></th></tr>';
    for (const key of keys) {
      const s = d[key];
      html += '<tr><td><code>' + esc(key) + '</code></td>'
        + '<td>' + esc(s.exchanges || 0) + '</td>'
        + '<td>' + esc(timeAgo(s.timestamp)) + '</td>'
        + '<td><button class="btn-danger btn-sm" onclick="apiPost(\\'/api/sessions/' + encodeURIComponent(key) + '/clear\\')">Clear</button></td></tr>';
    }
    html += '</table>';
    document.getElementById('panel-sessions').innerHTML = html;
  } catch(e) { }
}

// ── Cron Jobs ─────────────────────────────
let cronJobsData = [];
async function refreshCron() {
  try {
    const r = await fetch('/api/cron');
    const d = await r.json();
    cronJobsData = d.jobs || [];
    document.getElementById('nav-cron-count').textContent = cronJobsData.length;
    const statEl = document.getElementById('stat-cron-count');
    if (statEl) statEl.textContent = cronJobsData.length;

    if (cronJobsData.length === 0) {
      document.getElementById('panel-cron').innerHTML = '<div class="empty-state" style="padding:40px">No scheduled tasks yet. Click "+ New Task" to create one.</div>';
      return;
    }
    let html = '<table><tr><th>Task</th><th>Schedule</th><th>Tier</th><th>Status</th><th>Last Run</th><th style="width:180px">Actions</th></tr>';
    for (const job of cronJobsData) {
      const enabled = job.enabled !== false;
      const statusBadge = enabled
        ? '<span class="badge badge-green"><span class="badge-dot"></span>Enabled</span>'
        : '<span class="badge badge-gray"><span class="badge-dot"></span>Disabled</span>';
      let lastRun = '<span style="color:var(--text-muted)">never</span>';
      if (job.recentRuns && job.recentRuns.length > 0) {
        const lr = job.recentRuns[0];
        const statusCls = lr.status === 'ok' ? 'badge-green' : 'badge-red';
        lastRun = esc(timeAgo(lr.finishedAt)) + ' <span class="badge ' + statusCls + '">' + esc(lr.status) + '</span>';
      }
      html += '<tr>'
        + '<td><strong>' + esc(job.name) + '</strong><br><span style="font-size:11px;color:var(--text-muted)">' + esc((job.prompt || '').slice(0, 60)) + (job.prompt && job.prompt.length > 60 ? '...' : '') + '</span></td>'
        + '<td><code style="color:var(--accent)">' + esc(job.schedule) + '</code></td>'
        + '<td>' + esc(job.tier || 1) + '</td>'
        + '<td>' + statusBadge + '</td>'
        + '<td>' + lastRun + '</td>'
        + '<td><div class="btn-group">'
        + '<button class="btn-sm btn-success" onclick="apiPost(\\'/api/cron/run/' + encodeURIComponent(job.name) + '\\')">Run</button>'
        + '<button class="btn-sm" onclick="openEditCronModal(\\'' + esc(job.name) + '\\')">Edit</button>'
        + '<button class="btn-sm" onclick="apiPost(\\'/api/cron/' + encodeURIComponent(job.name) + '/toggle\\')">' + (enabled ? 'Disable' : 'Enable') + '</button>'
        + '<button class="btn-sm btn-danger" onclick="confirmDeleteCron(\\'' + esc(job.name) + '\\')">Del</button>'
        + '</div></td></tr>';
    }
    html += '</table>';
    document.getElementById('panel-cron').innerHTML = html;
  } catch(e) { }
}

// ── Cron Modal ────────────────────────────
let editingCronJob = null;

function openCreateCronModal() {
  editingCronJob = null;
  document.getElementById('cron-modal-title').textContent = 'New Scheduled Task';
  document.getElementById('cron-modal-save').textContent = 'Create Task';
  document.getElementById('cron-name').value = '';
  document.getElementById('cron-name').disabled = false;
  document.getElementById('cron-schedule').value = '';
  document.getElementById('cron-tier').value = '1';
  document.getElementById('cron-prompt').value = '';
  document.getElementById('cron-modal').classList.add('show');
}

function openEditCronModal(jobName) {
  const job = cronJobsData.find(j => j.name === jobName);
  if (!job) return;
  editingCronJob = jobName;
  document.getElementById('cron-modal-title').textContent = 'Edit: ' + jobName;
  document.getElementById('cron-modal-save').textContent = 'Save Changes';
  document.getElementById('cron-name').value = job.name;
  document.getElementById('cron-name').disabled = true;
  document.getElementById('cron-schedule').value = job.schedule || '';
  document.getElementById('cron-tier').value = String(job.tier || 1);
  document.getElementById('cron-prompt').value = job.prompt || '';
  document.getElementById('cron-modal').classList.add('show');
}

function closeCronModal() {
  document.getElementById('cron-modal').classList.remove('show');
  editingCronJob = null;
}

async function saveCronJob() {
  const name = document.getElementById('cron-name').value.trim();
  const schedule = document.getElementById('cron-schedule').value.trim();
  const tier = parseInt(document.getElementById('cron-tier').value);
  const prompt = document.getElementById('cron-prompt').value.trim();

  if (!name || !schedule || !prompt) {
    toast('Please fill in all fields', 'error');
    return;
  }

  if (editingCronJob) {
    await apiJson('PUT', '/api/cron/' + encodeURIComponent(editingCronJob), { schedule, tier, prompt });
  } else {
    await apiJson('POST', '/api/cron', { name, schedule, tier, prompt, enabled: true });
  }
  closeCronModal();
  refreshCron();
}

// ── Delete Confirm ────────────────────────
function confirmDeleteCron(jobName) {
  document.getElementById('confirm-message').textContent = 'Delete scheduled task "' + jobName + '"? This cannot be undone.';
  const btn = document.getElementById('confirm-action');
  btn.onclick = async () => {
    await apiDelete('/api/cron/' + encodeURIComponent(jobName));
    closeConfirmModal();
    refreshCron();
  };
  document.getElementById('confirm-modal').classList.add('show');
}
function closeConfirmModal() {
  document.getElementById('confirm-modal').classList.remove('show');
}

// Close modals on overlay click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.classList.remove('show');
    }
  });
});

// Close modals on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.show').forEach(m => m.classList.remove('show'));
  }
});

// ── Schedule hint ─────────────────────────
const scheduleExamples = {
  '0 9 * * *': 'Every day at 9:00 AM',
  '0 9 * * 1-5': 'Weekdays at 9:00 AM',
  '0 8,12,18 * * *': 'Daily at 8 AM, 12 PM, 6 PM',
  '*/30 * * * *': 'Every 30 minutes',
  '0 18 * * 5': 'Every Friday at 6:00 PM',
  '0 22 * * *': 'Every day at 10:00 PM',
  '0 0 * * 0': 'Every Sunday at midnight',
  '0 */2 * * *': 'Every 2 hours',
};
document.getElementById('cron-schedule').addEventListener('input', (e) => {
  const v = e.target.value.trim();
  const hint = document.getElementById('cron-schedule-hint');
  if (scheduleExamples[v]) {
    hint.textContent = scheduleExamples[v];
    hint.style.color = 'var(--green)';
  } else {
    hint.textContent = 'minute hour day month weekday';
    hint.style.color = '';
  }
});

// ── Timers ────────────────────────────────
async function refreshTimers() {
  try {
    const r = await fetch('/api/timers');
    const d = await r.json();
    const count = Array.isArray(d) ? d.length : 0;
    document.getElementById('nav-timer-count').textContent = count;
    if (!Array.isArray(d) || d.length === 0) {
      document.getElementById('panel-timers').innerHTML = '<div class="empty-state">No pending timers</div>';
      return;
    }
    let html = '<table><tr><th>ID</th><th>Fires At</th><th>Message</th><th style="width:80px"></th></tr>';
    for (const t of d) {
      html += '<tr><td><code>' + esc(t.id || '?') + '</code></td>'
        + '<td>' + esc(t.fireAt || t.fire_at || t.time || '') + '</td>'
        + '<td>' + esc((t.message || t.prompt || '').slice(0, 100)) + '</td>'
        + '<td><button class="btn-danger btn-sm" onclick="apiPost(\\'/api/timers/' + encodeURIComponent(t.id) + '/cancel\\')">Cancel</button></td></tr>';
    }
    html += '</table>';
    document.getElementById('panel-timers').innerHTML = html;
  } catch(e) { }
}

// ── Heartbeat ─────────────────────────────
async function refreshHeartbeat() {
  try {
    const r = await fetch('/api/heartbeat');
    const d = await r.json();
    if (!d.timestamp) {
      document.getElementById('panel-heartbeat').innerHTML = '<div class="empty-state">No heartbeat data</div>';
      return;
    }
    let html = kv('Last Beat', timeAgo(d.timestamp));
    html += kv('Fingerprint', '<code>' + esc((d.fingerprint||'').slice(0,16)) + '</code>');
    if (d.details) {
      for (const [k,v] of Object.entries(d.details)) {
        html += kv(k, esc(v));
      }
    }
    document.getElementById('panel-heartbeat').innerHTML = html;
  } catch(e) { }
}

// ── Memory ────────────────────────────────
async function refreshMemory() {
  try {
    const r = await fetch('/api/memory');
    const d = await r.json();
    let statsHtml = '';
    if (d.dbStats && d.dbStats.chunks != null) {
      statsHtml = '<div class="stat-grid" style="margin-bottom:16px">'
        + '<div class="stat-tile"><div class="stat-value">' + esc(d.dbStats.chunks) + '</div><div class="stat-label">DB Chunks</div></div>'
        + '<div class="stat-tile"><div class="stat-value">' + esc(d.dbStats.files) + '</div><div class="stat-label">Indexed Files</div></div>'
        + '<div class="stat-tile"><div class="stat-value">' + esc(Math.round((d.dbStats.sizeBytes||0)/1024) + ' KB') + '</div><div class="stat-label">DB Size</div></div>'
        + '</div>';
    }
    document.getElementById('memory-stats').innerHTML = statsHtml;

    if (d.content) {
      document.getElementById('panel-memory').innerHTML = '<div class="memory-preview">' + esc(d.content) + '</div>';
    } else {
      document.getElementById('panel-memory').innerHTML = '<div class="empty-state">No MEMORY.md found</div>';
    }
  } catch(e) { }
}

// ── Logs ──────────────────────────────────
let fullLogContent = '';
async function refreshLogs() {
  try {
    const r = await fetch('/api/logs?lines=500');
    const d = await r.json();
    fullLogContent = d.content || '';
    applyLogFilter();
  } catch(e) { }
}
function applyLogFilter() {
  const filter = (document.getElementById('log-filter').value || '').toLowerCase();
  const el = document.getElementById('panel-logs');
  if (!fullLogContent) {
    el.innerHTML = '<div class="empty-state">No log file found</div>';
    return;
  }
  if (filter) {
    const lines = fullLogContent.split('\\n').filter(l => l.toLowerCase().includes(filter));
    el.textContent = lines.join('\\n') || '(no matching lines)';
  } else {
    el.textContent = fullLogContent;
  }
  if (document.getElementById('log-autoscroll').checked) {
    el.scrollTop = el.scrollHeight;
  }
}
document.getElementById('log-filter').addEventListener('input', applyLogFilter);

// ── Chat ──────────────────────────────────
let chatHistory = [];
async function sendChat() {
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';

  const container = document.getElementById('chat-messages');
  // Remove empty state
  const emptyState = container.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  // Add user bubble
  const userBubble = document.createElement('div');
  userBubble.className = 'chat-bubble user';
  userBubble.textContent = msg;
  const userMeta = document.createElement('div');
  userMeta.className = 'chat-meta';
  userMeta.textContent = new Date().toLocaleTimeString();
  userBubble.appendChild(userMeta);
  container.appendChild(userBubble);
  container.scrollTop = container.scrollHeight;

  // Show typing indicator
  const typing = document.createElement('div');
  typing.className = 'chat-typing';
  typing.innerHTML = '<span></span><span></span><span></span>';
  container.appendChild(typing);
  container.scrollTop = container.scrollHeight;

  // Disable input while processing
  const sendBtn = document.getElementById('chat-send-btn');
  input.disabled = true;
  sendBtn.disabled = true;
  sendBtn.textContent = 'Thinking...';

  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg }),
    });
    const d = await r.json();

    typing.remove();

    const asstBubble = document.createElement('div');
    asstBubble.className = 'chat-bubble assistant';
    asstBubble.textContent = d.response || d.error || 'No response';
    const asstMeta = document.createElement('div');
    asstMeta.className = 'chat-meta';
    asstMeta.textContent = new Date().toLocaleTimeString();
    asstBubble.appendChild(asstMeta);
    container.appendChild(asstBubble);
  } catch(e) {
    typing.remove();
    const errBubble = document.createElement('div');
    errBubble.className = 'chat-bubble assistant';
    errBubble.style.borderLeft = '3px solid var(--red)';
    errBubble.textContent = 'Error: ' + String(e);
    container.appendChild(errBubble);
  }

  input.disabled = false;
  sendBtn.disabled = false;
  sendBtn.textContent = 'Send';
  input.focus();
  container.scrollTop = container.scrollHeight;
}

// ── Memory Search ─────────────────────────
async function runMemorySearch() {
  const input = document.getElementById('memory-search-input');
  const q = input.value.trim();
  if (!q) return;

  const container = document.getElementById('memory-search-results');
  container.innerHTML = '<div class="empty-state">Searching...</div>';

  try {
    const r = await fetch('/api/memory/search?q=' + encodeURIComponent(q));
    const d = await r.json();

    if (!d.results || d.results.length === 0) {
      container.innerHTML = '<div class="empty-state">No results found for "' + esc(q) + '"</div>';
      return;
    }

    let html = '<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">' + d.results.length + ' result(s)</div>';
    for (const r of d.results) {
      const score = Math.abs(r.score || 0).toFixed(2);
      html += '<div class="search-result">'
        + '<div class="search-result-header">'
        + '<span class="search-result-file">' + esc(r.source_file) + '</span>'
        + '<span class="search-result-score">score: ' + score + '</span>'
        + '</div>'
        + '<div class="search-result-section">' + esc(r.section || '') + ' &middot; ' + esc(r.chunk_type || '') + '</div>'
        + '<div class="search-result-content">' + esc((r.content || '').slice(0, 500)) + '</div>'
        + '</div>';
    }
    container.innerHTML = html;
  } catch(e) {
    container.innerHTML = '<div class="empty-state" style="color:var(--red)">Search error: ' + esc(String(e)) + '</div>';
  }
}

// ── Metrics ───────────────────────────────
async function refreshMetrics() {
  try {
    const r = await fetch('/api/metrics');
    const d = await r.json();
    const container = document.getElementById('metrics-content');

    let html = '';

    // Time saved hero
    const hours = d.timeSaved?.estimatedHours || 0;
    const mins = d.timeSaved?.estimatedMinutes || 0;
    const display = hours >= 1 ? hours + 'h' : mins + 'm';
    html += '<div class="metric-hero">'
      + '<div class="metric-hero-value">' + esc(display) + '</div>'
      + '<div class="metric-hero-label">Estimated Time Saved</div>'
      + '<div class="metric-hero-sub">'
      + esc((d.timeSaved?.breakdown?.cronMinutes || 0)) + ' min from automated tasks &middot; '
      + esc((d.timeSaved?.breakdown?.chatMinutes || 0)) + ' min from chat interactions'
      + '</div></div>';

    // Stat grid
    html += '<div class="stat-grid">';
    html += statTile(d.cron?.totalRuns || 0, 'Total Task Runs');
    html += statTile(d.cron?.successRate + '%', 'Success Rate');
    html += statTile(d.cron?.runsToday || 0, 'Runs Today');
    html += statTile(d.cron?.runsThisWeek || 0, 'Runs This Week');
    html += statTile(d.sessions?.totalExchanges || 0, 'Chat Exchanges');
    html += statTile(d.sessions?.activeSessions || 0, 'Active Sessions');
    html += '</div>';

    // Success rate bar
    const rate = d.cron?.successRate || 0;
    const barColor = rate >= 90 ? 'var(--green)' : rate >= 70 ? 'var(--yellow)' : 'var(--red)';
    html += '<div class="card"><div class="card-header">Task Reliability</div><div class="card-body">'
      + '<div class="kv-row"><span class="kv-key">Success Rate</span><span class="kv-val">' + rate + '%</span></div>'
      + '<div class="metric-bar-track"><div class="metric-bar-fill" style="width:' + rate + '%;background:' + barColor + '"></div></div>'
      + '<div class="kv-row"><span class="kv-key">Successful</span><span class="kv-val">' + (d.cron?.successRuns || 0) + '</span></div>'
      + '<div class="kv-row"><span class="kv-key">Errors</span><span class="kv-val" style="color:var(--red)">' + (d.cron?.errorRuns || 0) + '</span></div>'
      + '<div class="kv-row"><span class="kv-key">Avg Duration</span><span class="kv-val">' + formatMs(d.cron?.avgDurationMs || 0) + '</span></div>'
      + '</div></div>';

    // Per-job breakdown
    if (d.cron?.jobStats && d.cron.jobStats.length > 0) {
      html += '<div class="card"><div class="card-header">Task Breakdown</div><div class="card-body" style="padding:0">'
        + '<table><tr><th>Task</th><th>Runs</th><th>Success</th><th>Avg Duration</th><th>Last Run</th></tr>';
      for (const j of d.cron.jobStats) {
        const jobRate = j.runs > 0 ? Math.round((j.successes / j.runs) * 100) : 0;
        html += '<tr><td><strong>' + esc(j.name) + '</strong></td>'
          + '<td>' + j.runs + '</td>'
          + '<td><span class="badge ' + (jobRate >= 90 ? 'badge-green' : jobRate >= 70 ? 'badge-yellow' : 'badge-red') + '">' + jobRate + '%</span></td>'
          + '<td>' + formatMs(j.avgDurationMs) + '</td>'
          + '<td>' + (j.lastRun ? timeAgo(j.lastRun) : 'never') + '</td></tr>';
      }
      html += '</table></div></div>';
    }

    container.innerHTML = html;
  } catch(e) {
    document.getElementById('metrics-content').innerHTML = '<div class="empty-state">Error loading metrics</div>';
  }
}

function statTile(value, label) {
  return '<div class="stat-tile"><div class="stat-value">' + esc(value) + '</div><div class="stat-label">' + esc(label) + '</div></div>';
}

function formatMs(ms) {
  if (!ms || ms === 0) return '--';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  return (ms / 60000).toFixed(1) + 'm';
}

// ── Refresh orchestrator ──────────────────
function refreshAll() {
  refreshStatus();
  refreshSessions();
  refreshCron();
  refreshTimers();
  refreshHeartbeat();
  if (currentPage === 'memory') refreshMemory();
  if (currentPage === 'logs') refreshLogs();
  if (currentPage === 'metrics') refreshMetrics();
  document.getElementById('last-update').textContent = new Date().toLocaleTimeString();
}

refreshAll();
setInterval(refreshAll, 5000);
</script>
</body>
</html>`;
}
