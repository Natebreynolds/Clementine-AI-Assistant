/**
 * Clementine Command Center — Local web dashboard.
 *
 * Serves an inline HTML SPA with JSON API from Express on localhost.
 * Zero extra deps — uses express, gray-matter, better-sqlite3 (all already installed).
 */

import express from 'express';
import { randomBytes } from 'node:crypto';
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
import { TunnelManager } from './tunnel.js';
import type { RemoteAccessConfig } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_DIR = process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine');
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const DIST_ENTRY = path.join(PACKAGE_ROOT, 'dist', 'cli', 'index.js');
const ENV_PATH = path.join(BASE_DIR, '.env');
const VAULT_DIR = path.join(BASE_DIR, 'vault');
const CRON_FILE = path.join(VAULT_DIR, '00-System', 'CRON.md');
const MEMORY_DB_PATH = path.join(VAULT_DIR, '.memory.db');
const PROJECTS_META_FILE = path.join(BASE_DIR, 'projects.json');

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

async function searchMemory(query: string, limit = 20): Promise<{ results: Array<Record<string, unknown>>; error?: string; dbExists: boolean }> {
  if (!existsSync(MEMORY_DB_PATH)) {
    return { results: [], dbExists: false, error: `Memory DB not found at ${MEMORY_DB_PATH}` };
  }
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(MEMORY_DB_PATH, { readonly: true });
  try {
    const words = query.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) { db.close(); return { results: [], dbExists: true }; }
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
    return { results: rows, dbExists: true };
  } catch (err) {
    return { results: [], dbExists: true, error: String(err) };
  } finally {
    db.close();
  }
}

// ── Remote access config ────────────────────────────────────────────

const REMOTE_CONFIG_PATH = path.join(BASE_DIR, 'remote-access.json');

function generateAccessToken(): string {
  const raw = randomBytes(12).toString('base64url').slice(0, 12);
  return `clem_${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

function loadRemoteConfig(): RemoteAccessConfig {
  try {
    if (existsSync(REMOTE_CONFIG_PATH)) {
      return JSON.parse(readFileSync(REMOTE_CONFIG_PATH, 'utf-8'));
    }
  } catch { /* ignore */ }
  return { enabled: false, authToken: '', autoPost: true };
}

function saveRemoteConfig(config: RemoteAccessConfig): void {
  writeFileSync(REMOTE_CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/** Send tunnel URL to Discord via REST API (lightweight, no client library needed). */
async function notifyTunnelUrl(url: string): Promise<void> {
  const envPath = path.join(BASE_DIR, '.env');
  if (!existsSync(envPath)) return;
  const envContent = readFileSync(envPath, 'utf-8');

  const tokenMatch = envContent.match(/^DISCORD_TOKEN=(.+)$/m);
  const channelMatch = envContent.match(/^DISCORD_WATCHED_CHANNELS=(.+)$/m);
  if (!tokenMatch || !channelMatch) return;

  let token = tokenMatch[1].trim();
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    token = token.slice(1, -1);
  }
  const channelId = channelMatch[1].split(',')[0].trim();
  if (!token || !channelId) return;

  try {
    await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: `**Remote Dashboard Online**\n\nAccess your dashboard from anywhere:\n${url}\n\nLog in with your access token from \`Settings > Remote Access\`.`,
      }),
    });
  } catch { /* best-effort notification */ }
}

// ── Project scanning (mirrors workspace_list from MCP server) ────────

function cronFieldMatch(field: string, value: number): boolean {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    return !isNaN(step) && step > 0 && value % step === 0;
  }
  for (const part of field.split(',')) {
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      if (!isNaN(a) && !isNaN(b) && value >= a && value <= b) return true;
    } else {
      if (parseInt(part, 10) === value) return true;
    }
  }
  return false;
}

const PROJECT_MARKERS = [
  '.git', 'package.json', 'pyproject.toml', 'Cargo.toml',
  'go.mod', 'Makefile', 'CMakeLists.txt', 'build.gradle',
  'pom.xml', 'Gemfile', 'mix.exs', '.claude/CLAUDE.md',
];

const WORKSPACE_CANDIDATES = [
  'Desktop', 'Documents', 'Developer', 'Projects', 'projects',
  'repos', 'Repos', 'src', 'code', 'Code', 'work', 'Work',
  'dev', 'Dev', 'github', 'GitHub', 'gitlab', 'GitLab',
];

interface ProjectInfo {
  name: string;
  path: string;
  type: string;
  description: string;
  hasClaude: boolean;
  scripts: string[];
  hasMcp: boolean;
  mcpServers: string[];
}

function detectProjectType(entries: string[]): string {
  if (entries.includes('package.json')) return 'node';
  if (entries.includes('pyproject.toml') || entries.includes('setup.py')) return 'python';
  if (entries.includes('Cargo.toml')) return 'rust';
  if (entries.includes('go.mod')) return 'go';
  if (entries.includes('build.gradle') || entries.includes('pom.xml')) return 'java';
  if (entries.includes('Gemfile')) return 'ruby';
  if (entries.includes('mix.exs')) return 'elixir';
  if (entries.includes('CMakeLists.txt')) return 'c/c++';
  if (entries.includes('Makefile')) return 'make';
  return 'unknown';
}

function getProjectDescription(dirPath: string, entries: string[]): string {
  if (entries.includes('package.json')) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dirPath, 'package.json'), 'utf-8'));
      if (pkg.description) return pkg.description;
    } catch { /* ignore */ }
  }
  if (entries.includes('pyproject.toml')) {
    try {
      const toml = readFileSync(path.join(dirPath, 'pyproject.toml'), 'utf-8');
      const match = toml.match(/description\s*=\s*"([^"]+)"/);
      if (match) return match[1];
    } catch { /* ignore */ }
  }
  return '';
}

function getProjectScripts(dirPath: string, entries: string[]): string[] {
  if (entries.includes('package.json')) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dirPath, 'package.json'), 'utf-8'));
      return Object.keys(pkg.scripts || {}).slice(0, 15);
    } catch { /* ignore */ }
  }
  if (entries.includes('Makefile')) {
    try {
      const mk = readFileSync(path.join(dirPath, 'Makefile'), 'utf-8');
      const targets = [...mk.matchAll(/^([a-zA-Z_][a-zA-Z0-9_-]*):/gm)].map(m => m[1]);
      return targets.slice(0, 15);
    } catch { /* ignore */ }
  }
  return [];
}

function getMcpServers(dirPath: string): string[] {
  const servers: string[] = [];
  // Check .mcp.json (project-level Claude Code MCP config)
  for (const mcpPath of [
    path.join(dirPath, '.mcp.json'),
    path.join(dirPath, '.claude', 'mcp.json'),
  ]) {
    if (!existsSync(mcpPath)) continue;
    try {
      const data = JSON.parse(readFileSync(mcpPath, 'utf-8'));
      const mcpServers = data.mcpServers || data.servers || {};
      for (const name of Object.keys(mcpServers)) {
        if (!servers.includes(name)) servers.push(name);
      }
    } catch { /* ignore */ }
  }
  return servers;
}

interface ProjectMetaEntry {
  path: string;
  description?: string;
  keywords?: string[];
}

function loadProjectsMeta(): ProjectMetaEntry[] {
  try {
    if (!existsSync(PROJECTS_META_FILE)) return [];
    return JSON.parse(readFileSync(PROJECTS_META_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function getWorkspaceDirs(): string[] {
  if (!existsSync(ENV_PATH)) return [];
  const content = readFileSync(ENV_PATH, 'utf-8');
  const match = content.match(/^WORKSPACE_DIRS=(.+)$/m);
  if (!match) return [];
  return match[1].split(',').map(s => s.trim()).filter(Boolean);
}

function setWorkspaceDirs(dirs: string[]): void {
  let lines: string[] = [];
  if (existsSync(ENV_PATH)) {
    lines = readFileSync(ENV_PATH, 'utf-8').split('\n');
  }

  const value = dirs.join(',');
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('WORKSPACE_DIRS=')) {
      lines[i] = `WORKSPACE_DIRS=${value}`;
      found = true;
      break;
    }
  }

  if (!found) {
    // Find or create Workspace section
    let insertIdx = lines.length;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === '# Workspace') {
        insertIdx = i + 1;
        break;
      }
    }
    if (insertIdx === lines.length) {
      lines.push('', '# Workspace');
      insertIdx = lines.length;
    }
    lines.splice(insertIdx, 0, `WORKSPACE_DIRS=${value}`);
  }

  writeFileSync(ENV_PATH, lines.join('\n'));
}

function scanProjects(): ProjectInfo[] {
  const home = os.homedir();
  const seen = new Set<string>();
  const dirs: string[] = [];

  const addDir = (d: string) => {
    const resolved = path.resolve(d);
    if (!seen.has(resolved) && existsSync(resolved)) {
      try { if (statSync(resolved).isDirectory()) { seen.add(resolved); dirs.push(resolved); } } catch { /* ignore */ }
    }
  };

  for (const candidate of WORKSPACE_CANDIDATES) {
    addDir(path.join(home, candidate));
  }

  // Merge explicit WORKSPACE_DIRS from .env
  if (existsSync(ENV_PATH)) {
    const envContent = readFileSync(ENV_PATH, 'utf-8');
    const match = envContent.match(/^WORKSPACE_DIRS=(.+)$/m);
    if (match) {
      for (const d of match[1].split(',').map(s => s.trim()).filter(Boolean)) {
        addDir(d.startsWith('~') ? d.replace('~', home) : d);
      }
    }
  }

  const projects: ProjectInfo[] = [];

  const addProject = (fullPath: string, name: string) => {
    const resolvedProject = path.resolve(fullPath);
    if (seen.has('proj:' + resolvedProject)) return;
    seen.add('proj:' + resolvedProject);

    let subEntries: string[];
    try { subEntries = readdirSync(fullPath); } catch { return; }

    const mcpServers = getMcpServers(fullPath);
    projects.push({
      name,
      path: fullPath,
      type: detectProjectType(subEntries),
      description: getProjectDescription(fullPath, subEntries),
      hasClaude: existsSync(path.join(fullPath, '.claude', 'CLAUDE.md')),
      scripts: getProjectScripts(fullPath, subEntries),
      hasMcp: mcpServers.length > 0,
      mcpServers,
    });
  };

  for (const wsDir of dirs) {
    let entries: string[];
    try { entries = readdirSync(wsDir); } catch { continue; }

    // Check if the workspace dir itself is a project
    const wsDirIsProject = PROJECT_MARKERS.some(marker => {
      if (marker.includes('/')) return existsSync(path.join(wsDir, marker));
      return entries.includes(marker);
    });
    if (wsDirIsProject) {
      addProject(wsDir, path.basename(wsDir));
    }

    // Scan subdirectories for projects
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const fullPath = path.join(wsDir, entry);
      try { if (!statSync(fullPath).isDirectory()) continue; } catch { continue; }

      let subEntries: string[];
      try { subEntries = readdirSync(fullPath); } catch { continue; }

      const isProject = PROJECT_MARKERS.some(marker => {
        if (marker.includes('/')) return existsSync(path.join(fullPath, marker));
        return subEntries.includes(marker);
      });
      if (!isProject) continue;

      addProject(fullPath, entry);
    }
  }

  return projects.sort((a, b) => a.name.localeCompare(b.name));
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
  // Use local midnight boundaries so runs at e.g. 9 PM PDT (next day in UTC) still count as "today"
  const now = new Date();
  const localMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayStartIso = localMidnight.toISOString();
  const weekAgo = new Date(localMidnight.getTime() - 7 * 86400000).toISOString();
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
            if (entry.startedAt && entry.startedAt >= todayStartIso) runsToday++;
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

  // Current activity detection
  let currentActivity = 'Idle';
  let runsToday = 0;
  let nextTaskName = '';

  // Scan cron runs for in-progress jobs + today's count
  const runsDir = path.join(BASE_DIR, 'cron', 'runs');
  const statusNow = new Date();
  const localMidnightStatus = new Date(statusNow.getFullYear(), statusNow.getMonth(), statusNow.getDate());
  const todayStartIsoStatus = localMidnightStatus.toISOString();
  if (existsSync(runsDir)) {
    try {
      const runFiles = readdirSync(runsDir).filter(f => f.endsWith('.jsonl'));
      for (const file of runFiles) {
        const filePath = path.join(runsDir, file);
        const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.startedAt && entry.startedAt >= todayStartIsoStatus) runsToday++;
          } catch { /* skip */ }
        }
        // Check last line for running job
        if (lines.length > 0) {
          try {
            const last = JSON.parse(lines[lines.length - 1]);
            if (last.startedAt && !last.finishedAt) {
              currentActivity = 'Running: ' + (last.jobName || file.replace('.jsonl', ''));
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* ignore */ }
  }

  // Check sessions for recent chat activity
  if (currentActivity === 'Idle') {
    const sessionsFile = path.join(BASE_DIR, '.sessions.json');
    if (existsSync(sessionsFile)) {
      try {
        const sessions = JSON.parse(readFileSync(sessionsFile, 'utf-8'));
        for (const [key, val] of Object.entries(sessions)) {
          const s = val as Record<string, unknown>;
          if (s.timestamp && (Date.now() - new Date(String(s.timestamp)).getTime()) < 60000) {
            const channel = key.split(':')[0];
            currentActivity = 'Chatting on ' + channel.charAt(0).toUpperCase() + channel.slice(1);
            break;
          }
        }
      } catch { /* ignore */ }
    }
  }

  // Check unleashed tasks
  if (currentActivity === 'Idle') {
    const unleashedDir = path.join(BASE_DIR, 'unleashed');
    if (existsSync(unleashedDir)) {
      try {
        for (const dir of readdirSync(unleashedDir)) {
          const statusFile = path.join(unleashedDir, dir, 'status.json');
          if (existsSync(statusFile)) {
            try {
              const st = JSON.parse(readFileSync(statusFile, 'utf-8'));
              if (st.status === 'running') {
                currentActivity = 'Deep work: ' + (st.jobName || dir);
                break;
              }
            } catch { /* skip */ }
          }
        }
      } catch { /* ignore */ }
    }
  }

  // Next task: find the chronologically next enabled cron job
  let nextTaskTime = '';
  if (existsSync(CRON_FILE)) {
    try {
      const raw = readFileSync(CRON_FILE, 'utf-8');
      const parsed = matter(raw);
      const jobs = (parsed.data.jobs ?? []) as Array<Record<string, unknown>>;
      const now = new Date();
      let soonestOffset = Infinity;

      for (const job of jobs) {
        if (job.enabled === false) continue;
        const schedule = String(job.schedule ?? '');
        const parts = schedule.trim().split(/\s+/);
        if (parts.length < 5) continue;
        const [minF, hourF, domF, monF, dowF] = parts;

        // Find next match in the next 48h
        for (let offset = 1; offset <= 2880; offset++) {
          const t = new Date(now.getTime() + offset * 60_000);
          const matches =
            cronFieldMatch(minF, t.getMinutes()) &&
            cronFieldMatch(hourF, t.getHours()) &&
            cronFieldMatch(domF, t.getDate()) &&
            cronFieldMatch(monF, t.getMonth() + 1) &&
            cronFieldMatch(dowF, t.getDay());
          if (matches) {
            if (offset < soonestOffset) {
              soonestOffset = offset;
              nextTaskName = String(job.name || '');
              const h = t.getHours();
              const m = t.getMinutes();
              const ampm = h >= 12 ? 'PM' : 'AM';
              const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
              const today = t.toDateString() === now.toDateString();
              nextTaskTime = (today ? '' : 'tmrw ') + `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
            }
            break;
          }
        }
      }
    } catch { /* ignore */ }
  }

  return { name, pid, alive, uptime, channels, launchAgent, currentActivity, runsToday, nextTaskName, nextTaskTime };
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
      // Consolidation stats (column may not exist on older DBs)
      try {
        const consolidated = (db.prepare('SELECT COUNT(*) as count FROM chunks WHERE consolidated = 1').get() as { count: number }).count;
        (dbStats as Record<string, unknown>).consolidated = consolidated;
        (dbStats as Record<string, unknown>).unconsolidated = chunkCount - consolidated;
      } catch { /* consolidated column doesn't exist yet */ }
      db.close();
    } catch { /* ignore */ }
  }

  // Graph stats
  let graphStats: Record<string, unknown> = { available: false };
  try {
    const { getSharedGraphStore } = await import('../memory/graph-store.js');
    const graphDbDir = path.join(BASE_DIR, '.graph.db');
    const gs = await getSharedGraphStore(graphDbDir);
    if (gs) {
      const nodeCount = await gs.query('MATCH (n) RETURN count(n) AS c');
      const edgeCount = await gs.query('MATCH ()-[r]->() RETURN count(r) AS c');
      const labelCounts = await gs.query('MATCH (n) RETURN labels(n)[0] AS label, count(n) AS c ORDER BY c DESC');
      graphStats = {
        available: true,
        nodes: nodeCount[0]?.c ?? 0,
        edges: edgeCount[0]?.c ?? 0,
        labels: (labelCounts ?? []).map((r: any) => ({ label: r.label, count: r.c })),
      };
    }
  } catch { /* graph unavailable */ }

  return { content: content.slice(0, 5000), dbStats, graphStats };
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
  // Validate before writing to prevent daemon crash from malformed YAML
  try {
    matter(output);
  } catch (err) {
    throw new Error(`Generated CRON.md has invalid YAML: ${err instanceof Error ? err.message : err}`);
  }
  writeFileSync(CRON_FILE, output);
}

// ── Express app ──────────────────────────────────────────────────────

export async function cmdDashboard(opts: { port?: string }): Promise<void> {
  const port = parseInt(opts.port ?? '3030', 10);
  const app = express();
  app.use(express.json());

  // ── Dashboard authentication ────────────────────────────────────────
  const dashboardToken = randomBytes(24).toString('hex');
  const tokenPath = path.join(BASE_DIR, '.dashboard-token');
  writeFileSync(tokenPath, dashboardToken, { mode: 0o600 });

  // ── Remote access + session management ─────────────────────────────
  const remoteConfig = loadRemoteConfig();
  const sessions = new Map<string, number>(); // sessionId → expiresAt
  let tunnelManager: TunnelManager | null = null;
  const SESSION_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
  const loginRateLimit = { count: 0, resetAt: Date.now() + 15 * 60 * 1000 };

  function isRemoteRequest(req: express.Request): boolean {
    // cloudflared sets CF-Connecting-IP for tunneled traffic
    return Boolean(req.headers['cf-connecting-ip']);
  }

  function hasValidSession(req: express.Request): boolean {
    const cookie = req.headers.cookie ?? '';
    const match = cookie.match(/__clem_session=([a-f0-9]+)/);
    if (!match) return false;
    const sessionId = match[1];
    const expiresAt = sessions.get(sessionId);
    if (!expiresAt || Date.now() > expiresAt) {
      sessions.delete(sessionId);
      return false;
    }
    return true;
  }

  function createSession(res: express.Response): void {
    const sessionId = randomBytes(32).toString('hex');
    sessions.set(sessionId, Date.now() + SESSION_MAX_AGE);
    res.cookie('__clem_session', sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SESSION_MAX_AGE,
      path: '/',
    });
  }

  // Clean expired sessions every 10 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [id, exp] of sessions) {
      if (now > exp) sessions.delete(id);
    }
  }, 10 * 60 * 1000);

  // Protect /api routes with bearer token (GET / serves the SPA with token injected)
  app.use('/api', (req, res, next) => {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${dashboardToken}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  });

  // Compute build version hash at startup for cache busting / auto-reload
  // Use dist file mtime so updates are detected even without git
  const distDashboard = path.join(PACKAGE_ROOT, 'dist', 'cli', 'dashboard.js');
  let buildHash = String(Date.now());
  try {
    const distMtime = statSync(distDashboard).mtimeMs;
    buildHash = String(Math.floor(distMtime));
  } catch { /* fallback to timestamp */ }
  try {
    const gitHash = execSync('git rev-parse --short HEAD', { cwd: PACKAGE_ROOT, encoding: 'utf-8' }).trim();
    buildHash = gitHash + '-' + buildHash;
  } catch { /* git not available */ }

  // ── Auth routes (no bearer token required) ─────────────────────────

  app.post('/auth/login', (req, res) => {
    // Rate limit: max 10 attempts per 15 minutes
    const now = Date.now();
    if (now > loginRateLimit.resetAt) {
      loginRateLimit.count = 0;
      loginRateLimit.resetAt = now + 15 * 60 * 1000;
    }
    loginRateLimit.count++;
    if (loginRateLimit.count > 10) {
      res.status(429).json({ error: 'Too many login attempts. Try again later.' });
      return;
    }

    const { token } = req.body ?? {};
    if (!token || typeof token !== 'string') {
      res.status(400).json({ error: 'Token is required' });
      return;
    }

    const config = loadRemoteConfig();
    if (!config.enabled || !config.authToken) {
      res.status(403).json({ error: 'Remote access is not enabled' });
      return;
    }

    if (token !== config.authToken) {
      res.status(401).json({ error: 'Invalid access token' });
      return;
    }

    createSession(res);
    res.json({ ok: true });
  });

  app.get('/auth/logout', (_req, res) => {
    res.clearCookie('__clem_session', { path: '/' });
    res.redirect('/');
  });

  // ── GET routes ───────────────────────────────────────────────────

  app.get('/', (req, res) => {
    // If remote access enabled and request comes through tunnel, enforce session auth
    const config = loadRemoteConfig();
    if (config.enabled && isRemoteRequest(req) && !hasValidSession(req)) {
      res.type('html').send(getLoginPageHTML());
      return;
    }
    res.type('html').send(getDashboardHTML(dashboardToken));
  });

  app.get('/api/version', (_req, res) => {
    // Re-check dist mtime to detect rebuilds while dashboard is running
    let currentHash = buildHash;
    try {
      const currentMtime = String(Math.floor(statSync(distDashboard).mtimeMs));
      const gitHash = execSync('git rev-parse --short HEAD', { cwd: PACKAGE_ROOT, encoding: 'utf-8' }).trim();
      currentHash = gitHash + '-' + currentMtime;
    } catch {
      try {
        currentHash = String(Math.floor(statSync(distDashboard).mtimeMs));
      } catch { /* use cached */ }
    }
    const needsRestart = currentHash !== buildHash;
    res.json({ hash: currentHash, started: buildHash, needsRestart });
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

  app.get('/api/activity', (_req, res) => {
    const activities: Array<{ type: string; message: string; time: string; status?: string }> = [];

    // Scan cron runs for recent activity
    const runsDir = path.join(BASE_DIR, 'cron', 'runs');
    if (existsSync(runsDir)) {
      try {
        const files = readdirSync(runsDir).filter(f => f.endsWith('.jsonl'));
        for (const file of files) {
          const filePath = path.join(runsDir, file);
          const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
          const recent = lines.slice(-5);
          for (const line of recent) {
            try {
              const entry = JSON.parse(line);
              activities.push({
                type: 'cron',
                message: (entry.jobName || file.replace('.jsonl', '')) + (entry.status === 'ok' ? ' completed' : ' failed'),
                time: entry.finishedAt || entry.startedAt || '',
                status: entry.status,
              });
            } catch { /* skip bad lines */ }
          }
        }
      } catch { /* ignore */ }
    }

    // Scan recent log lines for chat messages and heartbeat events
    const logFile = path.join(BASE_DIR, 'logs', 'clementine.log');
    if (existsSync(logFile)) {
      try {
        const content = readFileSync(logFile, 'utf-8');
        const logLines = content.split('\n').filter(Boolean).slice(-200);
        for (const line of logLines) {
          try {
            const entry = JSON.parse(line);
            const msg = entry.msg || '';
            const logTime = typeof entry.time === 'number' ? new Date(entry.time).toISOString() : String(entry.time || '');
            if (msg.includes('chat') || msg.includes('message') || msg.includes('gateway')) {
              activities.push({
                type: 'chat',
                message: msg,
                time: logTime,
                status: 'ok',
              });
            } else if (msg.includes('heartbeat') || msg.includes('cron')) {
              activities.push({
                type: 'system',
                message: msg,
                time: logTime,
                status: 'ok',
              });
            }
          } catch { /* skip non-JSON lines */ }
        }
      } catch { /* ignore */ }
    }

    // Sort newest-first, limit to 15
    activities.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
    res.json({ activities: activities.slice(0, 15) });
  });

  // ── POST routes (actions) ──────────────────────────────────────

  app.post('/api/cron/run/:job', (req, res) => {
    const jobName = req.params.job;
    try {
      const child = spawn('node', [DIST_ENTRY, 'cron', 'run', jobName], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: BASE_DIR,
        env: { ...process.env, CLEMENTINE_HOME: BASE_DIR },
      });

      // Capture stderr for error reporting
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString().slice(0, 500);
      });

      child.on('error', (err) => {
        console.error(`[cron-run] Failed to start '${jobName}': ${err}`);
      });

      child.on('exit', (code) => {
        if (code && code !== 0) {
          console.error(`[cron-run] '${jobName}' exited with code ${code}: ${stderr.slice(0, 200)}`);
        }
      });

      child.unref();
      res.json({ ok: true, message: `Triggered cron job: ${jobName}` });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Cron trace viewer ──────────────────────────────────────────

  app.get('/api/cron/traces/:job', (req, res) => {
    try {
      const jobName = req.params.job;
      const safeName = jobName.replace(/[^a-zA-Z0-9_-]/g, '_');
      const traceDir = path.join(BASE_DIR, 'cron', 'traces');
      if (!existsSync(traceDir)) {
        res.json({ traces: [] });
        return;
      }
      const files = readdirSync(traceDir)
        .filter(f => f.startsWith(safeName + '_') && f.endsWith('.json'))
        .sort()
        .reverse()
        .slice(0, 10); // Last 10 traces

      const traces = files.map(f => {
        try {
          const data = JSON.parse(readFileSync(path.join(traceDir, f), 'utf-8'));
          return {
            file: f,
            jobName: data.jobName,
            startedAt: data.startedAt,
            steps: (data.trace || []).length,
            trace: data.trace || [],
          };
        } catch {
          return null;
        }
      }).filter(Boolean);

      res.json({ traces });
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

  // ── Available Tools ──────────────────────────────────────────

  app.get('/api/available-tools', (_req, res) => {
    try {
      const categories: Record<string, string[]> = {
        'Core': ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
        'Web': ['WebSearch', 'WebFetch'],
        'Memory': ['memory_read', 'memory_write', 'memory_search', 'memory_recall',
                    'memory_connections', 'memory_timeline', 'memory_report', 'memory_correct',
                    'memory_consolidate'],
        'Notes & Tasks': ['note_create', 'note_take', 'daily_note', 'task_list', 'task_add', 'task_update'],
        'Communication': ['outlook_inbox', 'outlook_search', 'outlook_calendar', 'outlook_draft',
                          'outlook_send', 'outlook_read_email', 'discord_channel_send'],
        'Research': ['rss_fetch', 'github_prs', 'browser_screenshot', 'analyze_image', 'transcript_search'],
        'Team': ['team_list', 'team_message'],
        'System': ['workspace_config', 'workspace_list', 'workspace_info',
                   'self_restart', 'vault_stats', 'set_timer', 'feedback_log', 'feedback_report'],
      };

      // Discover MCP servers from linked projects
      const projects = scanProjects();
      for (const p of projects) {
        if (p.mcpServers.length) {
          for (const server of p.mcpServers) {
            if (!categories[server]) categories[server] = [];
            categories[server].push(`mcp__${server} (all tools)`);
          }
        }
      }

      res.json({ categories });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── CRON CRUD routes ──────────────────────────────────────────

  app.get('/api/projects', (_req, res) => {
    try {
      const projects = scanProjects();
      // Merge user-defined metadata from projects.json
      const meta = loadProjectsMeta();
      const merged = projects.map(p => {
        const m = meta.find(pm => pm.path === p.path);
        return {
          ...p,
          userDescription: m?.description ?? '',
          keywords: m?.keywords ?? [],
          linked: !!m,
        };
      });
      res.json({ projects: merged });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/projects/link', (req, res) => {
    try {
      const { path: projPath, description, keywords } = req.body;
      if (!projPath) {
        res.status(400).json({ error: 'path is required' });
        return;
      }
      const meta = loadProjectsMeta();
      const existing = meta.findIndex(m => m.path === projPath);
      const entry = { path: projPath, description: description ?? '', keywords: keywords ?? [] };
      if (existing >= 0) {
        meta[existing] = entry;
      } else {
        meta.push(entry);
      }
      writeFileSync(PROJECTS_META_FILE, JSON.stringify(meta, null, 2));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/projects/unlink', (req, res) => {
    try {
      const { path: projPath } = req.body;
      if (!projPath) {
        res.status(400).json({ error: 'path is required' });
        return;
      }
      const meta = loadProjectsMeta().filter(m => m.path !== projPath);
      writeFileSync(PROJECTS_META_FILE, JSON.stringify(meta, null, 2));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Workspace Dirs routes ───────────────────────────────────────

  app.get('/api/workspace-dirs', (_req, res) => {
    try {
      res.json({ dirs: getWorkspaceDirs() });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/workspace-dirs', (req, res) => {
    try {
      const { dir } = req.body;
      if (!dir || typeof dir !== 'string') {
        res.status(400).json({ error: 'dir is required' });
        return;
      }
      const resolved = dir.startsWith('~') ? dir.replace('~', os.homedir()) : path.resolve(dir);
      if (!existsSync(resolved)) {
        res.status(400).json({ error: `Directory not found: ${resolved}` });
        return;
      }
      const current = getWorkspaceDirs();
      if (current.includes(resolved)) {
        res.json({ ok: true, dirs: current });
        return;
      }
      current.push(resolved);
      setWorkspaceDirs(current);
      res.json({ ok: true, dirs: current });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.delete('/api/workspace-dirs', (req, res) => {
    try {
      const { dir } = req.body;
      if (!dir) {
        res.status(400).json({ error: 'dir is required' });
        return;
      }
      const current = getWorkspaceDirs().filter(d => d !== dir);
      setWorkspaceDirs(current);
      res.json({ ok: true, dirs: current });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/browse-dir', (req, res) => {
    try {
      const home = os.homedir();
      const dirPath = typeof req.query.path === 'string' && req.query.path
        ? (req.query.path.startsWith('~') ? req.query.path.replace('~', home) : req.query.path)
        : home;
      const resolved = path.resolve(dirPath);
      if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
        res.status(400).json({ error: 'Not a valid directory' });
        return;
      }
      const entries = readdirSync(resolved, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => {
          const fullPath = path.join(resolved, e.name);
          // Detect if this looks like a project (has package.json, .git, etc.)
          let isProject = false;
          try {
            const children = readdirSync(fullPath);
            isProject = children.some(c => ['package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod', '.git', 'Makefile', 'pom.xml', '.claude'].includes(c));
          } catch { /* ignore */ }
          return { name: e.name, path: fullPath, isProject };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      const parent = path.dirname(resolved);
      res.json({ current: resolved, parent: parent !== resolved ? parent : null, entries });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Graph API ────────────────────────────────────────────────

  app.get('/api/graph/visualization', async (_req, res) => {
    try {
      const { getSharedGraphStore } = await import('../memory/graph-store.js');
      const graphDbDir = path.join(BASE_DIR, '.graph.db');
      const gs = await getSharedGraphStore(graphDbDir);
      if (!gs) {
        res.json({ nodes: [], edges: [], available: false });
        return;
      }
      const nodes = await gs.query('MATCH (n) RETURN n LIMIT 200');
      const edges = await gs.query(
        'MATCH (a)-[r]->(b) RETURN a.id AS fromId, type(r) AS rel, b.id AS toId LIMIT 500',
      );
      res.json({
        nodes: nodes.map((r: any) => {
          const n = r.n ?? r;
          return { id: n.properties?.id ?? '', label: (n.labels ?? [])[0] ?? '', props: n.properties ?? {} };
        }),
        edges: edges.map((r: any) => ({ from: r.fromId ?? '', to: r.toId ?? '', rel: r.rel ?? '' })),
        available: true,
      });
    } catch (err) {
      res.json({ nodes: [], edges: [], available: false, error: String(err) });
    }
  });

  // ── CRON CRUD routes (continued) ──────────────────────────────

  app.post('/api/cron', (req, res) => {
    try {
      const { name, schedule, prompt, tier, enabled, work_dir, mode, max_hours, max_retries, after } = req.body;
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
      const job: Record<string, unknown> = {
        name: String(name),
        schedule: String(schedule),
        prompt: String(prompt),
        enabled: enabled !== false,
        tier: isNaN(tierNum) ? 1 : tierNum,
      };
      if (work_dir) job.work_dir = String(work_dir);
      if (mode === 'unleashed') {
        job.mode = 'unleashed';
        if (max_hours) job.max_hours = Number(max_hours);
      }
      if (max_retries != null && max_retries !== '') job.max_retries = Number(max_retries);
      if (after) job.after = String(after);
      jobs.push(job);
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
      if (updates.work_dir !== undefined) {
        if (updates.work_dir) {
          jobs[idx].work_dir = String(updates.work_dir);
        } else {
          delete jobs[idx].work_dir;
        }
      }
      if (updates.mode !== undefined) {
        if (updates.mode === 'unleashed') {
          jobs[idx].mode = 'unleashed';
          if (updates.max_hours) jobs[idx].max_hours = Number(updates.max_hours);
        } else {
          delete jobs[idx].mode;
          delete jobs[idx].max_hours;
        }
      }
      if (updates.max_retries !== undefined) {
        if (updates.max_retries != null && updates.max_retries !== '') {
          jobs[idx].max_retries = Number(updates.max_retries);
        } else {
          delete jobs[idx].max_retries;
        }
      }
      if (updates.after !== undefined) {
        if (updates.after) {
          jobs[idx].after = String(updates.after);
        } else {
          delete jobs[idx].after;
        }
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

  // ── Unleashed status/cancel routes ─────────────────────────────────

  app.get('/api/unleashed', (_req, res) => {
    const unleashedDir = path.join(BASE_DIR, 'unleashed');
    if (!existsSync(unleashedDir)) {
      res.json({ tasks: [] });
      return;
    }
    try {
      const tasks: Array<Record<string, unknown>> = [];
      for (const dir of readdirSync(unleashedDir)) {
        const dirPath = path.join(unleashedDir, dir);
        if (!statSync(dirPath).isDirectory()) continue;
        const statusFile = path.join(dirPath, 'status.json');
        if (existsSync(statusFile)) {
          try {
            const status = JSON.parse(readFileSync(statusFile, 'utf-8'));
            tasks.push(status);
          } catch { /* skip corrupt */ }
        }
      }
      tasks.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      res.json({ tasks });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/unleashed/:name/cancel', (req, res) => {
    const taskName = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const cancelFile = path.join(BASE_DIR, 'unleashed', taskName, 'CANCEL');
    const taskDir = path.join(BASE_DIR, 'unleashed', taskName);
    if (!existsSync(taskDir)) {
      res.status(404).json({ error: 'Unleashed task not found' });
      return;
    }
    try {
      writeFileSync(cancelFile, new Date().toISOString());
      res.json({ ok: true, message: `Cancel signal sent to "${req.params.name}"` });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Settings / env config routes ────────────────────────────────────

  const SENSITIVE_PATTERNS = ['TOKEN', 'SECRET', 'API_KEY', 'AUTH_TOKEN', 'SID', 'PASSWORD'];

  function maskValue(key: string, value: string): string {
    const isSensitive = SENSITIVE_PATTERNS.some(p => key.toUpperCase().includes(p));
    if (!isSensitive || value.length <= 8) return value;
    return value.slice(0, 4) + '*'.repeat(Math.min(value.length - 8, 20)) + value.slice(-4);
  }

  const CONFIG_GROUPS: Array<{ label: string; keys: Array<{ key: string; label: string; hint?: string; type?: string }> }> = [
    {
      label: 'Assistant Identity',
      keys: [
        { key: 'ASSISTANT_NAME', label: 'Name', hint: 'Display name for the assistant' },
        { key: 'ASSISTANT_NICKNAME', label: 'Nickname', hint: 'Short name / alias' },
        { key: 'OWNER_NAME', label: 'Owner Name', hint: 'Your name (used in prompts)' },
      ],
    },
    {
      label: 'Model',
      keys: [
        { key: 'DEFAULT_MODEL_TIER', label: 'Default Tier', hint: 'haiku, sonnet, or opus', type: 'select:haiku,sonnet,opus' },
      ],
    },
    {
      label: 'Discord',
      keys: [
        { key: 'DISCORD_TOKEN', label: 'Bot Token', hint: 'From Discord Developer Portal', type: 'password' },
        { key: 'DISCORD_OWNER_ID', label: 'Owner User ID', hint: 'Your Discord user ID' },
        { key: 'DISCORD_WATCHED_CHANNELS', label: 'Watched Channels', hint: 'Comma-separated channel IDs for guild monitoring' },
      ],
    },
    {
      label: 'Slack',
      keys: [
        { key: 'SLACK_BOT_TOKEN', label: 'Bot Token', hint: 'xoxb-... token', type: 'password' },
        { key: 'SLACK_APP_TOKEN', label: 'App Token', hint: 'xapp-... token for Socket Mode', type: 'password' },
        { key: 'SLACK_OWNER_USER_ID', label: 'Owner User ID', hint: 'Your Slack user ID' },
      ],
    },
    {
      label: 'Telegram',
      keys: [
        { key: 'TELEGRAM_BOT_TOKEN', label: 'Bot Token', hint: 'From @BotFather', type: 'password' },
        { key: 'TELEGRAM_OWNER_ID', label: 'Owner Chat ID', hint: 'Your Telegram user/chat ID' },
      ],
    },
    {
      label: 'WhatsApp (Twilio)',
      keys: [
        { key: 'TWILIO_ACCOUNT_SID', label: 'Account SID', type: 'password' },
        { key: 'TWILIO_AUTH_TOKEN', label: 'Auth Token', type: 'password' },
        { key: 'WHATSAPP_OWNER_PHONE', label: 'Owner Phone', hint: '+1234567890' },
        { key: 'WHATSAPP_FROM_PHONE', label: 'Twilio Phone', hint: 'Twilio WhatsApp sender number' },
      ],
    },
    {
      label: 'Anthropic',
      keys: [
        { key: 'ANTHROPIC_API_KEY', label: 'API Key', hint: 'Claude API key — required for agent execution', type: 'password' },
      ],
    },
    {
      label: 'Groq',
      keys: [
        { key: 'GROQ_API_KEY', label: 'API Key', hint: 'For Whisper voice transcription', type: 'password' },
      ],
    },
    {
      label: 'ElevenLabs',
      keys: [
        { key: 'ELEVENLABS_API_KEY', label: 'API Key', hint: 'Text-to-speech for voice replies', type: 'password' },
        { key: 'ELEVENLABS_VOICE_ID', label: 'Voice ID', hint: 'Specific voice to use (from ElevenLabs dashboard)' },
      ],
    },
    {
      label: 'Google',
      keys: [
        { key: 'GOOGLE_API_KEY', label: 'API Key', hint: 'Google Vision / video analysis', type: 'password' },
      ],
    },
    {
      label: 'Microsoft Graph (Outlook)',
      keys: [
        { key: 'MS_TENANT_ID', label: 'Tenant ID', hint: 'Azure AD tenant ID' },
        { key: 'MS_CLIENT_ID', label: 'Client ID', hint: 'Azure app registration client ID' },
        { key: 'MS_CLIENT_SECRET', label: 'Client Secret', hint: 'Azure app registration secret', type: 'password' },
        { key: 'MS_USER_EMAIL', label: 'User Email', hint: 'Email address for mail/calendar access' },
      ],
    },
    {
      label: 'Webhook',
      keys: [
        { key: 'WEBHOOK_ENABLED', label: 'Enabled', hint: 'Set to "true" to enable', type: 'select:true,false' },
        { key: 'WEBHOOK_PORT', label: 'Port', hint: 'Webhook listener port (default 8420)' },
        { key: 'WEBHOOK_SECRET', label: 'Secret', hint: 'Bearer token for webhook auth', type: 'password' },
      ],
    },
    {
      label: 'Heartbeat',
      keys: [
        { key: 'HEARTBEAT_INTERVAL_MINUTES', label: 'Interval (min)', hint: 'Minutes between heartbeat checks (default 30)' },
        { key: 'HEARTBEAT_ACTIVE_START', label: 'Active Start Hour', hint: '0-23 (default 8)' },
        { key: 'HEARTBEAT_ACTIVE_END', label: 'Active End Hour', hint: '0-23 (default 22)' },
      ],
    },
  ];

  function parseEnvFile(): Record<string, string> {
    if (!existsSync(ENV_PATH)) return {};
    const result: Record<string, string> = {};
    for (const line of readFileSync(ENV_PATH, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx);
      let val = trimmed.slice(eqIdx + 1);
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      result[key] = val;
    }
    return result;
  }

  function writeEnvValue(key: string, value: string): void {
    let content = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf-8') : '';
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(content)) {
      content = content.replace(re, `${key}=${value}`);
    } else {
      content = content.trimEnd() + `\n${key}=${value}\n`;
    }
    writeFileSync(ENV_PATH, content);
  }

  app.get('/api/settings', (_req, res) => {
    try {
      const env = parseEnvFile();
      const groups = CONFIG_GROUPS.map(g => ({
        label: g.label,
        fields: g.keys.map(k => ({
          key: k.key,
          label: k.label,
          hint: k.hint,
          type: k.type ?? 'text',
          value: env[k.key] ?? '',
          masked: maskValue(k.key, env[k.key] ?? ''),
          isSet: k.key in env && env[k.key] !== '',
        })),
      }));

      // Discover custom env vars not covered by CONFIG_GROUPS
      const knownKeys = new Set(CONFIG_GROUPS.flatMap(g => g.keys.map(k => k.key)));
      const customKeys = Object.keys(env).filter(k => !knownKeys.has(k));
      if (customKeys.length > 0) {
        groups.push({
          label: 'Custom / Other',
          fields: customKeys.map(k => {
            const isSensitive = SENSITIVE_PATTERNS.some(p => k.toUpperCase().includes(p));
            return {
              key: k,
              label: k,
              hint: 'Custom environment variable',
              type: isSensitive ? 'password' : 'text',
              value: env[k],
              masked: maskValue(k, env[k]),
              isSet: true,
            };
          }),
        });
      }

      res.json({ groups });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.put('/api/settings/:key', (req, res) => {
    try {
      const { key } = req.params;
      const { value } = req.body;
      if (typeof value !== 'string') {
        res.status(400).json({ error: 'value must be a string' });
        return;
      }
      // Allow known keys + any valid env var name (A-Z, 0-9, _)
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        res.status(400).json({ error: `Invalid key format: ${key}` });
        return;
      }
      writeEnvValue(key, value);
      res.json({ ok: true, message: `Updated ${key}` });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.delete('/api/settings/:key', (req, res) => {
    try {
      const { key } = req.params;
      if (!existsSync(ENV_PATH)) {
        res.status(404).json({ error: '.env file not found' });
        return;
      }
      let content = readFileSync(ENV_PATH, 'utf-8');
      const re = new RegExp(`^${key}=.*\n?`, 'm');
      content = content.replace(re, '');
      writeFileSync(ENV_PATH, content);
      res.json({ ok: true, message: `Removed ${key}` });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Unleashed detail route ──────────────────────────────────────────

  app.get('/api/unleashed/:name/status', (req, res) => {
    const taskName = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const statusFile = path.join(BASE_DIR, 'unleashed', taskName, 'status.json');
    if (!existsSync(statusFile)) {
      res.status(404).json({ error: 'Unleashed task not found' });
      return;
    }
    try {
      const status = JSON.parse(readFileSync(statusFile, 'utf-8'));

      // Read recent progress entries
      const progressFile = path.join(BASE_DIR, 'unleashed', taskName, 'progress.jsonl');
      const progressEntries: Array<Record<string, unknown>> = [];
      if (existsSync(progressFile)) {
        const lines = readFileSync(progressFile, 'utf-8').trim().split('\n').filter(Boolean);
        for (const line of lines.slice(-20)) {
          try { progressEntries.push(JSON.parse(line)); } catch { /* skip */ }
        }
      }

      // Compute elapsed and remaining
      const elapsed = status.startedAt
        ? Math.round((Date.now() - new Date(status.startedAt).getTime()) / 60000)
        : 0;
      const remaining = status.maxHours && status.startedAt
        ? Math.max(0, Math.round(status.maxHours * 60 - elapsed))
        : null;

      res.json({ ...status, elapsed, remaining, progress: progressEntries });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Profile routes ─────────────────────────────────────────────────

  app.get('/api/profiles', async (_req, res) => {
    try {
      const profilesDir = path.join(VAULT_DIR, '00-System', 'profiles');
      if (!existsSync(profilesDir)) {
        res.json({ profiles: [], active: null });
        return;
      }

      const gateway = await getGateway();
      const { AgentManager } = await import('../agent/agent-manager.js');
      const { AGENTS_DIR } = await import('../config.js');
      const pm = new AgentManager(AGENTS_DIR, profilesDir);
      const profiles = pm.listAll().map(p => ({
        slug: p.slug,
        name: p.name,
        description: p.description,
      }));

      const activeSlug = gateway.getSessionProfile('dashboard:web') ?? null;
      res.json({ profiles, active: activeSlug });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/profiles/switch', async (req, res) => {
    try {
      const { slug } = req.body;
      const gateway = await getGateway();

      // Clear existing session so profile change takes effect cleanly
      gateway.clearSession('dashboard:web');

      if (slug) {
        gateway.setSessionProfile('dashboard:web', slug);
        res.json({ ok: true, message: `Switched to profile: ${slug}` });
      } else {
        // Clear profile (back to default)
        gateway.setSessionProfile('dashboard:web', '');
        res.json({ ok: true, message: 'Profile cleared — using default personality' });
      }
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
      const data = await searchMemory(q, 20);

      // Enrich with graph relationships for entities found in results
      let graphContext: Array<{ from: string; rel: string; to: string }> = [];
      try {
        const { getSharedGraphStore } = await import('../memory/graph-store.js');
        const graphDbDir = path.join(BASE_DIR, '.graph.db');
        const gs = await getSharedGraphStore(graphDbDir);
        if (gs) {
          const entityIds = new Set<string>();
          // Extract entity slugs from result source files
          for (const r of (data.results ?? []) as Array<Record<string, unknown>>) {
            const sf = String(r.source_file ?? '');
            if (/0[2-4]-/.test(sf)) {
              entityIds.add(path.basename(sf, '.md').toLowerCase().replace(/\s+/g, '-'));
            }
          }
          // Also try query terms
          for (const word of q.toLowerCase().split(/\s+/)) {
            const clean = word.replace(/[^a-z0-9-]/g, '');
            if (clean.length >= 3) entityIds.add(clean);
          }
          const seen = new Set<string>();
          for (const id of [...entityIds].slice(0, 5)) {
            const rels = await gs.getRelationships(id, 'both');
            for (const r of rels.slice(0, 5)) {
              const key = `${r.from}-${r.type}-${r.to}`;
              if (!seen.has(key)) {
                seen.add(key);
                graphContext.push({ from: r.from, rel: r.type, to: r.to });
              }
            }
          }
        }
      } catch { /* graph unavailable */ }

      res.json({ ...data, graphContext });
    } catch (err) {
      res.status(500).json({ results: [], error: String(err) });
    }
  });

  // ── Metrics route ─────────────────────────────────────────────────

  app.get('/api/metrics', (_req, res) => {
    res.json(computeMetrics());
  });

  // ── Token Usage API ──────────────────────────────────────────────

  app.get('/api/metrics/usage', async (_req, res) => {
    if (!existsSync(MEMORY_DB_PATH)) {
      res.json({ error: 'No DB', totalTokens: 0, byModel: [], bySource: [], byDay: [] });
      return;
    }
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(MEMORY_DB_PATH, { readonly: true });
    try {
      // Check if table exists
      const tableExists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='usage_log'",
      ).get();
      if (!tableExists) {
        res.json({ totalTokens: 0, totalInput: 0, totalOutput: 0, byModel: [], bySource: [], byDay: [] });
        return;
      }

      const totals = db.prepare(
        `SELECT COALESCE(SUM(input_tokens), 0) as ti, COALESCE(SUM(output_tokens), 0) as to_,
                COALESCE(SUM(cache_read_tokens), 0) as tcr, COALESCE(SUM(cache_creation_tokens), 0) as tcc
         FROM usage_log`,
      ).get() as { ti: number; to_: number; tcr: number; tcc: number };

      const byModel = db.prepare(
        `SELECT model, SUM(input_tokens) as input, SUM(output_tokens) as output, SUM(cache_read_tokens) as cacheRead
         FROM usage_log GROUP BY model ORDER BY input DESC`,
      ).all();

      const bySource = db.prepare(
        `SELECT source, SUM(input_tokens) as input, SUM(output_tokens) as output
         FROM usage_log GROUP BY source ORDER BY input DESC`,
      ).all();

      const byDay = db.prepare(
        `SELECT date(created_at) as day, SUM(input_tokens) as input, SUM(output_tokens) as output
         FROM usage_log WHERE created_at >= date('now', '-7 days')
         GROUP BY date(created_at) ORDER BY day`,
      ).all();

      res.json({
        totalInput: totals.ti,
        totalOutput: totals.to_,
        totalCacheRead: totals.tcr,
        totalCacheCreation: totals.tcc,
        totalTokens: totals.ti + totals.to_,
        byModel,
        bySource,
        byDay,
      });
    } catch (err) {
      res.json({ error: String(err), totalTokens: 0, byModel: [], bySource: [], byDay: [] });
    } finally {
      db.close();
    }
  });

  // ── Session Detail API ───────────────────────────────────────────

  app.get('/api/sessions/:key/messages', async (req, res) => {
    const sessionKey = req.params.key;
    if (!existsSync(MEMORY_DB_PATH)) {
      res.json({ messages: [], source: 'none' });
      return;
    }
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(MEMORY_DB_PATH, { readonly: true });
    try {
      const tableExists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='transcripts'",
      ).get();
      if (!tableExists) {
        res.json({ messages: [], source: 'none' });
        return;
      }
      const rows = db.prepare(
        `SELECT session_key, role, content, model, created_at
         FROM transcripts WHERE session_key = ? ORDER BY id LIMIT 200`,
      ).all(sessionKey) as Array<{
        session_key: string; role: string; content: string; model: string; created_at: string;
      }>;
      res.json({
        messages: rows.map(r => ({
          role: r.role,
          content: r.content,
          model: r.model,
          createdAt: r.created_at,
        })),
        source: 'transcripts',
      });
    } catch (err) {
      res.json({ messages: [], source: 'error', error: String(err) });
    } finally {
      db.close();
    }
  });

  app.get('/api/sessions/:key/usage', async (req, res) => {
    const sessionKey = req.params.key;
    if (!existsSync(MEMORY_DB_PATH)) {
      res.json({ totalTokens: 0, totalInput: 0, totalOutput: 0, numQueries: 0 });
      return;
    }
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(MEMORY_DB_PATH, { readonly: true });
    try {
      const tableExists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='usage_log'",
      ).get();
      if (!tableExists) {
        res.json({ totalTokens: 0, totalInput: 0, totalOutput: 0, numQueries: 0 });
        return;
      }
      const row = db.prepare(
        `SELECT COALESCE(SUM(input_tokens), 0) as ti, COALESCE(SUM(output_tokens), 0) as to_,
                COUNT(*) as cnt
         FROM usage_log WHERE session_key = ?`,
      ).get(sessionKey) as { ti: number; to_: number; cnt: number };
      res.json({
        totalInput: row.ti,
        totalOutput: row.to_,
        totalTokens: row.ti + row.to_,
        numQueries: row.cnt,
      });
    } catch {
      res.json({ totalTokens: 0, totalInput: 0, totalOutput: 0, numQueries: 0 });
    } finally {
      db.close();
    }
  });

  // ── MCP Status API ───────────────────────────────────────────────

  app.get('/api/mcp-status', async (_req, res) => {
    try {
      const gw = await getGateway();
      res.json(gw.getMcpStatus());
    } catch {
      res.json({ servers: [], updatedAt: '' });
    }
  });

  // ── Self-Improvement API ─────────────────────────────────────────

  app.get('/api/self-improve', (_req, res) => {
    const siDir = path.join(BASE_DIR, 'self-improve');
    const stateFile = path.join(siDir, 'state.json');
    const logFile = path.join(siDir, 'experiment-log.jsonl');
    const pendingDir = path.join(siDir, 'pending-changes');

    let state = null;
    if (existsSync(stateFile)) {
      try { state = JSON.parse(readFileSync(stateFile, 'utf-8')); } catch { /* ignore */ }
    }

    let experiments: unknown[] = [];
    if (existsSync(logFile)) {
      try {
        experiments = readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean)
          .map(l => JSON.parse(l));
      } catch { /* ignore */ }
    }

    let pending: unknown[] = [];
    if (existsSync(pendingDir)) {
      try {
        pending = readdirSync(pendingDir).filter(f => f.endsWith('.json'))
          .map(f => { try { return JSON.parse(readFileSync(path.join(pendingDir, f), 'utf-8')); } catch { return null; } })
          .filter(Boolean);
      } catch { /* ignore */ }
    }

    res.json({ state, experiments, pending });
  });

  app.post('/api/self-improve/apply/:id', async (req, res) => {
    try {
      const gw = await getGateway();
      const result = await gw.handleSelfImprove('apply', { experimentId: req.params.id });
      res.json({ ok: true, message: result });
    } catch (err) {
      res.json({ ok: false, message: String(err) });
    }
  });

  app.post('/api/self-improve/deny/:id', async (req, res) => {
    try {
      const gw = await getGateway();
      const result = await gw.handleSelfImprove('deny', { experimentId: req.params.id });
      res.json({ ok: true, message: result });
    } catch (err) {
      res.json({ ok: false, message: String(err) });
    }
  });

  // ── Team API endpoints ──────────────────────────────────────────────

  app.get('/api/team/agents', async (_req, res) => {
    try {
      const gw = await getGateway();
      const router = gw.getTeamRouter();
      const agents = router.listTeamAgents();
      res.json(agents.map(a => ({
        slug: a.slug,
        name: a.name,
        description: a.description,
        channelName: a.team?.channelName ?? '',
        canMessage: a.team?.canMessage ?? [],
        allowedTools: a.team?.allowedTools ?? null,
        model: a.model,
        project: a.project ?? null,
        agentDir: a.agentDir ?? null,
      })));
    } catch (err) {
      res.json([]);
    }
  });

  // ── Agent CRUD endpoints ────────────────────────────────────────────

  app.get('/api/agents', async (_req, res) => {
    try {
      const gw = await getGateway();
      const mgr = gw.getAgentManager();
      const all = mgr.listAll();
      // Read bot status from disk (written by BotManager in daemon)
      let botStatuses: Record<string, { status: string; botTag?: string; avatarUrl?: string; error?: string }> = {};
      try {
        const statusPath = path.join(BASE_DIR, '.bot-status.json');
        if (existsSync(statusPath)) {
          botStatuses = JSON.parse(readFileSync(statusPath, 'utf-8'));
        }
      } catch { /* ignore */ }
      // Read Slack bot status from disk (written by SlackBotManager in daemon)
      let slackBotStatuses: Record<string, { status: string; botUserId?: string; error?: string }> = {};
      try {
        const slackStatusPath = path.join(BASE_DIR, '.slack-bot-status.json');
        if (existsSync(slackStatusPath)) {
          slackBotStatuses = JSON.parse(readFileSync(slackStatusPath, 'utf-8'));
        }
      } catch { /* ignore */ }
      res.json(all.map(a => {
        // Derive invite URL from token (first segment is base64-encoded bot user ID)
        let botInviteUrl: string | null = null;
        if (a.discordToken) {
          try {
            const appId = Buffer.from(a.discordToken.split('.')[0], 'base64').toString();
            if (/^\d{17,20}$/.test(appId)) {
              botInviteUrl = `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot&permissions=68608`;
            }
          } catch { /* ignore */ }
        }
        return {
          slug: a.slug,
          name: a.name,
          description: a.description,
          avatar: a.avatar ?? null,
          tier: a.tier,
          model: a.model ?? null,
          channelName: a.team?.channelName ?? null,
          teamChat: a.team?.teamChat ?? false,
          respondToAll: a.team?.respondToAll ?? false,
          canMessage: a.team?.canMessage ?? [],
          allowedTools: a.team?.allowedTools ?? null,
          project: a.project ?? null,
          agentDir: a.agentDir ?? null,
          hasOwnCron: mgr.hasOwnCron(a.slug),
          hasOwnWorkflows: mgr.hasOwnWorkflows(a.slug),
          hasDiscordToken: Boolean(a.discordToken),
          discordChannelId: a.discordChannelId ?? null,
          botStatus: botStatuses[a.slug]?.status ?? null,
          botTag: botStatuses[a.slug]?.botTag ?? null,
          botAvatarUrl: botStatuses[a.slug]?.avatarUrl ?? null,
          botInviteUrl,
          hasSlackToken: Boolean(a.slackBotToken && a.slackAppToken),
          slackChannelId: a.slackChannelId ?? null,
          slackBotStatus: slackBotStatuses[a.slug]?.status ?? null,
          slackBotUserId: slackBotStatuses[a.slug]?.botUserId ?? null,
        };
      }));
    } catch (err) {
      res.json([]);
    }
  });

  // ── Office API — per-agent command center data ─────────────────────

  app.get('/api/office', async (_req, res) => {
    try {
      const gw = await getGateway();
      const mgr = gw.getAgentManager();
      const allAgents = mgr.listAll();
      const { AGENTS_DIR: agDir } = await import('../config.js');

      // ── Bot statuses ──
      let botStatuses: Record<string, { status: string; botTag?: string; avatarUrl?: string }> = {};
      try {
        const p = path.join(BASE_DIR, '.bot-status.json');
        if (existsSync(p)) botStatuses = JSON.parse(readFileSync(p, 'utf-8'));
      } catch { /* ignore */ }
      let slackStatuses: Record<string, { status: string; botUserId?: string }> = {};
      try {
        const p = path.join(BASE_DIR, '.slack-bot-status.json');
        if (existsSync(p)) slackStatuses = JSON.parse(readFileSync(p, 'utf-8'));
      } catch { /* ignore */ }

      // ── Cron run stats per agent ──
      const runsDir = path.join(BASE_DIR, 'cron', 'runs');
      const now = new Date();
      const localMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const todayIso = localMidnight.toISOString();

      // Map: agentSlug -> { runsToday, totalRuns, successRate, lastRun, jobs[] }
      type CronAgg = { runsToday: number; totalRuns: number; successes: number; lastRun: string; jobs: Array<{ name: string; runsToday: number; totalRuns: number; successes: number; lastRun: string; schedule?: string }> };
      const cronByAgent: Record<string, CronAgg> = {};
      const initCron = (): CronAgg => ({ runsToday: 0, totalRuns: 0, successes: 0, lastRun: '', jobs: [] });

      if (existsSync(runsDir)) {
        try {
          const files = readdirSync(runsDir).filter(f => f.endsWith('.jsonl'));
          for (const file of files) {
            const jobName = file.replace('.jsonl', '');
            // Determine agent: "slug:jobName" -> agent slug, else Clementine
            const colonIdx = jobName.indexOf(':');
            const agentSlug = colonIdx > 0 ? jobName.substring(0, colonIdx) : '__clementine__';
            const displayName = colonIdx > 0 ? jobName.substring(colonIdx + 1) : jobName;

            if (!cronByAgent[agentSlug]) cronByAgent[agentSlug] = initCron();
            const agg = cronByAgent[agentSlug];

            const filePath = path.join(runsDir, file);
            const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
            let jobRuns = 0, jobSuccesses = 0, jobRunsToday = 0, jobLastRun = '';
            for (const line of lines) {
              try {
                const entry = JSON.parse(line);
                jobRuns++;
                agg.totalRuns++;
                if (entry.status === 'ok') { jobSuccesses++; agg.successes++; }
                if (entry.startedAt > jobLastRun) jobLastRun = entry.startedAt;
                if (entry.startedAt > agg.lastRun) agg.lastRun = entry.startedAt;
                if (entry.startedAt && entry.startedAt >= todayIso) { jobRunsToday++; agg.runsToday++; }
              } catch { /* skip */ }
            }
            agg.jobs.push({ name: displayName, runsToday: jobRunsToday, totalRuns: jobRuns, successes: jobSuccesses, lastRun: jobLastRun });
          }
        } catch { /* ignore */ }
      }

      // ── Cron job definitions (schedules) ──
      // Clementine's CRON.md
      const scheduleMap: Record<string, string> = {};
      if (existsSync(CRON_FILE)) {
        try {
          const parsed = matter(readFileSync(CRON_FILE, 'utf-8'));
          for (const j of (parsed.data.jobs ?? []) as Array<{ name?: string; schedule?: string }>) {
            if (j.name && j.schedule) scheduleMap[j.name] = j.schedule;
          }
        } catch { /* ignore */ }
      }
      // Agent CRON.md files
      if (existsSync(agDir)) {
        try {
          const dirs = readdirSync(agDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
          for (const slug of dirs) {
            const cf = path.join(agDir, slug, 'CRON.md');
            if (!existsSync(cf)) continue;
            try {
              const parsed = matter(readFileSync(cf, 'utf-8'));
              for (const j of (parsed.data.jobs ?? []) as Array<{ name?: string; schedule?: string }>) {
                if (j.name && j.schedule) scheduleMap[`${slug}:${j.name}`] = j.schedule;
              }
            } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      }
      // Attach schedules to cron job entries
      for (const [agSlug, agg] of Object.entries(cronByAgent)) {
        for (const job of agg.jobs) {
          const key = agSlug === '__clementine__' ? job.name : `${agSlug}:${job.name}`;
          if (scheduleMap[key]) job.schedule = scheduleMap[key];
        }
      }

      // ── Sessions per agent ──
      const sessions = getSessions();
      type SessAgg = { active: number; totalExchanges: number };
      const sessByAgent: Record<string, SessAgg> = {};
      const agentSlugs = new Set(allAgents.map(a => a.slug));

      for (const [key, sess] of Object.entries(sessions)) {
        const s = sess as Record<string, unknown>;
        let slug = '__clementine__';
        // Match agent-scoped session keys
        for (const as of agentSlugs) {
          if (key.startsWith(`discord:agent:${as}:`) || key.startsWith(`cron:${as}:`) || key.startsWith(`agent:${as}:`)) {
            slug = as;
            break;
          }
        }
        if (!sessByAgent[slug]) sessByAgent[slug] = { active: 0, totalExchanges: 0 };
        sessByAgent[slug].active++;
        sessByAgent[slug].totalExchanges += Number(s.exchanges ?? 0);
      }

      // ── Token usage per agent ──
      type TokenAgg = { input: number; output: number };
      const tokensByAgent: Record<string, TokenAgg> = {};
      if (existsSync(MEMORY_DB_PATH)) {
        try {
          const Database = (await import('better-sqlite3')).default;
          const db = new Database(MEMORY_DB_PATH, { readonly: true });
          const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='usage_log'").get();
          if (tableExists) {
            // Per-agent usage (session_key patterns like "cron:slug:*" or "agent:slug:*")
            for (const as of agentSlugs) {
              const row = db.prepare(
                `SELECT COALESCE(SUM(input_tokens), 0) as ti, COALESCE(SUM(output_tokens), 0) as to_
                 FROM usage_log WHERE session_key LIKE ? OR session_key LIKE ? OR session_key LIKE ?`,
              ).get(`cron:${as}:%`, `agent:${as}:%`, `discord:agent:${as}:%`) as { ti: number; to_: number };
              if (row.ti > 0 || row.to_ > 0) tokensByAgent[as] = { input: row.ti, output: row.to_ };
            }
            // Clementine = everything minus agent-scoped
            const agentPrefixes = [...agentSlugs].flatMap(s => [`cron:${s}:%`, `agent:${s}:%`, `discord:agent:${s}:%`]);
            let whereNot = '';
            const params: string[] = [];
            if (agentPrefixes.length > 0) {
              whereNot = ' WHERE ' + agentPrefixes.map(() => 'session_key NOT LIKE ?').join(' AND ');
              params.push(...agentPrefixes);
            }
            const clemRow = db.prepare(
              `SELECT COALESCE(SUM(input_tokens), 0) as ti, COALESCE(SUM(output_tokens), 0) as to_ FROM usage_log${whereNot}`,
            ).get(...params) as { ti: number; to_: number };
            tokensByAgent['__clementine__'] = { input: clemRow.ti, output: clemRow.to_ };
          }
          db.close();
        } catch { /* ignore */ }
      }

      // ── Status / uptime ──
      const status = getStatus();

      // ── Build Clementine response ──
      const clemCron = cronByAgent['__clementine__'] || initCron();
      const clemSess = sessByAgent['__clementine__'] || { active: 0, totalExchanges: 0 };
      const clemTokens = tokensByAgent['__clementine__'] || { input: 0, output: 0 };

      const clementineData = {
        name: status.name,
        status: status.alive ? 'online' : 'offline',
        uptime: status.uptime || '',
        currentActivity: status.currentActivity || 'Idle',
        channels: status.channels || [],
        sessions: clemSess,
        crons: {
          total: clemCron.jobs.length,
          runsToday: clemCron.runsToday,
          successRate: clemCron.totalRuns > 0 ? Math.round((clemCron.successes / clemCron.totalRuns) * 100) : 100,
          jobs: clemCron.jobs,
        },
        tokens: clemTokens,
      };

      // ── Build agents response ──
      const agentsData = allAgents.map(a => {
        const aCron = cronByAgent[a.slug] || initCron();
        const aSess = sessByAgent[a.slug] || { active: 0, totalExchanges: 0 };
        const aTokens = tokensByAgent[a.slug] || { input: 0, output: 0 };

        const platforms: string[] = [];
        if (a.discordToken) platforms.push('discord');
        if (a.slackBotToken && a.slackAppToken) platforms.push('slack');

        return {
          slug: a.slug,
          name: a.name,
          description: a.description,
          avatar: a.avatar ?? null,
          model: a.model ?? null,
          project: a.project ?? null,
          agentDir: a.agentDir ?? null,
          channelName: a.team?.channelName ?? null,
          canMessage: a.team?.canMessage ?? [],
          allowedTools: a.team?.allowedTools ?? null,
          botStatus: botStatuses[a.slug]?.status ?? null,
          botTag: botStatuses[a.slug]?.botTag ?? null,
          botAvatarUrl: botStatuses[a.slug]?.avatarUrl ?? null,
          slackBotStatus: slackStatuses[a.slug]?.status ?? null,
          hasDiscordToken: Boolean(a.discordToken),
          hasSlackToken: Boolean(a.slackBotToken && a.slackAppToken),
          platforms,
          sessions: aSess,
          crons: {
            total: aCron.jobs.length,
            runsToday: aCron.runsToday,
            successRate: aCron.totalRuns > 0 ? Math.round((aCron.successes / aCron.totalRuns) * 100) : 100,
            jobs: aCron.jobs,
          },
          tokens: aTokens,
        };
      });

      res.json({ clementine: clementineData, agents: agentsData });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/agents', async (req, res) => {
    try {
      const gw = await getGateway();
      const mgr = gw.getAgentManager();
      const { name, description, personality, tier, model, channelName, teamChat, respondToAll, canMessage, allowedTools, project, discordToken, discordChannelId, avatar, slackBotToken, slackAppToken, slackChannelId } = req.body;
      if (!name || !description) {
        res.status(400).json({ error: 'name and description are required' });
        return;
      }
      const agent = mgr.createAgent({
        name, description, personality,
        tier: tier ?? 2,
        model: model || undefined,
        channelName: channelName || undefined,
        teamChat: teamChat ?? undefined,
        respondToAll: respondToAll ?? undefined,
        canMessage: canMessage || undefined,
        allowedTools: allowedTools || undefined,
        project: project || undefined,
        discordToken: discordToken || undefined,
        discordChannelId: discordChannelId || undefined,
        avatar: avatar || undefined,
        slackBotToken: slackBotToken || undefined,
        slackAppToken: slackAppToken || undefined,
        slackChannelId: slackChannelId || undefined,
      });
      res.json({ ok: true, agent: { slug: agent.slug, name: agent.name } });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.put('/api/agents/:slug', async (req, res) => {
    try {
      const gw = await getGateway();
      const mgr = gw.getAgentManager();
      const { slug } = req.params;
      const agent = mgr.updateAgent(slug, req.body);
      res.json({ ok: true, agent: { slug: agent.slug, name: agent.name } });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.delete('/api/agents/:slug', async (req, res) => {
    try {
      const gw = await getGateway();
      const mgr = gw.getAgentManager();
      mgr.deleteAgent(req.params.slug);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  // ── Discord channel discovery ───────────────────────────────────────

  /** Fetch all text channels from all guilds the main bot is in, via Discord REST API. */
  app.get('/api/discord/channels', async (_req, res) => {
    try {
      // Get the main Discord bot token
      const env = parseEnvFile();
      let token = env['DISCORD_TOKEN'] ?? '';
      if (!token) {
        // Try Keychain fallback
        const name = getAssistantName().toLowerCase();
        try {
          token = execSync(
            `security find-generic-password -s "${name}" -a "DISCORD_TOKEN" -w`,
            { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
          ).trim();
        } catch { /* no token */ }
      }
      if (!token) {
        res.json({ ok: false, error: 'No Discord token configured', channels: [] });
        return;
      }

      // Fetch guilds
      const guildsRes = await fetch('https://discord.com/api/v10/users/@me/guilds', {
        headers: { Authorization: `Bot ${token}` },
      });
      if (!guildsRes.ok) {
        res.json({ ok: false, error: `Discord API error: ${guildsRes.status}`, channels: [] });
        return;
      }
      const guilds = await guildsRes.json() as Array<{ id: string; name: string }>;

      // Fetch channels for each guild
      const allChannels: Array<{ id: string; name: string; guildId: string; guildName: string; type: number }> = [];
      for (const guild of guilds) {
        try {
          const chRes = await fetch(`https://discord.com/api/v10/guilds/${guild.id}/channels`, {
            headers: { Authorization: `Bot ${token}` },
          });
          if (!chRes.ok) continue;
          const channels = await chRes.json() as Array<{ id: string; name: string; type: number; parent_id?: string }>;
          // Type 0 = text, type 5 = announcement — both usable
          for (const ch of channels.filter(c => c.type === 0 || c.type === 5)) {
            allChannels.push({
              id: ch.id,
              name: ch.name,
              guildId: guild.id,
              guildName: guild.name,
              type: ch.type,
            });
          }
        } catch { /* skip guild */ }
      }

      res.json({ ok: true, channels: allChannels });
    } catch (err) {
      res.json({ ok: false, error: String(err), channels: [] });
    }
  });

  // ── Slack channel discovery ────────────────────────────────────────

  /** Fetch all channels the main Slack bot can see, via conversations.list. */
  app.get('/api/slack/channels', async (_req, res) => {
    try {
      const env = parseEnvFile();
      let botToken = env['SLACK_BOT_TOKEN'] ?? '';
      if (!botToken) {
        const name = getAssistantName().toLowerCase();
        try {
          botToken = execSync(
            `security find-generic-password -s "${name}" -a "SLACK_BOT_TOKEN" -w`,
            { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
          ).trim();
        } catch { /* no token */ }
      }
      if (!botToken) {
        res.json({ ok: false, error: 'No Slack bot token configured', channels: [] });
        return;
      }

      // Use fetch to call Slack's conversations.list API (paginate)
      const allChannels: Array<{ id: string; name: string; is_member: boolean }> = [];
      let cursor = '';
      do {
        const url = `https://slack.com/api/conversations.list?types=public_channel,private_channel&exclude_archived=true&limit=200${cursor ? '&cursor=' + cursor : ''}`;
        const resp = await fetch(url, {
          headers: { Authorization: `Bearer ${botToken}` },
        });
        const data = await resp.json() as any;
        if (!data.ok) {
          res.json({ ok: false, error: data.error || 'Slack API error', channels: [] });
          return;
        }
        for (const ch of data.channels ?? []) {
          allChannels.push({
            id: ch.id,
            name: ch.name,
            is_member: ch.is_member ?? false,
          });
        }
        cursor = data.response_metadata?.next_cursor || '';
      } while (cursor);

      res.json({ ok: true, channels: allChannels });
    } catch (err) {
      res.json({ ok: false, error: String(err), channels: [] });
    }
  });

  // ── Bot token helper endpoints ──────────────────────────────────────

  /** Derive invite URL from a raw token (no save needed). */
  app.post('/api/bot/derive-invite', (req, res) => {
    try {
      const { token } = req.body;
      if (!token || typeof token !== 'string') {
        res.status(400).json({ error: 'token required' });
        return;
      }
      const parts = token.split('.');
      if (parts.length !== 3) {
        res.status(400).json({ error: 'Invalid token format — should have 3 dot-separated segments' });
        return;
      }
      const appId = Buffer.from(parts[0], 'base64').toString();
      if (!/^\d{17,20}$/.test(appId)) {
        res.status(400).json({ error: 'Could not decode a valid application ID from token' });
        return;
      }
      // Permission 68608 = VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY
      const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot&permissions=68608`;
      res.json({ ok: true, appId, inviteUrl });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.get('/api/team/messages', async (req, res) => {
    try {
      const gw = await getGateway();
      const limit = parseInt(String(req.query.limit ?? '50'), 10);
      const messages = gw.getTeamBus().getRecentMessages(Math.min(limit, 200));
      res.json(messages);
    } catch (err) {
      res.json([]);
    }
  });

  app.get('/api/team/topology', async (_req, res) => {
    try {
      const gw = await getGateway();
      const { nodes, edges } = gw.getTeamRouter().getTopology();
      res.json({
        nodes: nodes.map(n => ({ slug: n.slug, name: n.name, description: n.description })),
        edges,
      });
    } catch (err) {
      res.json({ nodes: [], edges: [] });
    }
  });

  // ── Synchronous team message delivery (used by MCP tool) ──────────
  app.post('/api/team/message', async (req, res) => {
    try {
      const { from_agent, to_agent, message, depth } = req.body;
      if (!from_agent || !to_agent || !message) {
        res.json({ ok: false, error: 'Missing from_agent, to_agent, or message' });
        return;
      }
      const gw = await getGateway();
      const result = await gw.handleTeamMessage(from_agent, to_agent, message, depth ?? 0);
      res.json({
        ok: true,
        id: result.id,
        delivered: result.delivered,
        response: result.response ?? null,
      });
    } catch (err) {
      res.json({ ok: false, error: String(err) });
    }
  });

  // ── Team pending requests API ────────────────────────────────────
  app.get('/api/team/pending-requests', async (req, res) => {
    try {
      const gw = await getGateway();
      const agentSlug = req.query.agent as string;
      if (!agentSlug) {
        res.json({ ok: false, error: 'agent parameter required' });
        return;
      }
      const bus = gw.getTeamBus();
      const pending = bus.getPendingRequests(agentSlug);
      res.json({ ok: true, requests: pending });
    } catch (err) {
      res.json({ ok: false, error: String(err) });
    }
  });

  // ── Structured team request with response ──────────────────────
  app.post('/api/team/request', async (req, res) => {
    try {
      const gw = await getGateway();
      const { from_agent, to_agent, content, timeout_ms } = req.body;
      const bus = gw.getTeamBus();
      const response = await bus.request(from_agent, to_agent, content, timeout_ms ?? 300_000);
      res.json({ ok: true, response: response.content, id: response.id });
    } catch (err) {
      const isTimeout = String(err).includes('timed out');
      res.json({ ok: false, error: String(err), timed_out: isTimeout });
    }
  });

  // ── Daily Plans API ─────────────────────────────────────────────

  const PLANS_DIR = path.join(BASE_DIR, 'plans', 'daily');

  app.get('/api/plans/today', (_req, res) => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const planPath = path.join(PLANS_DIR, `${dateStr}.json`);
    if (!existsSync(planPath)) {
      res.json({ ok: false, plan: null });
      return;
    }
    try {
      res.json({ ok: true, plan: JSON.parse(readFileSync(planPath, 'utf-8')) });
    } catch { res.json({ ok: false, plan: null }); }
  });

  app.get('/api/plans/:date', (req, res) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) {
      res.json({ ok: false, plan: null, error: 'Invalid date format' });
      return;
    }
    const planPath = path.join(PLANS_DIR, `${req.params.date}.json`);
    if (!existsSync(planPath)) {
      res.json({ ok: false, plan: null });
      return;
    }
    try {
      res.json({ ok: true, plan: JSON.parse(readFileSync(planPath, 'utf-8')) });
    } catch { res.json({ ok: false, plan: null }); }
  });

  app.get('/api/plans', (_req, res) => {
    if (!existsSync(PLANS_DIR)) { res.json({ plans: [] }); return; }
    try {
      const files = readdirSync(PLANS_DIR).filter(f => f.endsWith('.json')).sort().reverse();
      const plans = files.slice(0, 30).map(f => {
        try {
          const plan = JSON.parse(readFileSync(path.join(PLANS_DIR, f), 'utf-8'));
          return { date: plan.date, summary: plan.summary, priorityCount: plan.priorities?.length ?? 0, createdAt: plan.createdAt };
        } catch { return null; }
      }).filter(Boolean);
      res.json({ plans });
    } catch { res.json({ plans: [] }); }
  });

  app.post('/api/plans/apply', (req, res) => {
    const { job, change, reason } = req.body;
    if (!job || !change) {
      res.json({ ok: false, error: 'job and change required' });
      return;
    }
    const validChanges = ['disable', 'adjust-schedule', 'adjust-prompt'];
    if (!validChanges.includes(change)) {
      res.json({ ok: false, error: `Invalid change type. Must be: ${validChanges.join(', ')}` });
      return;
    }
    try {
      const cronFile = path.join(VAULT_DIR, '00-System', 'CRON.md');
      if (!existsSync(cronFile)) {
        res.json({ ok: false, error: 'CRON.md not found' });
        return;
      }
      const raw = readFileSync(cronFile, 'utf-8');
      const parsed = matter(raw);
      const jobs = parsed.data.jobs || [];
      const idx = jobs.findIndex((j: any) => j.name === job);
      if (idx === -1) {
        res.json({ ok: false, error: `Job "${job}" not found in CRON.md` });
        return;
      }
      if (change === 'disable') {
        jobs[idx].enabled = false;
      } else if (change === 'adjust-schedule' && req.body.newSchedule) {
        jobs[idx].schedule = req.body.newSchedule;
      } else if (change === 'adjust-prompt' && req.body.newPrompt) {
        jobs[idx].prompt = req.body.newPrompt;
      }
      parsed.data.jobs = jobs;
      writeFileSync(cronFile, matter.stringify(parsed.content, parsed.data));
      res.json({ ok: true, applied: { job, change, reason } });
    } catch (err) {
      res.json({ ok: false, error: String(err) });
    }
  });

  // ── Advisor Decision Analytics API ─────────────────────────────

  const ADVISOR_LOG = path.join(BASE_DIR, 'cron', 'advisor-decisions.jsonl');

  app.get('/api/advisor/decisions', (req, res) => {
    const limit = parseInt(String(req.query.limit ?? '100'), 10);
    if (!existsSync(ADVISOR_LOG)) { res.json({ decisions: [] }); return; }
    try {
      const lines = readFileSync(ADVISOR_LOG, 'utf-8').trim().split('\n').filter(Boolean);
      const decisions = lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
      res.json({ decisions });
    } catch { res.json({ decisions: [] }); }
  });

  app.get('/api/advisor/analytics', (_req, res) => {
    // Build analytics from run logs + advisor decisions
    const runsDir = path.join(BASE_DIR, 'cron', 'runs');
    const analytics: {
      totalInterventions: number;
      circuitBreakers: number;
      modelUpgrades: number;
      turnAdjustments: number;
      timeoutAdjustments: number;
      escalations: number;
      enrichments: number;
      successAfterIntervention: number;
      failureAfterIntervention: number;
      byJob: Record<string, { interventions: number; successRate: number; totalRuns: number }>;
      recentDecisions: any[];
    } = {
      totalInterventions: 0,
      circuitBreakers: 0,
      modelUpgrades: 0,
      turnAdjustments: 0,
      timeoutAdjustments: 0,
      escalations: 0,
      enrichments: 0,
      successAfterIntervention: 0,
      failureAfterIntervention: 0,
      byJob: {},
      recentDecisions: [],
    };

    // Read advisor decisions log
    if (existsSync(ADVISOR_LOG)) {
      try {
        const lines = readFileSync(ADVISOR_LOG, 'utf-8').trim().split('\n').filter(Boolean);
        const decisions = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        analytics.recentDecisions = decisions.slice(-20).reverse();

        for (const d of decisions) {
          analytics.totalInterventions++;
          if (d.advice?.adjustedModel) analytics.modelUpgrades++;
          if (d.advice?.adjustedMaxTurns) analytics.turnAdjustments++;
          if (d.advice?.adjustedTimeoutMs) analytics.timeoutAdjustments++;
          if (d.advice?.shouldEscalate) analytics.escalations++;
          if (d.advice?.promptEnrichment) analytics.enrichments++;
        }
      } catch { /* ignore */ }
    }

    // Scan run logs for circuit breakers, success/failure after intervention
    if (existsSync(runsDir)) {
      try {
        for (const f of readdirSync(runsDir).filter(f => f.endsWith('.jsonl'))) {
          const jobName = f.replace('.jsonl', '');
          const lines = readFileSync(path.join(runsDir, f), 'utf-8').trim().split('\n').filter(Boolean);
          let totalRuns = 0;
          let okRuns = 0;
          let interventionOk = 0;
          let interventionFail = 0;

          for (const line of lines.slice(-50)) {
            try {
              const entry = JSON.parse(line);
              totalRuns++;
              if (entry.status === 'ok') okRuns++;
              if (entry.status === 'skipped') analytics.circuitBreakers++;
              if (entry.advisorApplied) {
                if (entry.status === 'ok') interventionOk++;
                else interventionFail++;
              }
            } catch { continue; }
          }

          analytics.successAfterIntervention += interventionOk;
          analytics.failureAfterIntervention += interventionFail;

          if (totalRuns > 0) {
            analytics.byJob[jobName] = {
              interventions: interventionOk + interventionFail,
              successRate: totalRuns > 0 ? Math.round((okRuns / totalRuns) * 100) : 0,
              totalRuns,
            };
          }
        }
      } catch { /* ignore */ }
    }

    res.json(analytics);
  });

  // ── Goals Progress API ─────────────────────────────────────────

  const GOALS_DIR = path.join(BASE_DIR, 'goals');
  const CRON_RUNS_DIR = path.join(BASE_DIR, 'cron', 'runs');

  app.get('/api/goals/progress', (_req, res) => {
    if (!existsSync(GOALS_DIR)) { res.json({ goals: [] }); return; }
    try {
      const files = readdirSync(GOALS_DIR).filter(f => f.endsWith('.json'));
      const goals = files.map(f => {
        try {
          const goal = JSON.parse(readFileSync(path.join(GOALS_DIR, f), 'utf-8'));

          // Find agent contributions: scan cron runs for jobs linked to this goal
          const agentContributions: Record<string, { runs: number; successes: number; lastRun?: string }> = {};
          if (goal.linkedCronJobs?.length && existsSync(CRON_RUNS_DIR)) {
            for (const jobName of goal.linkedCronJobs) {
              const safe = jobName.replace(/[^a-zA-Z0-9_-]/g, '_');
              const logFile = path.join(CRON_RUNS_DIR, `${safe}.jsonl`);
              if (!existsSync(logFile)) continue;
              const lines = readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean);
              for (const line of lines.slice(-20)) {
                try {
                  const entry = JSON.parse(line);
                  const agent = entry.agentSlug || jobName;
                  if (!agentContributions[agent]) agentContributions[agent] = { runs: 0, successes: 0 };
                  agentContributions[agent].runs++;
                  if (entry.status === 'ok') agentContributions[agent].successes++;
                  agentContributions[agent].lastRun = entry.finishedAt;
                } catch { continue; }
              }
            }
          }

          // Scan delegated tasks for this goal
          const delegationsDir = path.join(VAULT_DIR, '00-System', 'agents');
          const delegations: Array<{ agent: string; task: string; status: string }> = [];
          if (existsSync(delegationsDir)) {
            try {
              for (const agentDir of readdirSync(delegationsDir)) {
                const tasksDir = path.join(delegationsDir, agentDir, 'delegations');
                if (!existsSync(tasksDir)) continue;
                for (const tf of readdirSync(tasksDir).filter(tf => tf.endsWith('.json'))) {
                  try {
                    const task = JSON.parse(readFileSync(path.join(tasksDir, tf), 'utf-8'));
                    if (task.goalId === goal.id) {
                      delegations.push({ agent: task.toAgent || agentDir, task: task.task || tf, status: task.status || 'pending' });
                    }
                  } catch { continue; }
                }
              }
            } catch { /* ignore */ }
          }

          return {
            ...goal,
            agentContributions,
            delegations,
          };
        } catch { return null; }
      }).filter(Boolean);

      res.json({ goals });
    } catch { res.json({ goals: [] }); }
  });

  // ── Reflection Quality Trends API ──────────────────────────────

  const CRON_REFLECTIONS_DIR = path.join(BASE_DIR, 'cron', 'reflections');

  app.get('/api/advisor/reflection-trends', (_req, res) => {
    if (!existsSync(CRON_REFLECTIONS_DIR)) { res.json({ trends: {} }); return; }
    try {
      const trends: Record<string, Array<{ date: string; quality: number }>> = {};
      for (const f of readdirSync(CRON_REFLECTIONS_DIR).filter(f => f.endsWith('.jsonl'))) {
        const jobName = f.replace('.jsonl', '');
        const lines = readFileSync(path.join(CRON_REFLECTIONS_DIR, f), 'utf-8').trim().split('\n').filter(Boolean);
        trends[jobName] = lines.slice(-20).map(l => {
          try {
            const entry = JSON.parse(l);
            return { date: entry.timestamp?.slice(0, 10) ?? '', quality: entry.quality ?? 0 };
          } catch { return null; }
        }).filter((e): e is { date: string; quality: number } => e !== null);
      }
      res.json({ trends });
    } catch { res.json({ trends: {} }); }
  });

  // ── Plan Diff API ─────────────────────────────────────────────

  app.get('/api/plans/diff', (req, res) => {
    const date1 = req.query.from as string;
    const date2 = req.query.to as string;
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    if (!date1 || !date2 || !dateRe.test(date1) || !dateRe.test(date2)) {
      res.json({ ok: false, error: 'Valid YYYY-MM-DD from and to params required' });
      return;
    }
    try {
      const path1 = path.join(PLANS_DIR, `${date1}.json`);
      const path2 = path.join(PLANS_DIR, `${date2}.json`);
      const plan1 = existsSync(path1) ? JSON.parse(readFileSync(path1, 'utf-8')) : null;
      const plan2 = existsSync(path2) ? JSON.parse(readFileSync(path2, 'utf-8')) : null;

      if (!plan1 || !plan2) {
        res.json({ ok: false, error: 'One or both plans not found' });
        return;
      }

      // Compute diff: what was added, removed, carried over
      const actions1 = new Set((plan1.priorities || []).map((p: any) => p.action));
      const actions2 = new Set((plan2.priorities || []).map((p: any) => p.action));

      const carried = (plan2.priorities || []).filter((p: any) => actions1.has(p.action));
      const added = (plan2.priorities || []).filter((p: any) => !actions1.has(p.action));
      const resolved = (plan1.priorities || []).filter((p: any) => !actions2.has(p.action));

      res.json({
        ok: true,
        from: { date: plan1.date, summary: plan1.summary, count: plan1.priorities?.length ?? 0 },
        to: { date: plan2.date, summary: plan2.summary, count: plan2.priorities?.length ?? 0 },
        carried,
        added,
        resolved,
      });
    } catch (err) { res.json({ ok: false, error: String(err) }); }
  });

  // ── Advisor Events API (circuit breakers, escalations, recoveries) ──

  app.get('/api/advisor/events', (req, res) => {
    const limit = parseInt(String(req.query.limit ?? '50'), 10);
    const eventsPath = path.join(BASE_DIR, 'cron', 'advisor-events.jsonl');
    if (!existsSync(eventsPath)) { res.json({ events: [] }); return; }
    try {
      const lines = readFileSync(eventsPath, 'utf-8').trim().split('\n').filter(Boolean);
      const events = lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
      res.json({ events });
    } catch { res.json({ events: [] }); }
  });

  // ── Advisor Outcome Effectiveness API ─────────────────────────

  app.get('/api/advisor/effectiveness', (_req, res) => {
    if (!existsSync(ADVISOR_LOG)) { res.json({ byType: {} }); return; }
    try {
      const lines = readFileSync(ADVISOR_LOG, 'utf-8').trim().split('\n').filter(Boolean);
      const outcomes = lines
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter((d): d is any => d !== null && d.type === 'outcome');

      const byType: Record<string, { total: number; success: number; rate: number }> = {};

      const track = (key: string, success: boolean) => {
        if (!byType[key]) byType[key] = { total: 0, success: 0, rate: 0 };
        byType[key].total++;
        if (success) byType[key].success++;
      };

      for (const o of outcomes) {
        const ok = o.outcome === 'ok';
        if (o.interventions?.adjustedModel) track('model-upgrade', ok);
        if (o.interventions?.adjustedMaxTurns) track('turn-adjustment', ok);
        if (o.interventions?.adjustedTimeoutMs) track('timeout-adjustment', ok);
        if (o.interventions?.enriched) track('prompt-enrichment', ok);
        if (o.interventions?.escalated) track('escalation', ok);
      }

      for (const v of Object.values(byType)) {
        v.rate = v.total > 0 ? Math.round((v.success / v.total) * 100) : 0;
      }

      res.json({ byType, totalOutcomes: outcomes.length });
    } catch { res.json({ byType: {}, totalOutcomes: 0 }); }
  });

  // ── Remote access API ────────────────────────────────────────────

  app.get('/api/remote-access', (_req, res) => {
    const config = loadRemoteConfig();
    res.json({
      enabled: config.enabled,
      autoPost: config.autoPost,
      tunnelRunning: tunnelManager?.isRunning() ?? false,
      tunnelUrl: tunnelManager?.getUrl() ?? config.tunnelUrl ?? null,
      authToken: config.authToken || null,
      cloudflaredInstalled: TunnelManager.isInstalled(),
      installInstructions: TunnelManager.getInstallInstructions(),
    });
  });

  app.post('/api/remote-access/enable', async (req, res) => {
    try {
      if (!TunnelManager.isInstalled()) {
        res.status(400).json({
          error: `cloudflared is not installed. Run: ${TunnelManager.getInstallInstructions()}`,
        });
        return;
      }

      let config = loadRemoteConfig();
      if (!config.authToken) {
        config.authToken = generateAccessToken();
      }
      config.enabled = true;
      config.lastStarted = new Date().toISOString();
      saveRemoteConfig(config);

      // Start tunnel if not already running
      if (!tunnelManager || !tunnelManager.isRunning()) {
        tunnelManager = new TunnelManager(actualPort);
        tunnelManager.on('url', async (url: string) => {
          config = loadRemoteConfig();
          config.tunnelUrl = url;
          saveRemoteConfig(config);
          if (config.autoPost) {
            notifyTunnelUrl(url).catch(() => {});
          }
        });
        const url = await tunnelManager.start();
        config.tunnelUrl = url;
        saveRemoteConfig(config);
      }

      res.json({
        ok: true,
        authToken: config.authToken,
        tunnelUrl: tunnelManager.getUrl(),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/remote-access/disable', (_req, res) => {
    const config = loadRemoteConfig();
    config.enabled = false;
    config.tunnelUrl = undefined;
    saveRemoteConfig(config);

    if (tunnelManager) {
      tunnelManager.stop();
      tunnelManager = null;
    }

    // Clear all remote sessions
    sessions.clear();

    res.json({ ok: true });
  });

  app.post('/api/remote-access/regenerate-token', (_req, res) => {
    const config = loadRemoteConfig();
    config.authToken = generateAccessToken();
    saveRemoteConfig(config);
    // Invalidate all existing sessions
    sessions.clear();
    res.json({ ok: true, authToken: config.authToken });
  });

  app.post('/api/remote-access/toggle-auto-post', (_req, res) => {
    const config = loadRemoteConfig();
    config.autoPost = !config.autoPost;
    saveRemoteConfig(config);
    res.json({ ok: true, autoPost: config.autoPost });
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
          console.log(`  Token: ${dashboardToken.slice(0, 8)}...`);
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

  // Auto-start tunnel if remote access is enabled
  if (remoteConfig.enabled && TunnelManager.isInstalled()) {
    try {
      tunnelManager = new TunnelManager(actualPort);
      tunnelManager.on('url', async (url: string) => {
        const cfg = loadRemoteConfig();
        cfg.tunnelUrl = url;
        saveRemoteConfig(cfg);
        if (cfg.autoPost) {
          notifyTunnelUrl(url).catch(() => {});
        }
      });
      const url = await tunnelManager.start();
      console.log(`  Remote: ${url}`);
      console.log(`  Token:  ${remoteConfig.authToken}`);
      console.log();
    } catch (err) {
      console.log(`  Remote access: tunnel failed to start (${String(err)})`);
      console.log();
    }
  }

  // Keep alive
  await new Promise<void>(() => {});
}

// ── Inline HTML Dashboard ────────────────────────────────────────────

function getDashboardHTML(token: string): string {
  const name = getAssistantName();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="dashboard-token" content="${token}">
<title>${name} Command Center</title>
<style>
  :root {
    --bg-primary: #f5f6f8;
    --bg-secondary: #ffffff;
    --bg-card: rgba(255,255,255,0.95);
    --bg-hover: #eef1f5;
    --bg-input: #f0f2f5;
    --border: #d8dde5;
    --border-light: #c5ccd6;
    --text-primary: #1a1a2e;
    --text-secondary: #5a6070;
    --text-muted: #8a92a0;
    --accent: #4d9eff;
    --accent-glow: rgba(43, 125, 233, 0.10);
    --purple: #7c3aed;
    --orange: #f0883e;
    --clementine: #ff8c21;
    --clementine-dark: #e67a10;
    --clementine-glow: rgba(255, 140, 33, 0.10);
    --clementine-bg: rgba(255, 140, 33, 0.08);
    --green: #2ea043;
    --green-bg: rgba(46, 160, 67, 0.12);
    --red: #e5534b;
    --red-bg: rgba(229, 83, 75, 0.12);
    --yellow: #d4a72c;
    --yellow-bg: rgba(212, 167, 44, 0.12);
    --orange: #f0883e;
    --sidebar-w: 220px;
    --header-h: 56px;
    --radius: 10px;
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
    background: linear-gradient(135deg, var(--clementine), #ff6b00);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    font-weight: 700;
    color: #fff;
    flex-shrink: 0;
  }
  .logo.online {
    animation: logoBreathOrange 3s ease-in-out infinite;
  }
  @keyframes logoBreathOrange {
    0%, 100% { box-shadow: 0 0 0 0 rgba(255,140,33,0); }
    50% { box-shadow: 0 0 0 6px rgba(255,140,33,0.25); }
  }
  .block-wordmark {
    display: flex;
    flex-direction: column;
    gap: 0;
    line-height: 1;
  }
  .block-wordmark-row {
    display: flex;
    gap: 1px;
    height: 3px;
  }
  .block-wordmark-row span {
    display: inline-block;
    width: 2px;
    height: 3px;
    background: var(--clementine);
    border-radius: 0.5px;
  }
  .block-wordmark-row span.off {
    background: transparent;
  }
  header h1 {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-primary);
    letter-spacing: -0.01em;
  }
  header h1 span { color: var(--clementine); }
  .header-subtitle {
    font-size: 10px;
    color: var(--text-muted);
    font-weight: 400;
    letter-spacing: 0.04em;
  }
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
    font-size: 9px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
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
    background: var(--clementine-glow);
    color: var(--clementine);
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
    background: var(--clementine-glow);
    color: var(--clementine);
  }

  /* ── Content ────────────────────────────── */
  .content {
    overflow-y: auto;
    padding: 28px;
  }
  .page { display: none; }
  .page.active { display: block; }
  .page-title {
    font-size: 24px;
    font-weight: 600;
    margin-bottom: 20px;
    color: var(--text-primary);
    letter-spacing: -0.02em;
  }

  /* ── Cards ──────────────────────────────── */
  .card {
    background: var(--bg-card);
    backdrop-filter: blur(8px);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 16px;
    overflow: hidden;
    box-shadow: 0 2px 8px rgba(0,0,0,0.06);
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
    gap: 20px;
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
  .badge-blue { background: rgba(56,139,253,0.15); color: #58a6ff; }
  .badge-purple { background: rgba(163,113,247,0.15); color: #a371f7; }
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
  .schedule-builder .form-row {
    margin-bottom: 8px;
  }
  .schedule-builder .form-row:last-child {
    margin-bottom: 0;
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
    box-shadow: 0 24px 80px rgba(0,0,0,0.6);
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
    color: var(--text-secondary);
    max-height: calc(100vh - 240px);
    overflow-y: auto;
  }
  .log-entry {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 3px 0;
    border-bottom: 1px solid rgba(30,42,58,0.2);
  }
  .log-entry:last-child { border-bottom: none; }
  .log-time {
    color: var(--text-muted);
    font-size: 10px;
    flex-shrink: 0;
    min-width: 70px;
  }
  .log-level {
    font-size: 10px;
    font-weight: 700;
    padding: 1px 6px;
    border-radius: 3px;
    flex-shrink: 0;
    min-width: 42px;
    text-align: center;
    text-transform: uppercase;
  }
  .log-level-info { background: rgba(56,139,253,0.15); color: #58a6ff; }
  .log-level-warn { background: var(--yellow-bg); color: var(--yellow); }
  .log-level-error { background: var(--red-bg); color: var(--red); }
  .log-level-fatal { background: var(--red); color: #fff; }
  .log-level-debug { background: rgba(90,106,126,0.15); color: var(--text-muted); }
  .log-level-trace { background: rgba(90,106,126,0.1); color: var(--text-muted); }
  .log-source {
    color: var(--accent);
    font-size: 10px;
    flex-shrink: 0;
    max-width: 100px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .log-msg {
    color: var(--text-primary);
    word-break: break-word;
    flex: 1;
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

  /* ── Disabled cron rows ──────────────────── */
  tr.row-disabled td { opacity: 0.45; }
  tr.row-disabled:hover td { opacity: 0.7; }

  /* ── Activity feed ───────────────────────── */
  .activity-item {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 8px 0;
    border-bottom: 1px solid rgba(30,42,58,0.5);
    font-size: 12px;
  }
  .activity-item:last-child { border-bottom: none; }
  .activity-icon {
    flex-shrink: 0;
    width: 20px;
    text-align: center;
    font-size: 13px;
  }
  .activity-msg { flex: 1; color: var(--text-primary); line-height: 1.4; }
  .activity-time { flex-shrink: 0; color: var(--text-muted); font-size: 11px; }

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
    white-space: normal;
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

  /* ── Agent Hero Banner ──────────────────── */
  .agent-hero {
    background: linear-gradient(135deg, var(--clementine-bg), rgba(124,58,237,0.06));
    border-radius: 16px;
    padding: 32px;
    margin-bottom: 24px;
    position: relative;
    overflow: hidden;
    border: 1px solid var(--border);
  }
  .agent-hero::before {
    content: '';
    position: absolute;
    inset: 0;
    background: radial-gradient(ellipse at 30% 50%, rgba(255,140,33,0.06), transparent 70%);
    animation: heroShimmer 8s ease-in-out infinite alternate;
    pointer-events: none;
  }
  @keyframes heroShimmer {
    0% { transform: translateX(-10%) scale(1); opacity: 0.5; }
    100% { transform: translateX(10%) scale(1.1); opacity: 1; }
  }
  .agent-hero-top {
    display: flex;
    align-items: center;
    gap: 20px;
    position: relative;
    z-index: 1;
  }
  .agent-avatar {
    width: 72px;
    height: 72px;
    border-radius: 50%;
    background: linear-gradient(135deg, var(--clementine), #ff6b00);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 28px;
    font-weight: 800;
    color: #fff;
    flex-shrink: 0;
    position: relative;
  }
  .agent-avatar::after {
    content: '';
    position: absolute;
    inset: -4px;
    border-radius: 50%;
    border: 2.5px solid var(--red);
    opacity: 0.6;
  }
  .agent-avatar.online::after {
    border-color: var(--green);
    animation: breathe 3s ease-in-out infinite;
  }
  @keyframes breathe {
    0%, 100% { transform: scale(1); opacity: 0.4; }
    50% { transform: scale(1.05); opacity: 1; }
  }

  /* ── The Office — Desk Grid ─────────────── */
  .office-floor {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 20px;
    margin-top: 16px;
    padding: 28px;
    background:
      radial-gradient(circle, var(--border) 1px, transparent 1px);
    background-size: 24px 24px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    min-height: 200px;
  }

  .desk-station {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0;
    transition: transform 0.2s, box-shadow 0.2s;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .desk-station:hover {
    transform: translateY(-3px);
    box-shadow: 0 6px 20px rgba(0,0,0,0.08);
  }

  /* Desk surface — monitor, coffee, plant */
  .desk-surface {
    background: var(--bg-hover);
    padding: 16px 16px 12px;
    display: flex;
    align-items: flex-end;
    gap: 10px;
    position: relative;
    border-bottom: 3px solid var(--border-light);
    min-height: 90px;
  }

  /* Monitor */
  .desk-monitor {
    width: 80px;
    height: 56px;
    background: #1a1a2e;
    border-radius: 4px;
    border: 2px solid #555;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    color: #8fc;
    position: relative;
    flex-shrink: 0;
  }
  .desk-monitor::after {
    content: '';
    position: absolute;
    bottom: -8px;
    left: 50%;
    transform: translateX(-50%);
    width: 20px;
    height: 6px;
    background: #555;
    border-radius: 0 0 3px 3px;
  }
  .desk-monitor .monitor-channel {
    font-size: 9px;
    color: #7eb8da;
    text-overflow: ellipsis;
    overflow: hidden;
    white-space: nowrap;
    max-width: 70px;
  }
  .desk-monitor .typing-dots {
    display: none;
    font-size: 14px;
    letter-spacing: 2px;
    color: #8fc;
  }
  .desk-station.status-online .typing-dots {
    display: block;
    animation: typingBlink 1.4s steps(4, end) infinite;
  }
  @keyframes typingBlink {
    0%, 100% { opacity: 0.3; }
    50% { opacity: 1; }
  }

  /* Coffee cup (CSS art) */
  .desk-coffee {
    width: 18px;
    height: 20px;
    background: #8B6914;
    border-radius: 0 0 4px 4px;
    position: relative;
    flex-shrink: 0;
    margin-bottom: 4px;
  }
  .desk-coffee::before {
    content: '';
    position: absolute;
    top: -2px;
    left: -1px;
    right: -1px;
    height: 4px;
    background: #a07818;
    border-radius: 2px 2px 0 0;
  }
  .desk-coffee::after {
    content: '';
    position: absolute;
    right: -7px;
    top: 4px;
    width: 6px;
    height: 10px;
    border: 2px solid #8B6914;
    border-left: none;
    border-radius: 0 4px 4px 0;
  }

  /* Steam animation for online agents */
  .desk-steam {
    position: absolute;
    top: -12px;
    left: 50%;
    transform: translateX(-50%);
    display: none;
  }
  .desk-station.status-online .desk-steam {
    display: block;
  }
  .desk-steam span {
    display: inline-block;
    width: 2px;
    height: 8px;
    background: var(--text-muted);
    opacity: 0.4;
    border-radius: 1px;
    margin: 0 1px;
    animation: steam 2s ease-in-out infinite;
  }
  .desk-steam span:nth-child(2) { animation-delay: 0.3s; height: 10px; }
  .desk-steam span:nth-child(3) { animation-delay: 0.6s; }
  @keyframes steam {
    0%, 100% { transform: translateY(0) scaleY(1); opacity: 0; }
    50% { transform: translateY(-6px) scaleY(1.3); opacity: 0.5; }
  }

  /* Plant (CSS art) */
  .desk-plant {
    position: relative;
    width: 18px;
    height: 28px;
    flex-shrink: 0;
    margin-bottom: 4px;
  }
  .desk-plant::before {
    content: '';
    position: absolute;
    bottom: 0;
    left: 2px;
    width: 14px;
    height: 10px;
    background: #a0522d;
    border-radius: 0 0 3px 3px;
  }
  .desk-plant::after {
    content: '';
    position: absolute;
    bottom: 8px;
    left: 50%;
    transform: translateX(-50%);
    width: 0;
    height: 0;
    border-left: 10px solid transparent;
    border-right: 10px solid transparent;
    border-bottom: 18px solid #3a9a3a;
    border-radius: 2px;
  }

  /* Agent section below desk */
  .desk-agent {
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    flex: 1;
  }

  .desk-avatar {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: linear-gradient(135deg, var(--clementine), #ff6b00);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 22px;
    font-weight: 800;
    color: #fff;
    position: relative;
    margin-bottom: 8px;
    overflow: hidden;
    border: 3px solid transparent;
    flex-shrink: 0;
  }
  .desk-avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: 50%;
  }
  .desk-station.status-online .desk-avatar {
    border-color: var(--green);
    animation: avatarBob 4s ease-in-out infinite;
  }
  .desk-station.status-connecting .desk-avatar {
    border-color: var(--yellow);
  }
  .desk-station.status-error .desk-avatar {
    border-color: var(--red);
  }
  .desk-station.status-offline .desk-avatar {
    opacity: 0.6;
    filter: grayscale(30%);
  }
  @keyframes avatarBob {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-3px); }
  }

  /* Status dot */
  .desk-status {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    font-weight: 600;
    margin-bottom: 4px;
  }
  .desk-status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-muted);
  }
  .desk-station.status-online .desk-status-dot {
    background: var(--green);
    animation: statusPulse 2s ease-in-out infinite;
  }
  .desk-station.status-connecting .desk-status-dot {
    background: var(--yellow);
    animation: statusPulse 1s ease-in-out infinite;
  }
  .desk-station.status-error .desk-status-dot {
    background: var(--red);
  }
  @keyframes statusPulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(46,160,67,0.4); }
    50% { box-shadow: 0 0 0 5px rgba(46,160,67,0); }
  }

  .desk-name {
    font-weight: 700;
    font-size: 14px;
    color: var(--text-primary);
    margin-bottom: 2px;
  }
  .desk-role {
    font-size: 11px;
    color: var(--text-secondary);
    margin-bottom: 6px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .desk-badges {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    justify-content: center;
    margin-bottom: 8px;
  }
  .desk-actions {
    display: flex;
    gap: 6px;
    justify-content: center;
  }
  .desk-actions button {
    font-size: 11px;
    padding: 3px 10px;
  }

  /* Empty hire desk */
  .desk-station.desk-hire {
    border: 2px dashed var(--border-light);
    background: transparent;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 260px;
    transition: border-color 0.2s, background 0.2s;
  }
  .desk-station.desk-hire:hover {
    border-color: var(--green);
    background: rgba(46,160,67,0.04);
    transform: translateY(-3px);
  }
  .desk-hire-inner {
    text-align: center;
    color: var(--text-muted);
  }
  .desk-hire-inner .hire-icon {
    font-size: 36px;
    margin-bottom: 8px;
    opacity: 0.5;
  }
  .desk-hire-inner .hire-label {
    font-size: 13px;
    font-weight: 600;
  }

  /* ── Office Hero — Clementine ─────────── */
  .office-hero {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-image: linear-gradient(135deg, var(--clementine), #ff6b00, var(--yellow)) 1;
    border-radius: var(--radius);
    padding: 24px 28px;
    margin-bottom: 20px;
    display: flex;
    align-items: center;
    gap: 24px;
  }
  .office-hero-left {
    display: flex;
    align-items: center;
    gap: 16px;
    flex-shrink: 0;
  }
  .office-hero-avatar {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    background: linear-gradient(135deg, var(--clementine), #ff6b00);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 28px;
    font-weight: 800;
    color: #fff;
    flex-shrink: 0;
  }
  .office-hero-avatar.online {
    box-shadow: 0 0 0 3px var(--bg-card), 0 0 0 5px var(--green);
  }
  .office-hero-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .office-hero-name {
    font-size: 22px;
    font-weight: 700;
    color: var(--text-primary);
  }
  .office-hero-meta {
    font-size: 12px;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .office-hero-meta .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 600;
  }
  .office-hero-meta .status-pill.online {
    background: rgba(46,160,67,0.12);
    color: var(--green);
  }
  .office-hero-meta .status-pill.offline {
    background: rgba(125,133,144,0.12);
    color: var(--text-muted);
  }
  .office-hero-meta .status-pill .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
  }
  .office-hero-stats {
    display: flex;
    gap: 12px;
    margin-left: auto;
    flex-wrap: wrap;
  }
  .office-hero-stat {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 10px 16px;
    text-align: center;
    min-width: 90px;
  }
  .office-hero-stat .stat-val {
    font-size: 20px;
    font-weight: 700;
    color: var(--text-primary);
  }
  .office-hero-stat .stat-lbl {
    font-size: 10px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-top: 2px;
  }

  /* ── Desk Stats Strip ─────────────────── */
  .desk-stats-strip {
    display: flex;
    justify-content: center;
    gap: 12px;
    padding: 8px 12px;
    border-top: 1px solid var(--border);
    background: var(--bg-secondary);
    font-size: 11px;
    color: var(--text-secondary);
  }
  .desk-stats-strip .dss-item {
    display: flex;
    align-items: center;
    gap: 3px;
    white-space: nowrap;
  }
  .desk-stats-strip .dss-icon {
    font-size: 12px;
    opacity: 0.7;
  }
  .desk-stats-strip .dss-val {
    font-weight: 700;
    color: var(--text-primary);
  }

  /* ── Desk Cron Details ────────────────── */
  .desk-cron-details {
    border-top: 1px solid var(--border);
    font-size: 12px;
  }
  .desk-cron-details summary {
    padding: 6px 12px;
    cursor: pointer;
    color: var(--text-muted);
    font-size: 11px;
    font-weight: 600;
    user-select: none;
  }
  .desk-cron-details summary:hover {
    color: var(--text-primary);
  }
  .desk-cron-job {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 12px;
    border-top: 1px solid var(--border);
  }
  .desk-cron-job .cron-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .desk-cron-job .cron-dot.ok { background: var(--green); }
  .desk-cron-job .cron-dot.fail { background: var(--red); }
  .desk-cron-job .cron-dot.none { background: var(--text-muted); opacity: 0.4; }
  .desk-cron-job .cron-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-primary);
  }
  .desk-cron-job .cron-schedule {
    color: var(--text-muted);
    font-size: 10px;
    font-family: monospace;
  }
  .desk-cron-job .cron-last {
    color: var(--text-muted);
    font-size: 10px;
    white-space: nowrap;
  }

  .agent-info { flex: 1; }
  .agent-name {
    font-size: 26px;
    font-weight: 700;
    letter-spacing: -0.02em;
    margin-bottom: 4px;
    color: var(--clementine);
  }
  .hero-wordmark {
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
    font-size: 8px;
    line-height: 1.1;
    color: var(--clementine);
    white-space: pre;
    letter-spacing: 0;
    margin-bottom: 8px;
    opacity: 0.9;
  }
  .agent-activity {
    font-size: 14px;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .agent-activity.active { color: var(--green); }
  .agent-activity-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
    animation: pulse 2s infinite;
  }
  .agent-channels {
    display: flex;
    gap: 6px;
    margin-top: 10px;
  }
  .agent-channel-icon {
    width: 28px;
    height: 28px;
    border-radius: 6px;
    background: var(--bg-hover);
    border: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
  }
  .agent-controls {
    display: flex;
    gap: 8px;
    position: relative;
    z-index: 1;
  }
  .agent-meta {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 4px;
  }

  /* ── Summary Cards ──────────────────────── */
  .summary-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 20px;
    margin-bottom: 24px;
  }
  .summary-card {
    background: var(--bg-card);
    backdrop-filter: blur(8px);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px;
    display: flex;
    align-items: flex-start;
    gap: 14px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.06);
    position: relative;
    overflow: hidden;
  }
  .summary-card::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 3px;
  }
  .summary-card.sc-green::before { background: var(--green); }
  .summary-card.sc-blue::before { background: var(--accent); }
  .summary-card.sc-purple::before { background: var(--purple); }
  .summary-card.sc-yellow::before { background: var(--yellow); }
  .summary-card-icon {
    width: 40px;
    height: 40px;
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    flex-shrink: 0;
  }
  .sc-green .summary-card-icon { background: var(--green-bg); }
  .sc-blue .summary-card-icon { background: var(--accent-glow); }
  .sc-purple .summary-card-icon { background: rgba(124,58,237,0.12); }
  .sc-yellow .summary-card-icon { background: var(--yellow-bg); }
  .summary-card-value {
    font-size: 28px;
    font-weight: 700;
    line-height: 1;
    margin-bottom: 2px;
  }
  .summary-card-label {
    font-size: 12px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .summary-card-sub {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 4px;
  }

  /* ── Timeline ───────────────────────────── */
  .timeline {
    position: relative;
    padding-left: 24px;
  }
  .timeline::before {
    content: '';
    position: absolute;
    left: 7px;
    top: 4px;
    bottom: 4px;
    width: 2px;
    background: var(--border);
  }
  .timeline-item {
    position: relative;
    padding: 8px 0;
    font-size: 12px;
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }
  .timeline-item::before {
    content: '';
    position: absolute;
    left: -20px;
    top: 14px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-muted);
    border: 2px solid var(--bg-primary);
    z-index: 1;
  }
  .timeline-item.ok::before { background: var(--green); }
  .timeline-item.error::before { background: var(--red); }
  .timeline-msg { flex: 1; color: var(--text-primary); line-height: 1.4; }
  .timeline-time { flex-shrink: 0; color: var(--text-muted); font-size: 11px; }

  /* ── Task Cards ─────────────────────────── */
  .task-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 16px;
  }
  .task-card {
    background: var(--bg-card);
    backdrop-filter: blur(8px);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px;
    border-left: 3px solid var(--green);
    box-shadow: 0 2px 8px rgba(0,0,0,0.06);
    transition: border-color 0.2s, opacity 0.2s;
  }
  .task-card.disabled {
    opacity: 0.5;
    border-left-color: var(--text-muted);
  }
  .task-card.disabled:hover { opacity: 0.75; }
  .task-card.running {
    border-left-color: var(--accent);
    animation: taskPulse 2s ease-in-out infinite;
  }
  @keyframes taskPulse {
    0%, 100% { box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
    50% { box-shadow: 0 2px 16px rgba(77,158,255,0.2); }
  }
  .task-card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }
  .task-card-header strong {
    font-size: 14px;
    font-weight: 600;
  }
  .task-card-schedule {
    font-size: 12px;
    color: var(--text-secondary);
    margin-bottom: 8px;
  }
  .task-card-schedule code {
    font-size: 10px;
    color: var(--text-muted);
  }
  .task-card-prompt {
    font-size: 11px;
    color: var(--text-muted);
    margin-bottom: 12px;
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .task-card-status {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 14px;
    font-size: 12px;
  }
  .task-card-badges {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-bottom: 14px;
  }
  .task-card-actions {
    display: flex;
    gap: 8px;
    border-top: 1px solid var(--border);
    padding-top: 12px;
  }
  .task-card-add {
    background: transparent;
    border: 2px dashed var(--border-light);
    border-radius: var(--radius);
    padding: 40px 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    color: var(--text-muted);
    font-size: 14px;
    transition: border-color 0.2s, color 0.2s;
  }
  .task-card-add:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  /* ── Session Cards ──────────────────────── */
  .session-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 16px;
  }
  .session-card {
    background: var(--bg-card);
    backdrop-filter: blur(8px);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 18px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.06);
  }
  .session-card-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
  }
  .session-card-icon {
    font-size: 20px;
  }
  .session-card-name {
    font-size: 14px;
    font-weight: 600;
    flex: 1;
  }
  .session-card-exchanges {
    font-size: 28px;
    font-weight: 700;
    color: var(--accent);
  }
  .session-card-meta {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 6px;
  }
  .session-card-actions {
    margin-top: 10px;
    text-align: right;
  }

  /* ── Header activity text ───────────────── */
  .header-activity {
    font-size: 12px;
    color: var(--text-muted);
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .header-activity.active { color: var(--clementine); }

  /* logoBreath moved to header .logo.online above */

  /* ── Sidebar active gradient bar ────────── */
  .nav-item.active {
    position: relative;
  }
  .nav-item.active::before {
    content: '';
    position: absolute;
    left: -12px;
    top: 4px;
    bottom: 4px;
    width: 3px;
    border-radius: 2px;
    background: linear-gradient(180deg, var(--clementine), var(--clementine-dark));
  }

  /* ── Chat polish ────────────────────────── */
  @keyframes msgFadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .chat-bubble { animation: msgFadeIn 0.3s ease; }
  .chat-assistant-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }
  .chat-avatar-sm {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: linear-gradient(135deg, var(--clementine), #ff6b00);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 700;
    color: #fff;
    flex-shrink: 0;
    margin-top: 2px;
  }
  #page-chat.active {
    display: flex !important;
    flex-direction: column;
    height: calc(100vh - var(--header-h));
  }
  .quick-pill {
    border-radius: 20px !important;
    padding: 6px 16px !important;
  }
  .quick-pill:hover {
    background: var(--accent) !important;
    color: #fff !important;
    border-color: var(--accent) !important;
  }

  /* ── Mobile hamburger (hidden on desktop) ── */
  .menu-toggle {
    display: none;
    background: none; border: none; cursor: pointer;
    padding: 8px; margin-right: 4px; color: var(--text-primary);
    font-size: 20px; line-height: 1;
  }

  /* ── Mobile Responsive ─────────────────────── */
  @media (max-width: 768px) {
    :root {
      --sidebar-w: 260px;
    }

    .menu-toggle { display: block; }

    .layout {
      grid-template-columns: 1fr;
    }

    /* Sidebar: off-canvas drawer */
    .sidebar {
      position: fixed;
      top: var(--header-h);
      left: 0;
      bottom: 0;
      width: var(--sidebar-w);
      z-index: 50;
      transform: translateX(-100%);
      transition: transform 0.25s ease;
      box-shadow: none;
    }
    .sidebar.open {
      transform: translateX(0);
      box-shadow: 4px 0 24px rgba(0,0,0,0.3);
    }

    /* Overlay behind sidebar */
    .sidebar-overlay {
      display: none;
      position: fixed;
      inset: 0;
      top: var(--header-h);
      background: rgba(0,0,0,0.4);
      z-index: 49;
    }
    .sidebar-overlay.show { display: block; }

    /* Nav items: bigger touch targets */
    .nav-item {
      padding: 12px 14px;
      font-size: 14px;
    }

    /* Content: full width, less padding */
    .content {
      padding: 16px;
      grid-column: 1;
    }

    .page-title {
      font-size: 20px;
      margin-bottom: 16px;
    }

    /* Header compact */
    header { padding: 0 12px; }
    header h1 { font-size: 14px; }
    .header-subtitle { display: none; }
    .header-left { gap: 8px; }

    /* Cards: stack, smaller padding */
    .grid-2 {
      grid-template-columns: 1fr;
      gap: 12px;
    }

    .card-body { padding: 12px; }
    .card-header { padding: 10px 14px; font-size: 12px; }

    /* Form rows: stack on mobile */
    .form-row {
      grid-template-columns: 1fr;
      gap: 8px;
    }

    /* Modals: near full screen */
    .modal {
      width: 95vw;
      max-height: 85vh;
      border-radius: 8px;
    }
    .modal-header { padding: 14px 16px; }
    .modal-body { padding: 16px; }
    .modal-footer { padding: 12px 16px; }

    /* KV rows: stack on narrow screens */
    .kv-row {
      flex-wrap: wrap;
      gap: 2px;
    }

    /* Status pill: compact */
    .status-pill { padding: 4px 10px; font-size: 11px; }

    /* Hero section: stack */
    .agent-hero-top {
      flex-direction: column;
      align-items: flex-start;
      gap: 12px;
    }
    .agent-controls { width: 100%; }
    .agent-controls button { width: 100%; }

    /* Summary grid: 2-col on mobile */
    .summary-grid {
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-bottom: 16px;
    }

    /* Stat tiles: 2-col on mobile instead of auto-fit */
    .stat-grid {
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .stat-tile { padding: 12px; }
    .stat-value { font-size: 20px; }
    .stat-label { font-size: 10px; }

    /* Chat: full height + mobile-friendly input */
    #page-chat.active {
      height: calc(100vh - var(--header-h));
    }
    #chat-input {
      font-size: 16px; /* prevents iOS zoom on focus */
      min-height: 40px;
      padding: 10px;
    }
    #chat-send-btn {
      min-width: 60px;
      padding: 8px 12px;
    }

    /* Tables: horizontal scroll */
    .table-wrap {
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }

    /* Activity dots: smaller */
    .activity-dot { width: 8px; height: 8px; }

    /* Header meta row: hide on mobile */
    .header-meta { display: none; }

    /* Buttons: larger touch targets */
    .btn-sm { padding: 8px 14px; font-size: 12px; }
    button, .btn-primary, .btn-danger, .btn-ghost {
      min-height: 36px;
    }

    /* Settings: stack fields */
    #settings-content .card-body > div {
      flex-wrap: wrap;
    }

    /* Remote access: responsive */
    #ra-content code {
      font-size: 12px;
      word-break: break-all;
    }

    /* Wordmark: hide on mobile to save space */
    .block-wordmark { display: none; }
    .hero-wordmark { font-size: 10px !important; }

    /* Agent hero avatar: smaller */
    .agent-avatar { width: 56px; height: 56px; font-size: 22px; }
  }

  /* Small phones */
  @media (max-width: 400px) {
    .content { padding: 10px; }
    .page-title { font-size: 18px; }
    .stat-grid { grid-template-columns: 1fr; }
    .modal { width: 100vw; max-height: 90vh; border-radius: 0; }
  }
</style>
</head>
<body>
<div class="layout">
  <!-- Header -->
  <header>
    <div class="header-left">
      <button class="menu-toggle" id="menu-toggle" onclick="toggleSidebar()">&#9776;</button>
      <div class="logo" id="header-logo">${name.charAt(0).toUpperCase()}</div>
      <div>
        <h1>Command Center</h1>
        <div class="header-subtitle">Personal AI Assistant</div>
      </div>
      <span class="header-activity" id="header-activity"></span>
    </div>
    <div class="header-right">
      <div class="status-pill" id="header-status">
        <div class="pulse-dot"></div>
        <span>Loading...</span>
      </div>
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
      <div class="nav-item" data-page="daily-plan">
        <span class="nav-icon">&#128197;</span> Daily Plan
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
      <div class="nav-item" data-page="graph">
        <span class="nav-icon">&#128348;</span> Knowledge Graph
      </div>
    </div>
    <div class="nav-section">
      <div class="nav-section-title">Workspace</div>
      <div class="nav-item" data-page="projects">
        <span class="nav-icon">&#128193;</span> Projects
        <span class="nav-badge" id="nav-project-count">0</span>
      </div>
      <div class="nav-item" data-page="goals">
        <span class="nav-icon">&#127919;</span> Goals
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
      <div class="nav-item" data-page="self-improve">
        <span class="nav-icon">&#128300;</span> Self-Improve
        <span class="nav-badge" id="nav-si-pending">0</span>
      </div>
      <div class="nav-item" data-page="advisor">
        <span class="nav-icon">&#9889;</span> Exec Analytics
      </div>
    </div>
    <div class="nav-section">
      <div class="nav-section-title">Agents</div>
      <div class="nav-item" data-page="team">
        <span class="nav-icon">&#129302;</span> The Office
        <span class="nav-badge" id="nav-team-count">0</span>
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
      <div class="nav-item" data-page="settings">
        <span class="nav-icon">&#9881;</span> Settings
      </div>
    </div>
  </nav>
  <div class="sidebar-overlay" id="sidebar-overlay" onclick="toggleSidebar()"></div>

  <!-- Content -->
  <div class="content">

    <!-- ═══ Overview Page ═══ -->
    <div class="page active" id="page-overview">
      <div class="agent-hero" id="agent-hero">
        <div class="agent-hero-top">
          <div class="agent-avatar" id="agent-avatar">${name.charAt(0).toUpperCase()}</div>
          <div class="agent-info">
            <div class="hero-wordmark" id="hero-wordmark"></div>
            <div class="agent-activity" id="agent-activity">
              <span class="agent-activity-dot"></span>
              <span>Loading...</span>
            </div>
            <div class="agent-meta" id="agent-meta"></div>
            <div class="agent-channels" id="agent-channels"></div>
          </div>
          <div class="agent-controls" id="hero-controls"></div>
        </div>
      </div>
      <div class="summary-grid" id="summary-cards"></div>
      <div class="grid-2">
        <div class="card">
          <div class="card-header">Live Activity</div>
          <div class="card-body" id="panel-activity"><div class="empty-state">Loading...</div></div>
        </div>
        <div class="card">
          <div class="card-header">Quick Controls</div>
          <div class="card-body" id="panel-controls"><div class="empty-state">Loading...</div></div>
        </div>
      </div>
      <div class="card" id="mcp-status-widget" style="display:none;margin-top:16px"></div>
    </div>

    <!-- ═══ Projects Page ═══ -->
    <div class="page" id="page-projects">
      <div class="page-title">Projects</div>
      <p style="color:var(--text-muted);margin-bottom:16px">Link projects to give Clementine automatic access to their tools and MCP servers. When you mention a linked project's keywords in chat, Clementine switches into that project's context automatically.</p>
      <div class="card" style="margin-bottom:20px">
        <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
          <span>Workspace Directories</span>
          <button class="btn btn-sm btn-primary" onclick="promptAddWorkspaceDir()" style="font-size:11px">+ Add Path</button>
        </div>
        <div class="card-body" id="workspace-dirs-list" style="font-size:13px">
          <div class="empty-state">Loading...</div>
        </div>
      </div>
      <div id="panel-projects"><div class="empty-state">Loading...</div></div>
    </div>

    <!-- ═══ Cron / Scheduled Tasks Page ═══ -->
    <div class="page" id="page-cron">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
        <div class="page-title" style="margin-bottom:0">Scheduled Tasks</div>
      </div>
      <div id="panel-cron"><div class="empty-state">Loading...</div></div>
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
      <div id="panel-sessions"><div class="empty-state">Loading...</div></div>
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

    <!-- ═══ Self-Improvement Page ═══ -->
    <div class="page" id="page-self-improve">
      <div class="page-title">Self-Improvement</div>
      <div class="grid-2" id="si-status-cards"></div>
      <div class="card" style="margin-top:16px">
        <div class="card-header">Pending Proposals</div>
        <div class="card-body" id="si-pending-list"><div class="empty-state">No pending proposals</div></div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-header">Experiment History</div>
        <div class="card-body" id="si-history-list"><div class="empty-state">No experiments yet</div></div>
      </div>
    </div>

    <!-- ═══ Logs Page ═══ -->
    <div class="page" id="page-logs">
      <div class="page-title">Logs</div>
      <div class="log-toolbar">
        <input type="text" class="log-filter" id="log-filter" placeholder="Filter logs...">
        <select id="log-level-filter" style="background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius-sm);padding:6px 10px;font-size:12px;color:var(--text-primary);font-family:inherit;cursor:pointer" onchange="applyLogFilter()">
          <option value="">All Levels</option>
          <option value="error">Error+</option>
          <option value="warn">Warn+</option>
          <option value="info">Info+</option>
          <option value="debug">Debug+</option>
        </select>
        <button onclick="refreshLogs()">Refresh</button>
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-secondary);cursor:pointer">
          <input type="checkbox" id="log-autoscroll" checked> Auto-scroll
        </label>
      </div>
      <div class="log-viewer" id="panel-logs"><div class="empty-state">Loading...</div></div>
    </div>

    <!-- ═══ Chat Page ═══ -->
    <div class="page" id="page-chat">
      <div id="chat-messages" style="flex:1;overflow-y:auto;padding:16px">
        <div class="empty-state">
          <p style="margin-bottom:14px;color:var(--text-muted)">Send a message to start a conversation.</p>
          <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center">
            <button class="btn btn-sm quick-pill" onclick="quickChat('What\\'s on my schedule?')">What's on my schedule?</button>
            <button class="btn btn-sm quick-pill" onclick="quickChat('Check my email')">Check my email</button>
            <button class="btn btn-sm quick-pill" onclick="quickChat('Run morning briefing')">Run morning briefing</button>
            <button class="btn btn-sm quick-pill" onclick="quickChat('What did you do today?')">What did you do today?</button>
          </div>
        </div>
      </div>
      <div style="border-top:1px solid var(--border);padding:8px 14px 0;display:flex;align-items:center;gap:8px" id="chat-profile-bar">
        <span style="font-size:11px;color:var(--text-muted)">Profile:</span>
        <select id="chat-profile-select" onchange="switchProfile(this.value)" style="font-size:11px;padding:2px 6px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text-primary)">
          <option value="">Default</option>
        </select>
      </div>
      <div style="border-top:1px solid var(--border);padding:14px;display:flex;gap:10px">
        <input type="text" id="chat-input" placeholder="Type a message..." style="flex:1" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendChat()}">
        <button class="btn-primary" id="chat-send-btn" onclick="sendChat()">Send</button>
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

    <!-- ═══ Daily Plan Page ═══ -->
    <div class="page" id="page-daily-plan">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
        <div class="page-title" style="margin-bottom:0">Daily Plan</div>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="date" id="plan-date-picker" style="padding:6px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text-primary)">
          <button class="btn btn-sm" onclick="loadPlanForDate(document.getElementById('plan-date-picker').value)">Load</button>
        </div>
      </div>
      <div id="daily-plan-content"><div class="empty-state">Loading plan...</div></div>
      <div id="plan-diff-content" style="margin-top:16px"></div>
      <details style="margin-top:16px">
        <summary style="cursor:pointer;font-weight:600;color:var(--text-secondary);font-size:13px;padding:8px 0;user-select:none">Plan History</summary>
        <div id="plan-history-list" style="margin-top:8px"><div class="empty-state">Loading...</div></div>
      </details>
    </div>

    <!-- ═══ Execution Analytics Page ═══ -->
    <div class="page" id="page-advisor">
      <div class="page-title">Execution Analytics</div>
      <div id="advisor-analytics-content"><div class="empty-state">Loading analytics...</div></div>
    </div>

    <!-- ═══ Goals Progress Page ═══ -->
    <div class="page" id="page-goals">
      <div class="page-title">Goal Progress</div>
      <div id="goals-progress-content"><div class="empty-state">Loading goals...</div></div>
    </div>

    <!-- ═══ Team Page — The Office ═══ -->
    <div class="page" id="page-team">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <div class="page-title" style="margin-bottom:0">The Office</div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn" onclick="startHiringInterview()" style="background:var(--green);color:#000;font-weight:600">Hire a New Employee</button>
          <button class="btn btn-sm" onclick="showAgentCreateModal()" style="color:var(--text-muted)">Manual Setup</button>
        </div>
      </div>
      <div id="office-hero-section"></div>
      <div class="office-floor" id="team-agent-grid">
        <div class="empty-state">No agents configured</div>
      </div>
      <details style="margin-top:16px" id="team-comms-section">
        <summary style="cursor:pointer;font-weight:600;color:var(--text-secondary);font-size:13px;padding:8px 0;user-select:none">Communication Topology & Messages</summary>
        <div id="team-pending-requests" style="margin-bottom:12px"></div>
        <div class="grid-2" style="margin-top:8px">
          <div class="card">
            <div class="card-header">Communication Topology</div>
            <div class="card-body" id="team-topology"><div class="empty-state">No agents</div></div>
          </div>
          <div class="card">
            <div class="card-header">Inter-Agent Messages</div>
            <div class="card-body" id="team-messages-log"><div class="empty-state">No messages yet</div></div>
          </div>
        </div>
      </details>
    </div>

    <!-- Agent Create/Edit Modal -->
    <div id="agent-modal" class="modal-overlay">
      <div class="modal" style="width:520px">
        <div class="modal-header">
          <h3 id="agent-modal-title">Hire a New Team Member</h3>
          <button class="btn-ghost btn-sm" onclick="hideAgentModal()">&times;</button>
        </div>
        <div class="modal-body">
        <form id="agent-form" onsubmit="submitAgentForm(event)">
          <input type="hidden" id="agent-edit-slug" value="">
          <div style="margin-bottom:12px">
            <label style="display:block;color:var(--text-muted);font-size:12px;margin-bottom:4px">Name *</label>
            <input id="agent-name" required style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text-primary)" placeholder="Research Agent">
          </div>
          <div style="margin-bottom:12px">
            <label style="display:block;color:var(--text-muted);font-size:12px;margin-bottom:4px">Role Description *</label>
            <input id="agent-description" required style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text-primary)" placeholder="Deep-dive research and analysis">
          </div>
          <div style="margin-bottom:12px">
            <label style="display:block;color:var(--text-muted);font-size:12px;margin-bottom:4px">Profile Photo URL</label>
            <input id="agent-avatar-url" style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text-primary)" placeholder="https://example.com/avatar.png">
          </div>
          <div style="margin-bottom:12px">
            <label style="display:block;color:var(--text-muted);font-size:12px;margin-bottom:4px">Onboarding Brief</label>
            <textarea id="agent-personality" rows="4" style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);resize:vertical" placeholder="You are a Research Agent specializing in..."></textarea>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
            <div>
              <label style="display:block;color:var(--text-muted);font-size:12px;margin-bottom:4px">Channel</label>
              <div id="agent-channel-list" style="max-height:140px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:6px 8px;background:var(--bg-input)">
                <div style="color:var(--text-muted);font-size:12px">Loading channels...</div>
              </div>
              <label style="display:flex;align-items:center;gap:6px;margin-top:6px;color:var(--text-muted);font-size:12px;cursor:pointer">
                <input type="checkbox" id="agent-team-chat" style="accent-color:var(--blue)">
                Shared team chat <span style="opacity:0.6">(responds when @mentioned)</span>
              </label>
              <label style="display:flex;align-items:center;gap:6px;margin-top:4px;color:var(--text-muted);font-size:12px;cursor:pointer">
                <input type="checkbox" id="agent-respond-all" style="accent-color:var(--blue)">
                Respond to all messages <span style="opacity:0.6">(not just @mentions)</span>
              </label>
            </div>
            <div>
              <label style="display:block;color:var(--text-muted);font-size:12px;margin-bottom:4px">Model</label>
              <select id="agent-model" style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text-primary)">
                <option value="">Default (Sonnet)</option>
                <option value="haiku">Haiku</option>
                <option value="sonnet">Sonnet</option>
                <option value="opus">Opus</option>
              </select>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
            <div>
              <label style="display:block;color:var(--text-muted);font-size:12px;margin-bottom:4px">Project Binding</label>
              <select id="agent-project" style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text-primary)">
                <option value="">None</option>
              </select>
            </div>
            <div>
              <label style="display:block;color:var(--text-muted);font-size:12px;margin-bottom:4px">Security Clearance</label>
              <select id="agent-tier" style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text-primary)">
                <option value="2">Tier 2 (Read/Write)</option>
                <option value="1">Tier 1 (Read-only)</option>
              </select>
            </div>
          </div>
          <div style="margin-bottom:12px">
            <label style="display:block;color:var(--text-muted);font-size:12px;margin-bottom:4px">Team Connections (comma-separated slugs)</label>
            <input id="agent-canmessage" style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text-primary)" placeholder="analyst-agent, writer-agent">
          </div>
          <div style="margin-bottom:12px">
            <label style="display:block;color:var(--text-muted);font-size:12px;margin-bottom:4px">Equipment & Access <span style="opacity:0.6">(click category to toggle all)</span></label>
            <div id="agent-tools-panel" style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:8px;background:var(--bg-input)">
              <div style="color:var(--text-muted);font-size:12px">Loading tools...</div>
            </div>
          </div>
          <div style="margin-bottom:16px">
            <div style="font-weight:600;font-size:13px;color:var(--text-primary);margin-bottom:8px;border-top:1px solid var(--border);padding-top:12px">Platform Connections</div>

            <details id="discord-section" style="margin-bottom:10px">
              <summary style="cursor:pointer;color:var(--text-muted);font-size:12px;font-weight:600;margin-bottom:6px">Discord Bot <span id="discord-status-dot" style="display:none;width:8px;height:8px;border-radius:50%;display:inline-block;margin-left:4px"></span></summary>
              <div style="padding-left:8px">
                <label style="display:block;color:var(--text-muted);font-size:12px;margin-bottom:4px">Bot Token <span style="opacity:0.6">(gives agent its own Discord presence)</span></label>
                <input id="agent-discord-token" type="password" autocomplete="off" style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text-primary)" placeholder="Paste Discord bot token" oninput="onTokenInput(this.value)">
                <div style="margin-top:6px">
                  <label style="display:block;color:var(--text-muted);font-size:12px;margin-bottom:4px">Channel ID <span style="opacity:0.6">(right-click channel &gt; Copy Channel ID)</span></label>
                  <input id="agent-discord-channel-id" style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text-primary)" placeholder="e.g. 1478311884212932740">
                </div>
                <div id="agent-token-hint" style="display:none;font-size:11px;color:var(--green);margin-top:4px">(token configured &mdash; leave blank to keep, enter new to replace)</div>
                <div id="agent-token-setup" style="display:none;margin-top:8px;padding:10px;background:rgba(59,130,246,0.08);border:1px solid rgba(59,130,246,0.25);border-radius:8px;font-size:12px">
                  <div style="font-weight:600;color:var(--blue);margin-bottom:6px">Bot Setup Checklist</div>
                  <div style="margin-bottom:4px">1. <a id="token-invite-link" href="#" target="_blank" style="color:var(--blue)">Invite bot to your server</a></div>
                  <div style="margin-bottom:4px;color:var(--text-muted)">2. Enable <strong>Message Content Intent</strong> in <a href="https://discord.com/developers/applications" target="_blank" style="color:var(--blue)">Developer Portal</a> &gt; Bot &gt; Privileged Intents</div>
                  <div style="margin-bottom:4px;color:var(--text-muted)">3. Save this form, then restart the daemon</div>
                  <div style="margin-top:6px;font-size:11px;color:var(--text-muted)">App ID: <code id="token-app-id"></code></div>
                </div>
              </div>
            </details>

            <details id="slack-section" style="margin-bottom:10px">
              <summary style="cursor:pointer;color:var(--text-muted);font-size:12px;font-weight:600;margin-bottom:6px">Slack Bot <span id="slack-status-dot" style="display:none;width:8px;height:8px;border-radius:50%;display:inline-block;margin-left:4px"></span></summary>
              <div style="padding-left:8px">
                <label style="display:block;color:var(--text-muted);font-size:12px;margin-bottom:4px">Bot Token <span style="opacity:0.6">(xoxb-...)</span></label>
                <input id="agent-slack-bot-token" type="password" autocomplete="off" style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text-primary)" placeholder="xoxb-...">
                <div style="margin-top:6px">
                  <label style="display:block;color:var(--text-muted);font-size:12px;margin-bottom:4px">App Token <span style="opacity:0.6">(xapp-... for Socket Mode)</span></label>
                  <input id="agent-slack-app-token" type="password" autocomplete="off" style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text-primary)" placeholder="xapp-...">
                </div>
                <div style="margin-top:6px">
                  <label style="display:block;color:var(--text-muted);font-size:12px;margin-bottom:4px">Channel ID <span style="opacity:0.6">(optional override)</span></label>
                  <input id="agent-slack-channel-id" style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text-primary)" placeholder="e.g. C0123456789">
                </div>
                <div id="agent-slack-token-hint" style="display:none;font-size:11px;color:var(--green);margin-top:4px">(tokens configured &mdash; leave blank to keep, enter new to replace)</div>
                <div id="agent-slack-setup" style="display:none;margin-top:8px;padding:10px;background:rgba(59,130,246,0.08);border:1px solid rgba(59,130,246,0.25);border-radius:8px;font-size:12px">
                  <div style="font-weight:600;color:var(--blue);margin-bottom:6px">Slack Bot Setup</div>
                  <div style="margin-bottom:4px;color:var(--text-muted)">1. Create app at <a href="https://api.slack.com/apps" target="_blank" style="color:var(--blue)">api.slack.com</a></div>
                  <div style="margin-bottom:4px;color:var(--text-muted)">2. Enable <strong>Socket Mode</strong> &rarr; generate App Token (xapp-...)</div>
                  <div style="margin-bottom:4px;color:var(--text-muted)">3. Add bot scopes: <code>chat:write</code>, <code>channels:history</code>, <code>channels:read</code>, <code>im:history</code>, <code>im:read</code></div>
                  <div style="margin-bottom:4px;color:var(--text-muted)">4. Install to workspace &rarr; copy Bot Token (xoxb-...)</div>
                  <div style="color:var(--text-muted)">5. Invite bot to desired channel(s)</div>
                </div>
              </div>
            </details>
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button type="button" class="btn" onclick="hideAgentModal()">Cancel</button>
            <button type="submit" class="btn" style="background:var(--green);color:#000;font-weight:600" id="agent-submit-btn">Complete Hiring</button>
          </div>
        </form>
        </div>
      </div>
    </div>

    <!-- ═══ Knowledge Graph Page ═══ -->
    <div class="page" id="page-graph">
      <div class="page-title">Knowledge Graph</div>
      <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
        <input id="graph-search" placeholder="Search entities..." style="flex:1;min-width:200px;padding:8px 12px;border:1px solid var(--border);border-radius:6px;background:var(--bg-input);color:var(--text);font-size:14px">
        <select id="graph-filter-label" style="padding:8px 12px;border:1px solid var(--border);border-radius:6px;background:var(--bg-input);color:var(--text);font-size:14px">
          <option value="">All Types</option>
          <option value="Person">People</option>
          <option value="Project">Projects</option>
          <option value="Topic">Topics</option>
          <option value="Agent">Agents</option>
          <option value="Task">Tasks</option>
        </select>
        <button class="btn" onclick="refreshGraph()" style="font-size:14px">Refresh</button>
      </div>
      <div id="graph-canvas" style="height:500px;border:1px solid var(--border);border-radius:8px;background:#1e1e2e;position:relative"></div>
      <div id="graph-legend" style="display:flex;gap:16px;margin-top:8px;flex-wrap:wrap"></div>
      <div id="graph-detail-panel" style="margin-top:12px"></div>
    </div>

    <!-- ═══ Settings Page ═══ -->
    <div class="page" id="page-settings">
      <div class="page-title">Settings</div>

      <!-- Remote Access Section -->
      <div class="card" style="margin-bottom:20px">
        <div class="card-header" style="display:flex;align-items:center;gap:8px">
          <span>Remote Access</span>
          <span class="badge" id="ra-status-badge" style="font-size:10px">Loading...</span>
        </div>
        <div class="card-body" style="padding:16px" id="ra-content">
          <div class="empty-state">Loading...</div>
        </div>
      </div>

      <p style="color:var(--text-muted);margin-bottom:16px">Manage API keys and configuration. Changes are saved to <code>~/.clementine/.env</code> and take effect on daemon restart.</p>
      <div id="settings-content"><div class="empty-state">Loading settings...</div></div>
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
      <div class="form-group">
        <label class="form-label">Schedule</label>
        <div class="schedule-builder" id="schedule-builder">
          <div class="form-row">
            <select id="sched-freq" onchange="updateScheduleBuilder()">
              <option value="daily">Every day</option>
              <option value="weekdays">Weekdays (Mon–Fri)</option>
              <option value="weekly">Weekly</option>
              <option value="hourly">Every N hours</option>
              <option value="minutes">Every N minutes</option>
              <option value="custom">Custom cron expression</option>
            </select>
            <select id="sched-day" style="display:none" onchange="updateScheduleFromBuilder()">
              <option value="1">Monday</option>
              <option value="2">Tuesday</option>
              <option value="3">Wednesday</option>
              <option value="4">Thursday</option>
              <option value="5">Friday</option>
              <option value="6">Saturday</option>
              <option value="0">Sunday</option>
            </select>
          </div>
          <div class="form-row" id="sched-time-row">
            <select id="sched-hour" onchange="updateScheduleFromBuilder()">
              <option value="0">12:00 AM</option>
              <option value="1">1:00 AM</option>
              <option value="2">2:00 AM</option>
              <option value="3">3:00 AM</option>
              <option value="4">4:00 AM</option>
              <option value="5">5:00 AM</option>
              <option value="6">6:00 AM</option>
              <option value="7">7:00 AM</option>
              <option value="8">8:00 AM</option>
              <option value="9" selected>9:00 AM</option>
              <option value="10">10:00 AM</option>
              <option value="11">11:00 AM</option>
              <option value="12">12:00 PM</option>
              <option value="13">1:00 PM</option>
              <option value="14">2:00 PM</option>
              <option value="15">3:00 PM</option>
              <option value="16">4:00 PM</option>
              <option value="17">5:00 PM</option>
              <option value="18">6:00 PM</option>
              <option value="19">7:00 PM</option>
              <option value="20">8:00 PM</option>
              <option value="21">9:00 PM</option>
              <option value="22">10:00 PM</option>
              <option value="23">11:00 PM</option>
            </select>
            <select id="sched-minute" onchange="updateScheduleFromBuilder()">
              <option value="0">:00</option>
              <option value="15">:15</option>
              <option value="30">:30</option>
              <option value="45">:45</option>
            </select>
          </div>
          <div class="form-row" id="sched-interval-row" style="display:none">
            <select id="sched-interval" onchange="updateScheduleFromBuilder()">
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
              <option value="4">4</option>
              <option value="5">5</option>
              <option value="6">6</option>
              <option value="8">8</option>
              <option value="10">10</option>
              <option value="12">12</option>
              <option value="15">15</option>
              <option value="20">20</option>
              <option value="30">30</option>
            </select>
            <span style="color:var(--text-muted);align-self:center" id="sched-interval-label">hours</span>
          </div>
          <div id="sched-custom-row" style="display:none">
            <input type="text" id="cron-schedule" placeholder="0 9 * * *" oninput="updateScheduleHint()">
          </div>
          <div class="form-hint" id="cron-schedule-hint" style="margin-top:6px"></div>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Tier</label>
          <select id="cron-tier">
            <option value="1">Tier 1 — Read-only (vault, search, web)</option>
            <option value="2">Tier 2 — Read + Write (Bash, files, sub-agents)</option>
            <option value="3">Tier 3 — Full access (use with caution)</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Project Context <span style="color:var(--text-muted);font-weight:normal">(optional)</span></label>
        <select id="cron-workdir">
          <option value="">None — runs in default context</option>
        </select>
        <div class="form-hint">Run this task inside a project directory. The agent gets access to that project's tools, CLAUDE.md, and files.</div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Mode</label>
          <select id="cron-mode" onchange="toggleUnleashedOptions()">
            <option value="standard">Standard</option>
            <option value="unleashed">Unleashed (long-running)</option>
          </select>
          <div class="form-hint">Unleashed mode runs in phases with checkpointing for tasks that take hours.</div>
        </div>
        <div class="form-group" id="cron-maxhours-group" style="display:none">
          <label class="form-label">Max Hours</label>
          <select id="cron-maxhours">
            <option value="1">1 hour</option>
            <option value="2">2 hours</option>
            <option value="4">4 hours</option>
            <option value="6" selected>6 hours (default)</option>
            <option value="8">8 hours</option>
            <option value="12">12 hours</option>
            <option value="24">24 hours</option>
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Max Retries <span style="color:var(--text-muted);font-weight:normal">(optional)</span></label>
          <select id="cron-max-retries">
            <option value="">Auto (based on error history)</option>
            <option value="0">0 — No retries</option>
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
            <option value="5">5</option>
          </select>
          <div class="form-hint">Override automatic retry count for transient errors.</div>
        </div>
        <div class="form-group">
          <label class="form-label">After Job <span style="color:var(--text-muted);font-weight:normal">(chain)</span></label>
          <select id="cron-after">
            <option value="">None — runs on schedule</option>
          </select>
          <div class="form-hint">Trigger this job after another succeeds (ignores schedule).</div>
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

<div class="modal-overlay" id="project-modal">
  <div class="modal" style="width:480px">
    <div class="modal-header">
      <h3 id="project-modal-title">Link Project</h3>
      <button class="btn-ghost btn-sm" onclick="closeProjectModal()">&times;</button>
    </div>
    <div class="modal-body">
      <input type="hidden" id="project-path" />
      <div class="form-row">
        <label>Description</label>
        <input type="text" id="project-description" placeholder="e.g. Salesforce CRM integration tools" />
        <div class="form-hint">Describe what this project provides so Clementine can match it from chat context.</div>
      </div>
      <div class="form-row">
        <label>Keywords</label>
        <input type="text" id="project-keywords" placeholder="e.g. salesforce, CRM, leads, opportunities" />
        <div class="form-hint">Comma-separated keywords that trigger this project's context. Include tool names, services, and domain terms.</div>
      </div>
    </div>
    <div class="modal-footer">
      <button onclick="closeProjectModal()">Cancel</button>
      <button class="btn-primary" onclick="saveProjectLink()">Save</button>
    </div>
  </div>
</div>

<div class="modal-overlay" id="browse-dir-modal">
  <div class="modal" style="width:560px">
    <div class="modal-header">
      <h3>Browse Directories</h3>
      <button class="btn-ghost btn-sm" onclick="closeBrowseModal()">&times;</button>
    </div>
    <div class="modal-body" style="padding:0">
      <div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px">
        <button class="btn-sm" id="browse-up-btn" onclick="browseUp()" title="Go up">&uarr; Up</button>
        <code id="browse-current-path" style="font-size:12px;color:var(--text-secondary);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></code>
      </div>
      <div id="browse-entries" style="max-height:400px;overflow-y:auto;padding:4px 0"></div>
      <div style="padding:12px 16px;border-top:1px solid var(--border);display:flex;gap:8px">
        <input type="text" id="browse-manual-path" placeholder="Or paste a path..." style="flex:1;font-size:12px" />
        <button class="btn-sm btn-primary" onclick="addManualPath()">Add</button>
      </div>
    </div>
    <div class="modal-footer">
      <button onclick="closeBrowseModal()">Cancel</button>
      <button class="btn-primary" id="browse-add-current" onclick="addCurrentBrowseDir()">Add This Directory</button>
    </div>
  </div>
</div>

<div class="modal-overlay" id="trace-modal">
  <div class="modal" style="width:720px;max-height:85vh">
    <div class="modal-header">
      <h3 id="trace-modal-title">Execution Trace</h3>
      <button class="btn-ghost btn-sm" onclick="document.getElementById('trace-modal').classList.remove('show')">&times;</button>
    </div>
    <div class="modal-body" style="padding:0;overflow-y:auto;max-height:65vh">
      <div id="trace-content" style="font-size:12px"></div>
    </div>
    <div class="modal-footer">
      <div id="trace-run-selector" style="flex:1"></div>
      <button onclick="document.getElementById('trace-modal').classList.remove('show')">Close</button>
    </div>
  </div>
</div>

<div class="toast-container" id="toasts"></div>

<script>
// ── Block-letter wordmark (matches terminal banner) ──
(function() {
  var FONT = {
    C: [' ####','##   ','##   ','##   ',' ####'],
    L: ['##   ','##   ','##   ','##   ','#####'],
    E: ['#####','##   ','#### ','##   ','#####'],
    M: ['##   ##','### ###','## # ##','##   ##','##   ##'],
    N: ['##  ##','### ##','######','## ###','##  ##'],
    T: ['######','  ##  ','  ##  ','  ##  ','  ##  '],
    I: ['##','##','##','##','##']
  };
  var word = 'CLEMENTINE';
  var rows = [];
  for (var r = 0; r < 5; r++) {
    var line = '';
    for (var ci = 0; ci < word.length; ci++) {
      var ch = word[ci];
      if (line) line += ' ';
      var glyphs = FONT[ch];
      line += glyphs ? glyphs[r] : ch;
    }
    rows.push(line);
  }
  var el = document.getElementById('hero-wordmark');
  if (el) el.textContent = rows.join(String.fromCharCode(10));
})();

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

// ── Authenticated fetch helper ────────────
var _dashToken = document.querySelector('meta[name="dashboard-token"]')?.getAttribute('content') || '';
function apiFetch(url, opts) {
  opts = opts || {};
  opts.headers = Object.assign({ 'Authorization': 'Bearer ' + _dashToken }, opts.headers || {});
  return fetch(url, opts);
}

// ── Navigation ────────────────────────────
let currentPage = 'overview';
var prevAgentSlugs = null;
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
    if (page === 'projects') refreshProjects();
    if (page === 'logs') refreshLogs();
    if (page === 'memory') refreshMemory();
    if (page === 'metrics') refreshMetrics();
    if (page === 'chat') { loadProfiles(); document.getElementById('chat-input').focus(); }
    if (page === 'settings') { refreshSettings(); refreshRemoteAccess(); }
    if (page === 'self-improve') refreshSelfImprove();
    if (page === 'team') refreshTeam();
    if (page === 'graph') refreshGraph();
    if (page === 'daily-plan') refreshDailyPlan();
    if (page === 'advisor') refreshAdvisorAnalytics();
    if (page === 'goals') refreshGoalsProgress();
    // Close sidebar on mobile after nav
    closeSidebar();
  });
});

function toggleSidebar() {
  document.querySelector('.sidebar').classList.toggle('open');
  document.getElementById('sidebar-overlay').classList.toggle('show');
}
function closeSidebar() {
  document.querySelector('.sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('show');
}

// ── API helpers ───────────────────────────
async function apiPost(url) {
  try {
    const r = await apiFetch(url, { method: 'POST' });
    const d = await r.json();
    if (d.ok) toast(d.message, 'success');
    else toast(d.error || 'Error', 'error');
    setTimeout(refreshAll, 1000);
  } catch(e) { toast(String(e), 'error'); }
}
async function apiJson(method, url, body) {
  try {
    const r = await apiFetch(url, {
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
    const r = await apiFetch(url, { method: 'DELETE' });
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
    const r = await apiFetch('/api/status');
    const d = await r.json();
    lastStatusData = d;

    // Header status pill
    const pill = document.getElementById('header-status');
    pill.className = 'status-pill ' + (d.alive ? 'online' : 'offline');
    pill.innerHTML = '<div class="pulse-dot"></div><span>' + (d.alive ? 'Online' : 'Offline') + '</span>';

    // Header logo breathing
    const logo = document.getElementById('header-logo');
    if (d.alive) logo.classList.add('online');
    else logo.classList.remove('online');

    // Header activity text
    var actText = d.currentActivity || 'Idle';
    var headerAct = document.getElementById('header-activity');
    if (actText !== 'Idle') {
      headerAct.textContent = actText.toLowerCase() + '...';
      headerAct.className = 'header-activity active';
    } else {
      headerAct.textContent = 'idle';
      headerAct.className = 'header-activity';
    }

    // Agent hero avatar
    var avatar = document.getElementById('agent-avatar');
    if (d.alive) avatar.classList.add('online');
    else avatar.classList.remove('online');

    // Agent activity
    var agentAct = document.getElementById('agent-activity');
    if (actText !== 'Idle') {
      agentAct.className = 'agent-activity active';
      agentAct.innerHTML = '<span class="agent-activity-dot"></span><span>' + esc(actText) + '</span>';
    } else {
      agentAct.className = 'agent-activity';
      agentAct.innerHTML = '<span>' + (d.alive ? 'Online — standing by' : 'Offline') + '</span>';
    }

    // Agent meta (uptime)
    var meta = document.getElementById('agent-meta');
    var metaParts = [];
    if (d.uptime) metaParts.push('Uptime: ' + d.uptime);
    if (d.pid) metaParts.push('PID ' + d.pid);
    if (d.launchAgent) metaParts.push('LaunchAgent: ' + d.launchAgent);
    meta.textContent = metaParts.join(' · ');

    // Channel icons
    var channelIcons = { Discord: '&#128172;', Slack: '&#128488;', Telegram: '&#9992;', WhatsApp: '&#128241;', Webhook: '&#128279;' };
    var channelsEl = document.getElementById('agent-channels');
    if (d.channels && d.channels.length > 0) {
      channelsEl.innerHTML = d.channels.map(function(c) {
        return '<div class="agent-channel-icon" title="' + esc(c) + '">' + (channelIcons[c] || '&#128279;') + '</div>';
      }).join('');
    } else {
      channelsEl.innerHTML = '';
    }

    // Hero controls
    var controls = document.getElementById('hero-controls');
    if (d.alive) {
      controls.innerHTML = '<button class="btn-success btn-sm" onclick="apiPost(\\'/api/restart\\')">Restart</button>'
        + '<button class="btn-danger btn-sm" onclick="apiPost(\\'/api/stop\\')">Stop</button>';
    } else {
      controls.innerHTML = '<button class="btn-primary btn-sm" onclick="apiPost(\\'/api/launch\\')">Start Daemon</button>';
    }

    // Summary cards — fetch metrics when on overview
    if (currentPage === 'overview') {
      try {
        var mr = await apiFetch('/api/metrics');
        var md = await mr.json();
        var hours = md.timeSaved ? md.timeSaved.estimatedHours || 0 : 0;
        var mins = md.timeSaved ? md.timeSaved.estimatedMinutes || 0 : 0;
        var timeDisplay = hours >= 1 ? hours + 'h' : mins + 'm';
        var runsToday = d.runsToday || 0;
        var totalExchanges = md.sessions ? md.sessions.totalExchanges || 0 : 0;
        var nextTask = d.nextTaskName || '—';
        var nextTime = d.nextTaskTime || '';

        var cards = document.getElementById('summary-cards');
        cards.innerHTML = summaryCard('sc-green', '&#9200;', runsToday, 'Tasks Today', d.alive ? 'Agent running' : 'Agent offline')
          + summaryCard('sc-blue', '&#9201;', timeDisplay, 'Time Saved', hours >= 1 ? Math.round(mins) + ' total min' : '')
          + summaryCard('sc-purple', '&#128172;', totalExchanges, 'Messages', md.sessions ? md.sessions.activeSessions + ' sessions' : '')
          + summaryCard('sc-yellow', '&#9654;', nextTask, 'NEXT TASK', nextTime || 'No upcoming jobs');
      } catch(me) { /* metrics optional */ }

      // MCP Server Status widget
      try {
        var mcpRes = await apiFetch('/api/mcp-status');
        var mcpData = await mcpRes.json();
        var mcpEl = document.getElementById('mcp-status-widget');
        if (mcpData.servers && mcpData.servers.length > 0 && mcpEl) {
          var mcpHtml = '<div class="card-header">MCP Servers</div><div class="card-body">';
          for (var srv of mcpData.servers) {
            var dotColor = srv.status === 'connected' ? 'var(--green)' : srv.status === 'failed' ? 'var(--red)' : 'var(--yellow)';
            var statusLabel = srv.status || 'unknown';
            mcpHtml += '<div class="kv-row">'
              + '<span class="kv-key" style="display:flex;align-items:center;gap:6px">'
              + '<span style="width:8px;height:8px;border-radius:50%;background:' + dotColor + ';display:inline-block"></span>'
              + esc(srv.name) + '</span>'
              + '<span class="kv-val" style="font-size:11px">' + esc(statusLabel) + '</span></div>';
          }
          mcpHtml += '</div>';
          mcpEl.innerHTML = mcpHtml;
          mcpEl.style.display = 'block';
        } else if (mcpEl) {
          mcpEl.style.display = 'none';
        }
      } catch { /* MCP status optional */ }
    }

    // Quick controls panel
    var controlHtml = '';
    controlHtml += kv('Status', '<span class="badge ' + (d.alive ? 'badge-green' : 'badge-red') + '"><span class="badge-dot"></span>' + (d.alive ? 'Running' : 'Stopped') + '</span>');
    if (d.channels && d.channels.length > 0) {
      controlHtml += kv('Channels', d.channels.map(function(c) { return '<span class="badge badge-accent">' + esc(c) + '</span> '; }).join(''));
    }
    if (d.launchAgent) {
      var laBadge = d.launchAgent === 'loaded' ? 'badge-green' : d.launchAgent === 'installed' ? 'badge-yellow' : 'badge-gray';
      controlHtml += kv('LaunchAgent', '<span class="badge ' + laBadge + '">' + esc(d.launchAgent) + '</span>');
    }
    if (d.runsToday != null) controlHtml += kv('Runs Today', d.runsToday);
    controlHtml += '<div style="margin-top:12px;display:flex;gap:8px">';
    if (d.alive) {
      controlHtml += '<button class="btn-success btn-sm" onclick="apiPost(\\'/api/restart\\')">Restart</button>'
        + '<button class="btn-danger btn-sm" onclick="apiPost(\\'/api/stop\\')">Stop</button>';
    } else {
      controlHtml += '<button class="btn-primary btn-sm" onclick="apiPost(\\'/api/launch\\')">Start Daemon</button>';
    }
    controlHtml += '</div>';
    var controlsPanel = document.getElementById('panel-controls');
    if (controlsPanel) controlsPanel.innerHTML = controlHtml;
  } catch(e) { }
}

function summaryCard(cls, icon, value, label, sub) {
  return '<div class="summary-card ' + cls + '">'
    + '<div class="summary-card-icon">' + icon + '</div>'
    + '<div><div class="summary-card-value">' + esc(String(value)) + '</div>'
    + '<div class="summary-card-label">' + esc(label) + '</div>'
    + (sub ? '<div class="summary-card-sub">' + esc(sub) + '</div>' : '')
    + '</div></div>';
}

function kv(key, val) {
  return '<div class="kv-row"><span class="kv-key">' + esc(key) + '</span><span class="kv-val">' + val + '</span></div>';
}

// ── Sessions ──────────────────────────────
async function refreshSessions() {
  try {
    const r = await apiFetch('/api/sessions');
    const d = await r.json();
    const keys = Object.keys(d);
    document.getElementById('nav-session-count').textContent = keys.length;
    if (keys.length === 0) {
      document.getElementById('panel-sessions').innerHTML = '<div class="empty-state">No active sessions</div>';
      return;
    }
    let html = '<div class="session-grid" id="session-grid">';
    for (const key of keys) {
      var s = d[key];
      var friendly = friendlySession(key);
      var safeKey = esc(key).replace(/'/g, '');
      html += '<div class="session-card" style="cursor:pointer" onclick="viewSession(\\'' + encodeURIComponent(key) + '\\')">'
        + '<div class="session-card-header">'
        + '<span class="session-card-icon">' + friendly.icon + '</span>'
        + '<span class="session-card-name">' + esc(friendly.label) + '</span>'
        + '<span class="session-card-exchanges">' + (s.exchanges || 0) + '</span>'
        + '</div>'
        + '<div class="session-card-meta">Last active: ' + timeAgo(s.timestamp) + '</div>'
        + '<div class="session-card-meta" style="font-family:monospace;font-size:10px">' + esc(key) + '</div>'
        + '<div class="session-card-actions">'
        + '<button class="btn-danger btn-sm" onclick="event.stopPropagation();if(confirm(\\'Clear session ' + safeKey + '?\\'))apiPost(\\'/api/sessions/' + encodeURIComponent(key) + '/clear\\')">Clear</button>'
        + '</div></div>';
    }
    html += '</div>';
    document.getElementById('panel-sessions').innerHTML = html;
  } catch(e) { }
}

async function viewSession(encodedKey) {
  var key = decodeURIComponent(encodedKey);
  var panel = document.getElementById('panel-sessions');
  panel.innerHTML = '<div class="empty-state">Loading session...</div>';

  try {
    var [msgRes, usageRes] = await Promise.all([
      apiFetch('/api/sessions/' + encodedKey + '/messages'),
      apiFetch('/api/sessions/' + encodedKey + '/usage'),
    ]);
    var msgData = await msgRes.json();
    var usageData = await usageRes.json();
    var friendly = friendlySession(key);

    var html = '<div style="margin-bottom:16px">'
      + '<button class="btn-primary btn-sm" onclick="refreshSessions()" style="margin-bottom:12px">&larr; Back</button>'
      + '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">'
      + '<span style="font-size:24px">' + friendly.icon + '</span>'
      + '<span style="font-size:18px;font-weight:600">' + esc(friendly.label) + '</span>'
      + '</div>'
      + '<div style="font-family:monospace;font-size:11px;color:var(--text-muted);margin-bottom:8px">' + esc(key) + '</div>';

    // Usage stats
    if (usageData.totalTokens > 0) {
      html += '<div class="stat-grid" style="margin-bottom:12px">'
        + statTile(formatTokens(usageData.totalTokens), 'Total Tokens')
        + statTile(formatTokens(usageData.totalInput || 0), 'Input')
        + statTile(formatTokens(usageData.totalOutput || 0), 'Output')
        + statTile(usageData.numQueries || 0, 'Queries')
        + '</div>';
    }
    html += '</div>';

    // Messages
    var messages = msgData.messages || [];
    if (messages.length === 0) {
      html += '<div class="empty-state">No conversation history available</div>';
    } else {
      html += '<div style="max-height:600px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:12px">';
      for (var msg of messages) {
        if (msg.role === 'system') continue;
        var isUser = msg.role === 'user';
        var bubbleStyle = isUser
          ? 'background:var(--blue);color:#fff;margin-left:40px;border-radius:12px 12px 4px 12px'
          : 'background:var(--bg-secondary);border:1px solid var(--border);margin-right:40px;border-radius:12px 12px 12px 4px';
        var label = isUser ? 'You' : 'Assistant';
        var content = msg.content || '';
        if (content.length > 1000) content = content.slice(0, 1000) + '...';
        html += '<div style="margin-bottom:10px">'
          + '<div style="font-size:10px;color:var(--text-muted);margin-bottom:2px;' + (isUser ? 'text-align:right' : '') + '">'
          + esc(label) + (msg.createdAt ? ' &middot; ' + timeAgo(msg.createdAt) : '') + '</div>'
          + '<div style="padding:10px 14px;font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word;' + bubbleStyle + '">'
          + esc(content)
          + '</div></div>';
      }
      html += '</div>';
    }

    panel.innerHTML = html;
  } catch(e) {
    panel.innerHTML = '<div class="empty-state" style="color:var(--red)">Error loading session: ' + esc(String(e)) + '</div>'
      + '<button class="btn-primary btn-sm" onclick="refreshSessions()">&larr; Back</button>';
  }
}

// ── Cron Jobs ─────────────────────────────
let cronJobsData = [];
async function refreshCron() {
  try {
    const r = await apiFetch('/api/cron');
    const d = await r.json();
    cronJobsData = d.jobs || [];
    document.getElementById('nav-cron-count').textContent = cronJobsData.length;

    if (cronJobsData.length === 0) {
      document.getElementById('panel-cron').innerHTML = '<div class="task-grid"><div class="task-card-add" onclick="openCreateCronModal()">+ New Task</div></div>';
      return;
    }
    let html = '<div class="task-grid">';
    for (const job of cronJobsData) {
      var enabled = job.enabled !== false;
      var cardCls = 'task-card' + (enabled ? '' : ' disabled');
      // Check if running
      if (job.recentRuns && job.recentRuns.length > 0 && job.recentRuns[0].startedAt && !job.recentRuns[0].finishedAt) {
        cardCls += ' running';
      }
      var desc = describeCron(job.schedule || '');
      var schedHtml = desc
        ? esc(desc) + ' <code>' + esc(job.schedule) + '</code>'
        : '<code style="color:var(--accent)">' + esc(job.schedule) + '</code>';

      var lastRunHtml = '<span style="color:var(--text-muted)">Never run</span>';
      if (job.recentRuns && job.recentRuns.length > 0) {
        var lr = job.recentRuns[0];
        var statusIcon = lr.status === 'ok' ? '<span style="color:var(--green)">&#10003;</span>' : '<span style="color:var(--red)">&#10007;</span>';
        lastRunHtml = statusIcon + ' ' + esc(lr.status) + ' · ' + timeAgo(lr.finishedAt || lr.startedAt);
      }

      var badgesHtml = '';
      var projectName = job.work_dir ? job.work_dir.split('/').pop() : '';
      if (projectName) badgesHtml += '<span class="badge badge-blue">' + esc(projectName) + '</span>';
      if (job.mode === 'unleashed') badgesHtml += '<span class="badge badge-purple">unleashed</span>';
      if (job.after) badgesHtml += '<span class="badge badge-yellow" title="Triggered after ' + esc(job.after) + '">\\u2192 ' + esc(job.after) + '</span>';
      if (job.max_retries != null) badgesHtml += '<span class="badge badge-gray">' + job.max_retries + ' retries</span>';
      badgesHtml += '<span class="badge ' + (enabled ? 'badge-green' : 'badge-gray') + '">' + (enabled ? 'Enabled' : 'Disabled') + '</span>';

      var safeName = esc(job.name).replace(/'/g, '');

      html += '<div class="' + cardCls + '">'
        + '<div class="task-card-header">'
        + '<strong>' + esc(job.name) + '</strong>'
        + '<div class="toggle' + (enabled ? ' on' : '') + '" onclick="apiPost(\\'/api/cron/' + encodeURIComponent(job.name) + '/toggle\\')"></div>'
        + '</div>'
        + '<div class="task-card-schedule">' + schedHtml + '</div>'
        + '<div class="task-card-prompt">' + esc(job.prompt || '') + '</div>'
        + '<div class="task-card-status">' + lastRunHtml + '</div>'
        + '<div class="task-card-badges">' + badgesHtml + '</div>'
        + '<div class="task-card-actions">'
        + '<button class="btn-sm btn-success" onclick="apiPost(\\'/api/cron/run/' + encodeURIComponent(job.name) + '\\')">Run Now</button>'
        + '<button class="btn-sm" data-trace-job="' + esc(job.name) + '">Trace</button>'
        + '<button class="btn-sm" onclick="openEditCronModal(\\'' + safeName + '\\')">Edit</button>'
        + '<button class="btn-sm btn-danger" onclick="confirmDeleteCron(\\'' + safeName + '\\')">Del</button>'
        + '</div></div>';
    }
    // Add "new task" card
    html += '<div class="task-card-add" onclick="openCreateCronModal()">+ New Task</div>';
    html += '</div>';

    // Fetch unleashed task status and append if any exist
    try {
      var ur = await apiFetch('/api/unleashed');
      var ud = await ur.json();
      var tasks = ud.tasks || [];
      if (tasks.length > 0) {
        html += '<h3 style="margin:24px 0 12px;font-size:14px;color:var(--text-secondary)">Unleashed Tasks</h3>';
        html += '<table><tr><th>Task</th><th>Status</th><th>Phase</th><th>Duration</th><th style="width:80px"></th></tr>';
        for (var ti = 0; ti < tasks.length; ti++) {
          var t = tasks[ti];
          var statusColors = { running: 'badge-blue', completed: 'badge-green', cancelled: 'badge-gray', timeout: 'badge-yellow', error: 'badge-red', max_phases: 'badge-yellow' };
          var cls = statusColors[t.status] || 'badge-gray';
          var badge = '<span class="badge ' + cls + '">' + esc(t.status) + '</span>';
          var duration = '';
          if (t.startedAt) {
            var endTime = t.finishedAt ? new Date(t.finishedAt).getTime() : Date.now();
            var mins = Math.round((endTime - new Date(t.startedAt).getTime()) / 60000);
            duration = mins < 60 ? mins + 'm' : Math.floor(mins/60) + 'h ' + (mins%60) + 'm';
          }
          var cancelBtn = t.status === 'running'
            ? '<button class="btn-sm btn-danger" onclick="cancelUnleashed(\\'' + esc(t.jobName) + '\\')">Cancel</button> '
            : '';
          var detailBtn = '<button class="btn-sm" onclick="toggleUnleashedDetail(\\'' + esc(t.jobName) + '\\', this)">Details</button>';
          html += '<tr>'
            + '<td><strong>' + esc(t.jobName) + '</strong>'
            + (t.lastPhaseOutputPreview ? '<br><span style="font-size:11px;color:var(--text-muted)">' + esc(t.lastPhaseOutputPreview.slice(0,80)) + '...</span>' : '')
            + '</td>'
            + '<td>' + badge + '</td>'
            + '<td>' + (t.phase || 0) + '</td>'
            + '<td>' + esc(duration) + (t.maxHours ? ' / ' + t.maxHours + 'h max' : '') + '</td>'
            + '<td>' + cancelBtn + detailBtn + '</td>'
            + '</tr>'
            + '<tr class="unleashed-detail-row" id="unleashed-detail-' + esc(t.jobName).replace(/[^a-zA-Z0-9_-]/g,'_') + '" style="display:none"><td colspan="5"></td></tr>';
        }
        html += '</table>';
      }
    } catch(ue) { /* unleashed status is optional */ }

    document.getElementById('panel-cron').innerHTML = html;

    // Attach trace button handlers via delegation
    document.getElementById('panel-cron').onclick = function(ev) {
      var target = ev.target;
      while (target && target.id !== 'panel-cron') {
        if (target.dataset && target.dataset.traceJob) {
          openTraceViewer(target.dataset.traceJob);
          return;
        }
        target = target.parentElement;
      }
    };
  } catch(e) { }
}

var traceData = [];

async function openTraceViewer(jobName) {
  document.getElementById('trace-modal-title').textContent = 'Trace: ' + jobName;
  document.getElementById('trace-content').innerHTML = '<div style="padding:20px;color:var(--text-muted)">Loading...</div>';
  document.getElementById('trace-modal').classList.add('show');

  try {
    var r = await apiFetch('/api/cron/traces/' + encodeURIComponent(jobName));
    var d = await r.json();
    traceData = d.traces || [];

    if (traceData.length === 0) {
      document.getElementById('trace-content').innerHTML = '<div style="padding:20px;color:var(--text-muted)">No traces recorded yet. Traces are captured on the next run.</div>';
      document.getElementById('trace-run-selector').innerHTML = '';
      return;
    }

    // Build run selector
    var selHtml = '<select id="trace-run-select" onchange="renderTrace(this.value)" style="font-size:12px">';
    for (var i = 0; i < traceData.length; i++) {
      var t = traceData[i];
      var ts = t.startedAt ? new Date(t.startedAt).toLocaleString() : 'Unknown';
      selHtml += '<option value="' + i + '">' + ts + ' (' + t.steps + ' steps)</option>';
    }
    selHtml += '</select>';
    document.getElementById('trace-run-selector').innerHTML = selHtml;

    renderTrace(0);
  } catch(e) {
    document.getElementById('trace-content').innerHTML = '<div style="padding:20px;color:var(--red)">Failed to load traces: ' + esc(String(e)) + '</div>';
  }
}

function renderTrace(idx) {
  var trace = traceData[idx];
  if (!trace || !trace.trace) return;

  var html = '';
  for (var i = 0; i < trace.trace.length; i++) {
    var step = trace.trace[i];
    var time = step.timestamp ? new Date(step.timestamp).toLocaleTimeString() : '';
    var typeColor = step.type === 'tool_call' ? 'var(--accent)'
      : step.type === 'tool_result' ? '#22c55e'
      : 'var(--text-secondary)';
    var typeLabel = step.type === 'tool_call' ? 'TOOL'
      : step.type === 'tool_result' ? 'RESULT'
      : 'TEXT';
    var contentHtml = esc(step.content || '');
    // Wrap long content
    if (contentHtml.length > 200) {
      var preview = contentHtml.slice(0, 200);
      var rest = contentHtml.slice(200);
      contentHtml = preview + '<span class="trace-expand" data-expanded="false" onclick="var r=this.nextElementSibling;var show=r.style.display===\\'none\\';r.style.display=show?\\'inline\\':\\'none\\';this.textContent=show?\\'  [collapse]\\':  \\'... [expand]\\'"> ... [expand]</span><span style="display:none">' + rest + '</span>';
    }

    html += '<div style="padding:8px 16px;border-bottom:1px solid var(--border);font-family:monospace">'
      + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">'
      + '<span style="font-size:10px;font-weight:bold;color:' + typeColor + ';text-transform:uppercase;min-width:45px">' + typeLabel + '</span>'
      + '<span style="font-size:10px;color:var(--text-muted)">' + time + '</span>'
      + '</div>'
      + '<div style="white-space:pre-wrap;word-break:break-word;font-size:11px;line-height:1.5;color:var(--text-primary)">' + contentHtml + '</div>'
      + '</div>';
  }

  document.getElementById('trace-content').innerHTML = html || '<div style="padding:20px;color:var(--text-muted)">Empty trace</div>';
}

async function cancelUnleashed(jobName) {
  if (!confirm('Cancel unleashed task "' + jobName + '"?')) return;
  try {
    await apiPost('/api/unleashed/' + encodeURIComponent(jobName) + '/cancel');
    setTimeout(refreshCron, 1000);
  } catch(e) { toast('Failed to cancel: ' + e, 'error'); }
}

var unleashedDetailTimers = {};
async function toggleUnleashedDetail(jobName, btn) {
  var safeName = jobName.replace(/[^a-zA-Z0-9_-]/g, '_');
  var row = document.getElementById('unleashed-detail-' + safeName);
  if (!row) return;

  if (row.style.display !== 'none') {
    row.style.display = 'none';
    if (unleashedDetailTimers[safeName]) { clearInterval(unleashedDetailTimers[safeName]); delete unleashedDetailTimers[safeName]; }
    return;
  }
  row.style.display = '';
  await loadUnleashedDetail(jobName, safeName);

  // Auto-refresh every 10s for running tasks
  unleashedDetailTimers[safeName] = setInterval(function() { loadUnleashedDetail(jobName, safeName); }, 10000);
}

async function loadUnleashedDetail(jobName, safeName) {
  var row = document.getElementById('unleashed-detail-' + safeName);
  if (!row) return;
  var cell = row.querySelector('td');
  try {
    var r = await apiFetch('/api/unleashed/' + encodeURIComponent(jobName) + '/status');
    var d = await r.json();
    var elapsedStr = d.elapsed < 60 ? d.elapsed + 'm' : Math.floor(d.elapsed/60) + 'h ' + (d.elapsed%60) + 'm';
    var remainStr = d.remaining != null ? (d.remaining < 60 ? d.remaining + 'm' : Math.floor(d.remaining/60) + 'h ' + (d.remaining%60) + 'm') : '—';
    var html = '<div style="padding:12px;background:var(--bg-secondary);border-radius:6px;font-size:12px">'
      + '<div style="display:flex;gap:24px;margin-bottom:8px">'
      + '<div><strong>Elapsed:</strong> ' + esc(elapsedStr) + '</div>'
      + '<div><strong>Remaining:</strong> ' + esc(remainStr) + '</div>'
      + '<div><strong>Phase:</strong> ' + (d.phase || 0) + '</div>'
      + '<div><strong>Max Hours:</strong> ' + (d.maxHours || '—') + '</div>'
      + '</div>';
    if (d.progress && d.progress.length > 0) {
      html += '<div style="max-height:200px;overflow-y:auto;border-top:1px solid var(--border);padding-top:8px">';
      for (var i = d.progress.length - 1; i >= Math.max(0, d.progress.length - 10); i--) {
        var p = d.progress[i];
        html += '<div style="margin-bottom:4px"><span style="color:var(--text-muted)">' + (p.timestamp || '').slice(11,19) + '</span> '
          + '<strong>' + esc(p.event || '') + '</strong> '
          + (p.phase != null ? 'phase ' + p.phase + ' ' : '')
          + '</div>';
      }
      html += '</div>';
    }
    html += '</div>';
    cell.innerHTML = html;

    // Stop auto-refresh if task is done
    if (d.status && d.status !== 'running') {
      if (unleashedDetailTimers[safeName]) { clearInterval(unleashedDetailTimers[safeName]); delete unleashedDetailTimers[safeName]; }
    }
  } catch(e) {
    cell.innerHTML = '<div style="color:var(--red);padding:8px">Failed to load details</div>';
  }
}

// ── Projects ──────────────────────────────
let projectsData = [];

var workspaceDirsList = [];

async function refreshWorkspaceDirs() {
  try {
    const r = await apiFetch('/api/workspace-dirs');
    const d = await r.json();
    workspaceDirsList = d.dirs || [];
    const el = document.getElementById('workspace-dirs-list');
    if (!el) return;
    if (workspaceDirsList.length === 0) {
      el.innerHTML = '<span style="color:var(--text-muted)">No custom directories configured. Projects are scanned from ~/Desktop, ~/Documents, ~/Developer, etc. by default.</span>';
      el.onclick = null;
      return;
    }
    el.innerHTML = workspaceDirsList.map(function(dir, idx) {
      return '<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)">'
        + '<code style="font-size:12px">' + esc(dir) + '</code>'
        + '<button class="btn-sm btn-danger" style="font-size:10px;padding:2px 8px" data-remove-ws-idx="' + idx + '">Remove</button>'
        + '</div>';
    }).join('');
    el.onclick = function(ev) {
      var target = ev.target;
      while (target && target !== el) {
        if (target.dataset && target.dataset.removeWsIdx !== undefined) {
          removeWorkspaceDir(workspaceDirsList[parseInt(target.dataset.removeWsIdx)]);
          return;
        }
        target = target.parentElement;
      }
    };
  } catch(e) { }
}

var browseParent = null;
var browseCurrent = '';

function promptAddWorkspaceDir() {
  document.getElementById('browse-dir-modal').classList.add('show');
  document.getElementById('browse-manual-path').value = '';
  browseDir('');
}

function closeBrowseModal() {
  document.getElementById('browse-dir-modal').classList.remove('show');
}

var browseEntries = [];

function browseDir(dirPath) {
  var url = '/api/browse-dir' + (dirPath ? '?path=' + encodeURIComponent(dirPath) : '');
  apiFetch(url).then(function(r) { return r.json(); }).then(function(d) {
    if (d.error) { showToast(d.error, 'error'); return; }
    browseCurrent = d.current;
    browseParent = d.parent;
    browseEntries = d.entries;
    document.getElementById('browse-current-path').textContent = d.current;
    document.getElementById('browse-up-btn').disabled = !d.parent;
    var el = document.getElementById('browse-entries');
    if (d.entries.length === 0) {
      el.innerHTML = '<div style="padding:16px;color:var(--text-muted);text-align:center">No subdirectories</div>';
      return;
    }
    el.innerHTML = d.entries.map(function(e, idx) {
      var icon = e.isProject ? '\u{1F4C1}' : '\u{1F4C2}';
      var projectBadge = e.isProject ? ' <span class="badge badge-blue" style="font-size:10px">project</span>' : '';
      return '<div style="padding:8px 16px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border)">'
        + '<div data-browse-idx="' + idx + '" style="flex:1;display:flex;align-items:center;gap:8px">'
        + '<span>' + icon + '</span>'
        + '<span>' + esc(e.name) + projectBadge + '</span>'
        + '</div>'
        + '<button class="btn-sm btn-primary" style="font-size:10px;padding:2px 8px;flex-shrink:0" data-add-idx="' + idx + '">Add</button>'
        + '</div>';
    }).join('');

    // Attach click handlers via delegation
    el.onclick = function(ev) {
      var target = ev.target;
      // Walk up to find data attribute
      while (target && target !== el) {
        if (target.dataset && target.dataset.addIdx !== undefined) {
          ev.stopPropagation();
          addBrowsedDir(browseEntries[parseInt(target.dataset.addIdx)].path);
          return;
        }
        if (target.dataset && target.dataset.browseIdx !== undefined) {
          browseDir(browseEntries[parseInt(target.dataset.browseIdx)].path);
          return;
        }
        target = target.parentElement;
      }
    };
  });
}

function browseUp() {
  if (browseParent) browseDir(browseParent);
}

function addBrowsedDir(dir) {
  apiFetch('/api/workspace-dirs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir: dir })
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d.error) { showToast(d.error, 'error'); return; }
    showToast('Added: ' + dir);
    closeBrowseModal();
    refreshWorkspaceDirs();
    refreshProjects();
  });
}

function addCurrentBrowseDir() {
  if (browseCurrent) addBrowsedDir(browseCurrent);
}

function addManualPath() {
  var dir = document.getElementById('browse-manual-path').value.trim();
  if (!dir) return;
  addBrowsedDir(dir);
}

function removeWorkspaceDir(dir) {
  if (!confirm('Remove workspace directory?\\n' + dir)) return;

  apiFetch('/api/workspace-dirs', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir: dir })
  }).then(function(r) { return r.json(); }).then(function() {
    refreshWorkspaceDirs();
    refreshProjects();
  });
}

async function refreshProjects() {
  refreshWorkspaceDirs();
  try {
    const r = await apiFetch('/api/projects');
    const d = await r.json();
    projectsData = d.projects || [];
    const linkedCount = projectsData.filter(p => p.linked).length;
    document.getElementById('nav-project-count').textContent = linkedCount || projectsData.length;

    // Update the project selector in cron modal
    const sel = document.getElementById('cron-workdir');
    const currentVal = sel.value;
    sel.innerHTML = '<option value="">None — runs in default context</option>';
    for (const p of projectsData) {
      const opt = document.createElement('option');
      opt.value = p.path;
      opt.textContent = p.name + ' (' + p.type + ')';
      sel.appendChild(opt);
    }
    sel.value = currentVal;

    // Render projects page
    if (projectsData.length === 0) {
      document.getElementById('panel-projects').innerHTML = '<div class="empty-state" style="padding:40px">No projects found. Add workspace directories above or place projects in ~/Desktop, ~/Documents, ~/Developer, etc.</div>';
      return;
    }

    let html = '<div class="grid-2">';
    for (const p of projectsData) {
      const badges = [];
      badges.push('<span class="badge badge-blue">' + esc(p.type) + '</span>');
      if (p.hasClaude) badges.push('<span class="badge badge-green">CLAUDE.md</span>');
      if (p.hasMcp) badges.push('<span class="badge badge-yellow">MCP</span>');
      if (p.linked) badges.push('<span class="badge" style="background:#22c55e;color:#fff">Linked</span>');
      const mcpHtml = (p.mcpServers || []).length > 0
        ? '<div style="margin-top:8px"><span style="font-size:11px;color:var(--text-muted)">MCP Servers:</span> ' + p.mcpServers.map(s => '<code style="font-size:11px;background:var(--surface);padding:2px 6px;border-radius:3px;color:#eab308">' + esc(s) + '</code>').join(' ') + '</div>'
        : '';
      const scripts = (p.scripts || []).slice(0, 8);
      const scriptHtml = scripts.length > 0
        ? '<div style="margin-top:8px"><span style="font-size:11px;color:var(--text-muted)">Scripts:</span> ' + scripts.map(s => '<code style="font-size:11px;background:var(--surface);padding:1px 5px;border-radius:3px">' + esc(s) + '</code>').join(' ') + '</div>'
        : '';
      const kwHtml = (p.keywords || []).length > 0
        ? '<div style="margin-top:6px"><span style="font-size:11px;color:var(--text-muted)">Keywords:</span> ' + p.keywords.map(k => '<code style="font-size:11px;background:var(--surface);padding:1px 5px;border-radius:3px;color:var(--accent)">' + esc(k) + '</code>').join(' ') + '</div>'
        : '';
      const userDescHtml = p.userDescription
        ? '<div style="color:var(--accent);margin-bottom:4px;font-size:12px">' + esc(p.userDescription) + '</div>'
        : '';
      const idx = projectsData.indexOf(p);
      const linkBtn = p.linked
        ? '<button class="btn btn-sm" style="font-size:11px" onclick="openProjectEditorByIdx(' + idx + ')">Edit</button> <button class="btn btn-sm btn-danger" style="font-size:11px" onclick="unlinkProjectByIdx(' + idx + ')">Unlink</button>'
        : '<button class="btn btn-sm btn-primary" style="font-size:11px" onclick="openProjectEditorByIdx(' + idx + ')">Link</button>';
      html += '<div class="card" style="cursor:default">'
        + '<div class="card-header" style="display:flex;align-items:center;justify-content:space-between">'
        + '<strong>' + esc(p.name) + '</strong>'
        + '<div>' + badges.join(' ') + '</div>'
        + '</div>'
        + '<div class="card-body">'
        + userDescHtml
        + (p.description ? '<div style="color:var(--text-secondary);margin-bottom:6px">' + esc(p.description) + '</div>' : '')
        + '<div style="font-size:11px;color:var(--text-muted);font-family:monospace">' + esc(p.path) + '</div>'
        + mcpHtml
        + scriptHtml
        + kwHtml
        + '<div style="margin-top:10px;text-align:right">' + linkBtn + '</div>'
        + '</div></div>';
    }
    html += '</div>';
    document.getElementById('panel-projects').innerHTML = html;
  } catch(e) { }
}

function openProjectEditorByIdx(idx) {
  const p = projectsData[idx];
  if (!p) return;
  openProjectEditor(p.path);
}

function unlinkProjectByIdx(idx) {
  const p = projectsData[idx];
  if (!p) return;
  unlinkProject(p.path);
}

function openProjectEditor(projPath) {
  const p = projectsData.find(x => x.path === projPath);
  if (!p) return;
  document.getElementById('project-path').value = projPath;
  document.getElementById('project-description').value = p.userDescription || '';
  document.getElementById('project-keywords').value = (p.keywords || []).join(', ');
  document.getElementById('project-modal-title').textContent = (p.linked ? 'Edit' : 'Link') + ': ' + p.name;
  document.getElementById('project-modal').classList.add('show');
}

function closeProjectModal() {
  document.getElementById('project-modal').classList.remove('show');
}

async function saveProjectLink() {
  const projPath = document.getElementById('project-path').value;
  const description = document.getElementById('project-description').value.trim();
  const keywords = document.getElementById('project-keywords').value
    .split(',').map(k => k.trim()).filter(Boolean);
  try {
    const r = await apiFetch('/api/projects/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: projPath, description, keywords }),
    });
    if (!r.ok) throw new Error((await r.json()).error);
    toast('Project linked successfully');
    closeProjectModal();
    refreshProjects();
  } catch(e) { toast('Failed: ' + e, 'error'); }
}

async function unlinkProject(projPath) {
  try {
    const r = await apiFetch('/api/projects/unlink', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: projPath }),
    });
    if (!r.ok) throw new Error((await r.json()).error);
    toast('Project unlinked');
    refreshProjects();
  } catch(e) { toast('Failed: ' + e, 'error'); }
}

// ── Cron Modal ────────────────────────────
let editingCronJob = null;

function populateAfterJobDropdown(selectedAfter, excludeName) {
  var sel = document.getElementById('cron-after');
  sel.innerHTML = '<option value="">None — runs on schedule</option>';
  for (var j of cronJobsData) {
    if (excludeName && j.name === excludeName) continue;
    var opt = document.createElement('option');
    opt.value = j.name;
    opt.textContent = j.name;
    if (j.name === selectedAfter) opt.selected = true;
    sel.appendChild(opt);
  }
}

function toggleUnleashedOptions() {
  const mode = document.getElementById('cron-mode').value;
  document.getElementById('cron-maxhours-group').style.display = mode === 'unleashed' ? '' : 'none';
}

function openCreateCronModal() {
  editingCronJob = null;
  document.getElementById('cron-modal-title').textContent = 'New Scheduled Task';
  document.getElementById('cron-modal-save').textContent = 'Create Task';
  document.getElementById('cron-name').value = '';
  document.getElementById('cron-name').disabled = false;
  document.getElementById('sched-freq').value = 'daily';
  updateScheduleBuilder();
  document.getElementById('sched-hour').value = '9';
  document.getElementById('sched-minute').value = '0';
  updateScheduleFromBuilder();
  document.getElementById('cron-tier').value = '1';
  document.getElementById('cron-workdir').value = '';
  document.getElementById('cron-mode').value = 'standard';
  document.getElementById('cron-maxhours').value = '6';
  document.getElementById('cron-max-retries').value = '';
  populateAfterJobDropdown('');
  toggleUnleashedOptions();
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
  setScheduleFromCron(job.schedule || '0 9 * * *');
  document.getElementById('cron-tier').value = String(job.tier || 1);
  document.getElementById('cron-workdir').value = job.work_dir || '';
  document.getElementById('cron-mode').value = job.mode || 'standard';
  document.getElementById('cron-maxhours').value = String(job.max_hours || 6);
  document.getElementById('cron-max-retries').value = job.max_retries != null ? String(job.max_retries) : '';
  populateAfterJobDropdown(job.after || '', jobName);
  toggleUnleashedOptions();
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
  const work_dir = document.getElementById('cron-workdir').value;
  const mode = document.getElementById('cron-mode').value;
  const max_hours = mode === 'unleashed' ? parseInt(document.getElementById('cron-maxhours').value) : undefined;
  const prompt = document.getElementById('cron-prompt').value.trim();
  const max_retries_val = document.getElementById('cron-max-retries').value;
  const max_retries = max_retries_val !== '' ? parseInt(max_retries_val) : undefined;
  const after = document.getElementById('cron-after').value || undefined;

  if (!name || !schedule || !prompt) {
    toast('Please fill in all fields', 'error');
    return;
  }

  const body = { name, schedule, tier, prompt, enabled: true, work_dir: work_dir || undefined, mode, max_hours, max_retries, after };

  if (editingCronJob) {
    await apiJson('PUT', '/api/cron/' + encodeURIComponent(editingCronJob), body);
  } else {
    await apiJson('POST', '/api/cron', body);
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
// ── Schedule Builder ──────────────────────
const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function formatTime(h, m) {
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hr = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return hr + ':' + String(m).padStart(2, '0') + ' ' + ampm;
}

function updateScheduleBuilder() {
  const freq = document.getElementById('sched-freq').value;
  const dayEl = document.getElementById('sched-day');
  const timeRow = document.getElementById('sched-time-row');
  const intervalRow = document.getElementById('sched-interval-row');
  const customRow = document.getElementById('sched-custom-row');

  dayEl.style.display = freq === 'weekly' ? '' : 'none';
  timeRow.style.display = (freq === 'daily' || freq === 'weekdays' || freq === 'weekly') ? '' : 'none';
  intervalRow.style.display = (freq === 'hourly' || freq === 'minutes') ? '' : 'none';
  customRow.style.display = freq === 'custom' ? '' : 'none';

  document.getElementById('sched-interval-label').textContent = freq === 'minutes' ? 'minutes' : 'hours';

  // Reset interval options based on type
  const intSel = document.getElementById('sched-interval');
  if (freq === 'minutes') {
    intSel.innerHTML = [5,10,15,20,30,45].map(v => '<option value="'+v+'">'+v+'</option>').join('');
  } else if (freq === 'hourly') {
    intSel.innerHTML = [1,2,3,4,6,8,12].map(v => '<option value="'+v+'">'+v+'</option>').join('');
  }

  updateScheduleFromBuilder();
}

function updateScheduleFromBuilder() {
  const freq = document.getElementById('sched-freq').value;
  if (freq === 'custom') return;

  const hour = document.getElementById('sched-hour').value;
  const minute = document.getElementById('sched-minute').value;
  const day = document.getElementById('sched-day').value;
  const interval = document.getElementById('sched-interval').value;
  const hint = document.getElementById('cron-schedule-hint');

  let expr = '';
  let desc = '';

  switch (freq) {
    case 'daily':
      expr = minute + ' ' + hour + ' * * *';
      desc = 'Every day at ' + formatTime(+hour, +minute);
      break;
    case 'weekdays':
      expr = minute + ' ' + hour + ' * * 1-5';
      desc = 'Weekdays at ' + formatTime(+hour, +minute);
      break;
    case 'weekly':
      expr = minute + ' ' + hour + ' * * ' + day;
      desc = 'Every ' + dayNames[day] + ' at ' + formatTime(+hour, +minute);
      break;
    case 'hourly':
      expr = '0 */' + interval + ' * * *';
      desc = 'Every ' + interval + ' hour' + (+interval > 1 ? 's' : '');
      break;
    case 'minutes':
      expr = '*/' + interval + ' * * * *';
      desc = 'Every ' + interval + ' minutes';
      break;
  }

  document.getElementById('cron-schedule').value = expr;
  hint.textContent = desc;
  hint.style.color = 'var(--green)';
}

function updateScheduleHint() {
  const v = document.getElementById('cron-schedule').value.trim();
  const hint = document.getElementById('cron-schedule-hint');
  const desc = describeCron(v);
  if (desc) {
    hint.textContent = desc;
    hint.style.color = 'var(--green)';
  } else {
    hint.textContent = 'minute hour day month weekday';
    hint.style.color = '';
  }
}

const monthNames = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function describeCron(expr) {
  const parts = expr.split(/\\s+/);
  if (parts.length !== 5) return '';
  const [min, hour, dom, month, dow] = parts;

  // Every N minutes
  if (min.startsWith('*/')) return 'Every ' + min.slice(2) + ' minutes';
  // Every N hours
  if (hour.startsWith('*/')) return 'Every ' + hour.slice(2) + ' hours';

  const time = formatTime(+hour, +min);

  // Specific date: day + month set (e.g. "10 16 1 3 *" = Mar 1 at 4:10 PM)
  if (dom !== '*' && month !== '*') {
    const monthStr = monthNames[+month] || 'Month ' + month;
    return monthStr + ' ' + dom + ' at ' + time;
  }

  // Day of month only (e.g. "0 9 15 * *" = 15th of every month)
  if (dom !== '*' && month === '*' && dow === '*') {
    const suffix = +dom === 1 ? 'st' : +dom === 2 ? 'nd' : +dom === 3 ? 'rd' : 'th';
    return dom + suffix + ' of every month at ' + time;
  }

  // Weekdays
  if (dow === '1-5' && !hour.includes(',')) return 'Weekdays at ' + time;
  // Every day
  if (dow === '*' && dom === '*' && month === '*' && !hour.includes(',') && !hour.includes('/')) return 'Every day at ' + time;
  // Specific weekday
  if (/^[0-6]$/.test(dow) && !hour.includes(',')) return 'Every ' + dayNames[+dow] + ' at ' + time;
  // Multiple weekdays (e.g. "0 9 * * 1,3,5")
  if (/^[0-6](,[0-6])+$/.test(dow)) return dow.split(',').map(d => dayNames[+d]).join(', ') + ' at ' + time;
  // Multiple hours
  if (hour.includes(',')) return 'Daily at ' + hour.split(',').map(h => formatTime(+h, +min)).join(', ');

  return '';
}

function setScheduleFromCron(expr) {
  // Try to reverse-map a cron expression back to the builder
  const parts = expr.split(/\\s+/);
  if (parts.length !== 5) {
    document.getElementById('sched-freq').value = 'custom';
    updateScheduleBuilder();
    document.getElementById('cron-schedule').value = expr;
    updateScheduleHint();
    return;
  }
  const [min, hour, , , dow] = parts;

  if (min.startsWith('*/')) {
    document.getElementById('sched-freq').value = 'minutes';
    updateScheduleBuilder();
    document.getElementById('sched-interval').value = min.slice(2);
    updateScheduleFromBuilder();
  } else if (hour.startsWith('*/')) {
    document.getElementById('sched-freq').value = 'hourly';
    updateScheduleBuilder();
    document.getElementById('sched-interval').value = hour.slice(2);
    updateScheduleFromBuilder();
  } else if (dow === '1-5' && !hour.includes(',')) {
    document.getElementById('sched-freq').value = 'weekdays';
    updateScheduleBuilder();
    document.getElementById('sched-hour').value = hour;
    document.getElementById('sched-minute').value = min;
    updateScheduleFromBuilder();
  } else if (dow === '*' && !hour.includes(',') && !hour.includes('/')) {
    document.getElementById('sched-freq').value = 'daily';
    updateScheduleBuilder();
    document.getElementById('sched-hour').value = hour;
    document.getElementById('sched-minute').value = min;
    updateScheduleFromBuilder();
  } else if (/^[0-6]$/.test(dow) && !hour.includes(',')) {
    document.getElementById('sched-freq').value = 'weekly';
    updateScheduleBuilder();
    document.getElementById('sched-day').value = dow;
    document.getElementById('sched-hour').value = hour;
    document.getElementById('sched-minute').value = min;
    updateScheduleFromBuilder();
  } else {
    document.getElementById('sched-freq').value = 'custom';
    updateScheduleBuilder();
    document.getElementById('cron-schedule').value = expr;
    updateScheduleHint();
  }
}

// Initialize builder on load
updateScheduleFromBuilder();

// ── Timers ────────────────────────────────
async function refreshTimers() {
  try {
    const r = await apiFetch('/api/timers');
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

// ── Activity Feed ─────────────────────────
async function refreshActivity() {
  try {
    const r = await apiFetch('/api/activity');
    const d = await r.json();
    const activities = d.activities || [];
    if (activities.length === 0) {
      document.getElementById('panel-activity').innerHTML = '<div class="empty-state">No recent activity</div>';
      return;
    }
    let html = '<div class="timeline">';
    for (const a of activities) {
      var statusCls = a.status === 'ok' ? 'ok' : a.status === 'error' ? 'error' : '';
      html += '<div class="timeline-item ' + statusCls + '">'
        + '<span class="timeline-msg">' + esc(a.message) + '</span>'
        + '<span class="timeline-time">' + timeAgo(a.time) + '</span>'
        + '</div>';
    }
    html += '</div>';
    document.getElementById('panel-activity').innerHTML = html;
  } catch(e) { }
}

// ── Session helpers ───────────────────────
function friendlySession(key) {
  const parts = key.split(':');
  const channelIcons = { discord: '&#128172;', slack: '&#128172;', telegram: '&#9992;', whatsapp: '&#128241;', dashboard: '&#127760;', webhook: '&#128279;' };
  if (parts.length >= 2) {
    const channel = parts[0];
    const icon = channelIcons[channel] || '&#128488;';
    const rest = parts.slice(1).join(':');
    const label = channel.charAt(0).toUpperCase() + channel.slice(1) + (rest ? ' — ' + rest : '');
    return { icon, label };
  }
  return { icon: '&#128488;', label: key };
}

// ── Memory ────────────────────────────────
async function refreshMemory() {
  try {
    const r = await apiFetch('/api/memory');
    const d = await r.json();
    let statsHtml = '';
    if (d.dbStats && d.dbStats.chunks != null) {
      statsHtml = '<div class="stat-grid" style="margin-bottom:16px">'
        + '<div class="stat-tile"><div class="stat-value">' + esc(d.dbStats.chunks) + '</div><div class="stat-label">DB Chunks</div></div>'
        + '<div class="stat-tile"><div class="stat-value">' + esc(d.dbStats.files) + '</div><div class="stat-label">Indexed Files</div></div>'
        + '<div class="stat-tile"><div class="stat-value">' + esc(Math.round((d.dbStats.sizeBytes||0)/1024) + ' KB') + '</div><div class="stat-label">DB Size</div></div>';
      if (d.dbStats.consolidated != null) {
        statsHtml += '<div class="stat-tile"><div class="stat-value">' + esc(d.dbStats.unconsolidated) + '</div><div class="stat-label">Active Chunks</div></div>'
          + '<div class="stat-tile"><div class="stat-value">' + esc(d.dbStats.consolidated) + '</div><div class="stat-label">Consolidated</div></div>';
      }
      if (d.graphStats && d.graphStats.available) {
        statsHtml += '<div class="stat-tile"><div class="stat-value">' + esc(d.graphStats.nodes) + '</div><div class="stat-label">Graph Nodes</div></div>'
          + '<div class="stat-tile"><div class="stat-value">' + esc(d.graphStats.edges) + '</div><div class="stat-label">Graph Edges</div></div>';
      }
      statsHtml += '</div>';
    }
    document.getElementById('memory-stats').innerHTML = statsHtml;

    var memHtml = '';
    if (d.content) {
      memHtml += '<div class="memory-preview">' + esc(d.content) + '</div>';
    } else {
      memHtml += '<div class="empty-state">No MEMORY.md found</div>';
    }
    // Graph breakdown by entity type
    if (d.graphStats && d.graphStats.available && d.graphStats.labels && d.graphStats.labels.length > 0) {
      memHtml += '<div style="margin-top:16px;padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary)">';
      memHtml += '<div style="font-weight:600;margin-bottom:8px;font-size:13px;color:var(--text-primary)">Knowledge Graph Breakdown</div>';
      var colorMap = { Person: '#4a9eff', Project: '#34d399', Topic: '#a78bfa', Agent: '#fb923c', Task: '#fbbf24', Note: '#94a3b8' };
      for (var lb of d.graphStats.labels) {
        var barColor = colorMap[lb.label] || '#64748b';
        var maxCount = d.graphStats.labels[0].count || 1;
        var pct = Math.round((lb.count / maxCount) * 100);
        memHtml += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">'
          + '<span style="width:60px;font-size:12px;color:var(--text-muted)">' + esc(lb.label) + '</span>'
          + '<div style="flex:1;height:16px;background:var(--bg-input);border-radius:4px;overflow:hidden">'
          + '<div style="width:' + pct + '%;height:100%;background:' + barColor + ';border-radius:4px;transition:width 0.3s"></div></div>'
          + '<span style="font-size:12px;color:var(--text-muted);width:30px;text-align:right">' + lb.count + '</span></div>';
      }
      memHtml += '</div>';
    }
    document.getElementById('panel-memory').innerHTML = memHtml;
  } catch(e) { }
}

// ── Logs ──────────────────────────────────
let fullLogContent = '';
async function refreshLogs() {
  try {
    const r = await apiFetch('/api/logs?lines=500');
    const d = await r.json();
    fullLogContent = d.content || '';
    applyLogFilter();
  } catch(e) { }
}
async function refreshSettings() {
  var container = document.getElementById('settings-content');
  try {
    var r = await apiFetch('/api/settings');
    var d = await r.json();
    var groups = d.groups || [];
    var html = '';
    for (var g of groups) {
      var anySet = g.fields.some(function(f) { return f.isSet; });
      html += '<div class="card" style="margin-bottom:16px">'
        + '<div class="card-header" style="display:flex;align-items:center;gap:8px">'
        + '<span>' + esc(g.label) + '</span>'
        + (anySet ? '<span class="badge badge-green" style="font-size:10px">Configured</span>' : '<span class="badge badge-gray" style="font-size:10px">Not configured</span>')
        + '</div><div class="card-body" style="padding:16px">';
      for (var f of g.fields) {
        var inputId = 'setting-' + f.key;
        var inputHtml = '';
        if (f.type && f.type.startsWith('select:')) {
          var options = f.type.slice(7).split(',');
          inputHtml = '<select id="' + inputId + '" style="width:100%;padding:6px 10px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text-primary);font-size:13px">';
          inputHtml += '<option value=""' + (!f.value ? ' selected' : '') + '>—</option>';
          for (var opt of options) {
            inputHtml += '<option value="' + esc(opt) + '"' + (f.value === opt ? ' selected' : '') + '>' + esc(opt) + '</option>';
          }
          inputHtml += '</select>';
        } else {
          var displayValue = f.type === 'password' ? f.masked : f.value;
          inputHtml = '<input type="text" id="' + inputId + '" value="' + esc(displayValue) + '" placeholder="Not set"'
            + ' data-original="' + esc(displayValue) + '" data-key="' + f.key + '" data-is-password="' + (f.type === 'password' ? '1' : '0') + '"'
            + ' style="width:100%;padding:6px 10px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text-primary);font-size:13px"'
            + ' onfocus="settingFocus(this)" onblur="settingSave(this)">';
        }
        html += '<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">'
          + '<div style="min-width:160px"><label style="font-weight:600;font-size:12px;color:var(--text-secondary)">' + esc(f.label) + '</label>'
          + (f.hint ? '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">' + esc(f.hint) + '</div>' : '')
          + '</div>'
          + '<div style="flex:1">' + inputHtml + '</div>'
          + '<div style="min-width:70px;text-align:right">'
          + (f.isSet ? '<button class="btn-sm btn-danger" onclick="removeSetting(\\'' + f.key + '\\')">Remove</button>' : '')
          + '<span id="' + inputId + '-status" style="font-size:11px"></span>'
          + '</div></div>';
      }
      html += '</div></div>';
    }
    html += '<div class="card" style="margin-bottom:16px">'
      + '<div class="card-header">Add Custom Variable</div>'
      + '<div class="card-body" style="padding:16px">'
      + '<div style="display:flex;gap:8px;align-items:flex-end">'
      + '<div style="flex:1"><label style="font-size:12px;color:var(--text-secondary);font-weight:600">Key</label>'
      + '<input type="text" id="custom-env-key" placeholder="MY_API_KEY" style="width:100%;padding:6px 10px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text-primary);font-size:13px;text-transform:uppercase"></div>'
      + '<div style="flex:2"><label style="font-size:12px;color:var(--text-secondary);font-weight:600">Value</label>'
      + '<input type="text" id="custom-env-value" placeholder="Value" style="width:100%;padding:6px 10px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text-primary);font-size:13px"></div>'
      + '<button class="btn-sm btn-primary" onclick="addCustomEnv()">Add</button>'
      + '</div>'
      + '<div style="font-size:11px;color:var(--text-muted);margin-top:6px">Any env variable added here will be available to Clementine. Use UPPER_SNAKE_CASE for key names.</div>'
      + '</div></div>';

    html += '<div style="padding:12px;color:var(--text-muted);font-size:12px">'
      + '<strong>Note:</strong> Changes to API keys require a daemon restart to take effect. '
      + 'Use <code>clementine restart</code> after updating channel tokens.'
      + '</div>';
    container.innerHTML = html;

    // Attach change handlers for select elements
    for (var g2 of groups) {
      for (var f2 of g2.fields) {
        if (f2.type && f2.type.startsWith('select:')) {
          (function(key) {
            var sel = document.getElementById('setting-' + key);
            if (sel) sel.onchange = function() { saveSettingValue(key, sel.value); };
          })(f2.key);
        }
      }
    }
  } catch(e) {
    container.innerHTML = '<div class="empty-state" style="color:var(--red)">Failed to load settings: ' + esc(String(e)) + '</div>';
  }
}

function settingFocus(input) {
  // If this is a masked password field, clear it for editing
  if (input.dataset.isPassword === '1' && input.value === input.dataset.original && input.value.includes('*')) {
    input.value = '';
    input.type = 'text';
    input.placeholder = 'Enter new value...';
  }
}

async function settingSave(input) {
  var key = input.dataset.key;
  var value = input.value.trim();
  var original = input.dataset.original;
  // If unchanged or cleared back to masked value, skip
  if (value === original || (!value && input.dataset.isPassword === '1')) {
    if (!value && input.dataset.isPassword === '1') {
      input.value = original;
    }
    return;
  }
  if (!value) return;
  await saveSettingValue(key, value);
  input.dataset.original = input.dataset.isPassword === '1' ? value.slice(0, 4) + '****' + value.slice(-4) : value;
}

async function saveSettingValue(key, value) {
  var statusEl = document.getElementById('setting-' + key + '-status');
  try {
    await apiJson('PUT', '/api/settings/' + encodeURIComponent(key), { value: value });
    if (statusEl) { statusEl.textContent = 'Saved'; statusEl.style.color = 'var(--green)'; setTimeout(function(){ statusEl.textContent = ''; }, 2000); }
  } catch(e) {
    if (statusEl) { statusEl.textContent = 'Error'; statusEl.style.color = 'var(--red)'; }
  }
}

async function removeSetting(key) {
  if (!confirm('Remove ' + key + ' from .env?')) return;
  try {
    await apiDelete('/api/settings/' + encodeURIComponent(key));
    toast(key + ' removed', 'success');
    refreshSettings();
  } catch(e) { toast('Failed: ' + e, 'error'); }
}

async function addCustomEnv() {
  var keyInput = document.getElementById('custom-env-key');
  var valInput = document.getElementById('custom-env-value');
  var key = (keyInput.value || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  var value = (valInput.value || '').trim();
  if (!key || !value) { toast('Both key and value are required', 'error'); return; }
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) { toast('Invalid key format — use UPPER_SNAKE_CASE', 'error'); return; }
  try {
    await apiJson('PUT', '/api/settings/' + encodeURIComponent(key), { value: value });
    toast(key + ' added', 'success');
    keyInput.value = '';
    valInput.value = '';
    refreshSettings();
  } catch(e) { toast('Failed: ' + e, 'error'); }
}

function stripAnsi(s) {
  return s.replace(/\\x1b\\[[0-9;]*m/g, '').replace(/\\u001b\\[[0-9;]*m/g, '').replace(/\\x1B\\[[0-9;]*m/g, '');
}

const PINO_LEVELS = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
const LEVEL_PRIORITY = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };

function pinoLevelName(n) {
  return PINO_LEVELS[n] || 'info';
}

function renderLogLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return '';
  // Skip decorative/banner lines
  if (/^[=\\-~]{3,}/.test(trimmed) || /^\\s*$/.test(trimmed)) return '';
  try {
    const obj = JSON.parse(trimmed);
    const level = pinoLevelName(obj.level);
    const time = obj.time ? new Date(obj.time).toLocaleTimeString() : '';
    const source = obj.name || obj.module || obj.component || '';
    let msg = stripAnsi(obj.msg || '');
    // Include extra fields if msg is sparse
    if (!msg && obj.err) msg = obj.err.message || String(obj.err);
    return '<div class="log-entry">'
      + '<span class="log-time">' + esc(time) + '</span>'
      + '<span class="log-level log-level-' + level + '">' + level + '</span>'
      + (source ? '<span class="log-source">' + esc(source) + '</span>' : '')
      + '<span class="log-msg">' + esc(msg) + '</span>'
      + '</div>';
  } catch {
    // Not JSON — render as plain text with ANSI stripped
    const clean = stripAnsi(trimmed);
    if (!clean || /^[\\s=\\-~*]+$/.test(clean)) return '';
    return '<div class="log-entry"><span class="log-msg" style="color:var(--text-secondary)">' + esc(clean) + '</span></div>';
  }
}

function applyLogFilter() {
  const filter = (document.getElementById('log-filter').value || '').toLowerCase();
  const levelFilter = (document.getElementById('log-level-filter').value || '').toLowerCase();
  const levelMin = LEVEL_PRIORITY[levelFilter] ?? 0;
  const el = document.getElementById('panel-logs');
  if (!fullLogContent) {
    el.innerHTML = '<div class="empty-state">No log file found</div>';
    return;
  }
  const lines = fullLogContent.split('\\n');
  let rendered = '';
  for (const line of lines) {
    // Level filter — check before rendering
    if (levelFilter) {
      try {
        const obj = JSON.parse(line.trim());
        const lvl = pinoLevelName(obj.level);
        if ((LEVEL_PRIORITY[lvl] ?? 0) < levelMin) continue;
      } catch {
        // Non-JSON lines pass level filter
      }
    }
    // Text filter
    if (filter && !stripAnsi(line).toLowerCase().includes(filter)) continue;
    rendered += renderLogLine(line);
  }
  el.innerHTML = rendered || '<div class="empty-state">(no matching lines)</div>';
  if (document.getElementById('log-autoscroll').checked) {
    el.scrollTop = el.scrollHeight;
  }
}
document.getElementById('log-filter').addEventListener('input', applyLogFilter);

// ── Chat ──────────────────────────────────
function quickChat(msg) {
  document.getElementById('chat-input').value = msg;
  sendChat();
}

function renderMd(text) {
  let s = esc(text);
  var BT = String.fromCharCode(96);
  var BT3 = BT+BT+BT;
  // Code blocks
  s = s.replace(new RegExp(BT3+'([\\\\s\\\\S]*?)'+BT3, 'g'), '<pre style="background:var(--bg-input);padding:10px;border-radius:6px;overflow-x:auto;margin:6px 0;font-size:11px">$1</pre>');
  // Inline code
  s = s.replace(new RegExp(BT+'([^'+BT+']+)'+BT, 'g'), '<code style="background:var(--bg-input);padding:1px 5px;border-radius:3px;font-size:11px">$1</code>');
  // Bold
  s = s.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
  // Italic
  s = s.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
  // Unordered lists
  s = s.replace(/^- (.+)$/gm, '<li style="margin-left:16px">$1</li>');
  // Ordered lists
  s = s.replace(/^\\d+\\. (.+)$/gm, '<li style="margin-left:16px">$1</li>');
  // Line breaks
  s = s.replace(/\\n/g, '<br>');
  return s;
}

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
    const r = await apiFetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg }),
    });
    const d = await r.json();

    typing.remove();

    var asstRow = document.createElement('div');
    asstRow.className = 'chat-assistant-row';
    var chatAv = document.createElement('div');
    chatAv.className = 'chat-avatar-sm';
    chatAv.innerHTML = (lastStatusData.name || 'C').charAt(0).toUpperCase();
    asstRow.appendChild(chatAv);
    var asstBubble = document.createElement('div');
    asstBubble.className = 'chat-bubble assistant';
    asstBubble.innerHTML = renderMd(d.response || d.error || 'No response');
    var asstMeta = document.createElement('div');
    asstMeta.className = 'chat-meta';
    asstMeta.textContent = new Date().toLocaleTimeString();
    asstBubble.appendChild(asstMeta);
    asstRow.appendChild(asstBubble);
    container.appendChild(asstRow);
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

// ── Profile Switching ─────────────────────
async function loadProfiles() {
  try {
    var r = await apiFetch('/api/profiles');
    var d = await r.json();
    var sel = document.getElementById('chat-profile-select');
    sel.innerHTML = '<option value="">Default</option>';
    for (var p of (d.profiles || [])) {
      var opt = document.createElement('option');
      opt.value = p.slug;
      opt.textContent = p.name + (p.description ? ' — ' + p.description : '');
      if (p.slug === d.active) opt.selected = true;
      sel.appendChild(opt);
    }
  } catch(e) { /* profiles are optional */ }
}

async function switchProfile(slug) {
  try {
    await apiJson('POST', '/api/profiles/switch', { slug: slug || null });
    // Clear chat display since session was reset
    var container = document.getElementById('chat-messages');
    container.innerHTML = '<div class="empty-state"><p style="margin-bottom:14px;color:var(--text-muted)">Profile switched' + (slug ? ' to <strong>' + esc(slug) + '</strong>' : '') + '. Session cleared.</p></div>';
    toast(slug ? 'Switched to ' + slug : 'Profile cleared', 'success');
  } catch(e) { toast('Failed to switch profile: ' + e, 'error'); }
}

// ── Memory Search ─────────────────────────
async function runMemorySearch() {
  const input = document.getElementById('memory-search-input');
  const q = input.value.trim();
  if (!q) return;

  const container = document.getElementById('memory-search-results');
  container.innerHTML = '<div class="empty-state">Searching...</div>';

  try {
    const r = await apiFetch('/api/memory/search?q=' + encodeURIComponent(q));
    const d = await r.json();

    if (d.error) {
      const hint = d.dbExists === false
        ? 'The memory database has not been created yet. The assistant builds it after its first conversation.'
        : d.error;
      container.innerHTML = '<div class="empty-state" style="color:var(--yellow)">' + esc(hint) + '</div>';
      return;
    }

    if (!d.results || d.results.length === 0) {
      container.innerHTML = '<div class="empty-state">No results found for "' + esc(q) + '"</div>';
      return;
    }

    let html = '<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">' + d.results.length + ' result(s)</div>';

    // Show graph relationships if any
    if (d.graphContext && d.graphContext.length > 0) {
      html += '<div style="margin-bottom:16px;padding:10px 14px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary)">';
      html += '<div style="font-weight:600;font-size:12px;color:var(--text-muted);margin-bottom:6px">Related in Knowledge Graph</div>';
      for (var gc of d.graphContext) {
        html += '<div style="font-size:12px;color:var(--text-secondary);padding:2px 0">'
          + '<span style="color:var(--blue)">' + esc(gc.from) + '</span>'
          + ' <span style="color:var(--text-muted)">' + esc(gc.rel) + '</span> '
          + '<span style="color:var(--blue)">' + esc(gc.to) + '</span></div>';
      }
      html += '</div>';
    }

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
function formatTokens(n) {
  if (!n || n === 0) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

async function refreshMetrics() {
  try {
    const [r, ur] = await Promise.all([apiFetch('/api/metrics'), apiFetch('/api/metrics/usage')]);
    const d = await r.json();
    const u = await ur.json();
    const container = document.getElementById('metrics-content');

    let html = '';

    // Hero row: Time Saved + Total Tokens
    html += '<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:20px">';

    // Time saved hero
    const hours = d.timeSaved?.estimatedHours || 0;
    const mins = d.timeSaved?.estimatedMinutes || 0;
    const display = hours >= 1 ? hours + 'h' : mins + 'm';
    html += '<div class="metric-hero" style="flex:1;min-width:200px">'
      + '<div class="metric-hero-value">' + esc(display) + '</div>'
      + '<div class="metric-hero-label">Estimated Time Saved</div>'
      + '<div class="metric-hero-sub">'
      + esc((d.timeSaved?.breakdown?.cronMinutes || 0)) + ' min from tasks &middot; '
      + esc((d.timeSaved?.breakdown?.chatMinutes || 0)) + ' min from chat'
      + '</div></div>';

    // Total Tokens hero
    var totalTok = u.totalTokens || 0;
    html += '<div class="metric-hero" style="flex:1;min-width:200px">'
      + '<div class="metric-hero-value">' + formatTokens(totalTok) + '</div>'
      + '<div class="metric-hero-label">Total Tokens</div>'
      + '<div class="metric-hero-sub">'
      + formatTokens(u.totalInput || 0) + ' input &middot; '
      + formatTokens(u.totalOutput || 0) + ' output'
      + '</div></div>';

    html += '</div>';

    // Stat grid
    html += '<div class="stat-grid">';
    html += statTile(d.cron?.totalRuns || 0, 'Total Task Runs');
    html += statTile(d.cron?.successRate + '%', 'Success Rate');
    html += statTile(d.cron?.runsToday || 0, 'Runs Today');
    html += statTile(d.cron?.runsThisWeek || 0, 'Runs This Week');
    html += statTile(d.sessions?.totalExchanges || 0, 'Chat Exchanges');
    html += statTile(d.sessions?.activeSessions || 0, 'Active Sessions');
    // Cache efficiency
    var cacheEff = u.totalInput > 0 ? Math.round(((u.totalCacheRead || 0) / u.totalInput) * 100) : 0;
    html += statTile(cacheEff + '%', 'Cache Hit Rate', cacheEff >= 50 ? 'var(--green)' : cacheEff >= 20 ? 'var(--yellow)' : 'var(--text-muted)');
    html += '</div>';

    // Tokens by Model
    if (u.byModel && u.byModel.length > 0) {
      html += '<div class="card"><div class="card-header">Tokens by Model</div><div class="card-body">';
      var maxModelTok = Math.max(...u.byModel.map(function(m) { return (m.input || 0) + (m.output || 0); }));
      for (var m of u.byModel) {
        var mTotal = (m.input || 0) + (m.output || 0);
        var pct = maxModelTok > 0 ? Math.round((mTotal / maxModelTok) * 100) : 0;
        var shortName = m.model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
        html += '<div style="margin-bottom:8px">'
          + '<div class="kv-row"><span class="kv-key">' + esc(shortName) + '</span><span class="kv-val">' + formatTokens(mTotal) + '</span></div>'
          + '<div class="metric-bar-track"><div class="metric-bar-fill" style="width:' + pct + '%;background:var(--blue)"></div></div>'
          + '</div>';
      }
      html += '</div></div>';
    }

    // Tokens by Source
    if (u.bySource && u.bySource.length > 0) {
      html += '<div class="card"><div class="card-header">Tokens by Source</div><div class="card-body">';
      var maxSrcTok = Math.max(...u.bySource.map(function(s) { return (s.input || 0) + (s.output || 0); }));
      for (var s of u.bySource) {
        var sTotal = (s.input || 0) + (s.output || 0);
        var sPct = maxSrcTok > 0 ? Math.round((sTotal / maxSrcTok) * 100) : 0;
        var srcColors = { chat: 'var(--blue)', cron: 'var(--green)', heartbeat: 'var(--yellow)', unleashed: 'var(--purple)', plan_step: 'var(--clementine)', team_task: 'var(--red)' };
        var srcColor = srcColors[s.source] || 'var(--text-muted)';
        html += '<div style="margin-bottom:8px">'
          + '<div class="kv-row"><span class="kv-key">' + esc(s.source) + '</span><span class="kv-val">' + formatTokens(sTotal) + '</span></div>'
          + '<div class="metric-bar-track"><div class="metric-bar-fill" style="width:' + sPct + '%;background:' + srcColor + '"></div></div>'
          + '</div>';
      }
      html += '</div></div>';
    }

    // Usage by Day (last 7 days)
    if (u.byDay && u.byDay.length > 0) {
      html += '<div class="card"><div class="card-header">Usage by Day (Last 7 Days)</div><div class="card-body">';
      var maxDayTok = Math.max(...u.byDay.map(function(dd) { return (dd.input || 0) + (dd.output || 0); }));
      html += '<div style="display:flex;align-items:flex-end;gap:8px;height:120px">';
      for (var dd of u.byDay) {
        var dayTotal = (dd.input || 0) + (dd.output || 0);
        var barH = maxDayTok > 0 ? Math.max(4, Math.round((dayTotal / maxDayTok) * 100)) : 4;
        var dayLabel = dd.day ? dd.day.slice(5) : '';
        html += '<div style="flex:1;text-align:center;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%">'
          + '<div style="font-size:10px;color:var(--text-muted);margin-bottom:2px">' + formatTokens(dayTotal) + '</div>'
          + '<div style="width:100%;max-width:40px;height:' + barH + '%;background:var(--blue);border-radius:4px 4px 0 0;min-height:4px"></div>'
          + '<div style="font-size:10px;color:var(--text-muted);margin-top:4px">' + esc(dayLabel) + '</div>'
          + '</div>';
      }
      html += '</div></div></div>';
    }

    // Task reliability bar
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

function statTile(value, label, color) {
  const border = color ? ' style="border-left:3px solid ' + color + '"' : '';
  return '<div class="stat-tile"' + border + '><div class="stat-value">' + value + '</div><div class="stat-label">' + esc(label) + '</div></div>';
}

function formatMs(ms) {
  if (!ms || ms === 0) return '--';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  return (ms / 60000).toFixed(1) + 'm';
}

// ── Version check for auto-reload ─────────
let _loadedHash = null;
let _restartBannerShown = false;
async function checkVersion() {
  try {
    var r = await apiFetch('/api/version');
    var d = await r.json();
    if (!_loadedHash) { _loadedHash = d.started; return; }
    // If the server detects its own code is stale, show a persistent banner
    if (d.needsRestart && !_restartBannerShown) {
      _restartBannerShown = true;
      var banner = document.createElement('div');
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999;background:var(--clementine);color:#fff;text-align:center;padding:8px 16px;font-size:13px;font-weight:600;';
      banner.innerHTML = 'A new version is available. Restart the dashboard to apply updates: <code style="background:rgba(0,0,0,0.2);padding:2px 8px;border-radius:4px;margin-left:8px">clementine dashboard</code>';
      document.body.appendChild(banner);
    }
    // Also handle live-reload for same-process changes (e.g. git pull without rebuild)
    if (d.hash !== _loadedHash && !d.needsRestart) {
      toast('Dashboard updated — reloading...', 'success');
      setTimeout(function() { location.reload(); }, 2000);
    }
  } catch { /* ignore */ }
}

// ── Remote access management ──────────────────
async function refreshRemoteAccess() {
  var container = document.getElementById('ra-content');
  var badge = document.getElementById('ra-status-badge');
  try {
    var r = await apiFetch('/api/remote-access');
    var d = await r.json();

    if (!d.cloudflaredInstalled) {
      badge.textContent = 'Not Available';
      badge.className = 'badge badge-gray';
      badge.style.fontSize = '10px';
      container.innerHTML = '<div style="padding:8px 0">'
        + '<p style="color:var(--text-muted);margin-bottom:12px"><code>cloudflared</code> is required for remote access. It creates a secure tunnel to your dashboard — no account needed, no ports opened.</p>'
        + '<div class="card" style="background:var(--bg-primary);padding:12px;border-radius:6px">'
        + '<div style="font-size:12px;font-weight:600;margin-bottom:6px">Install cloudflared:</div>'
        + '<code style="font-size:13px;color:var(--accent)">' + esc(d.installInstructions) + '</code>'
        + '</div>'
        + '<p style="color:var(--text-muted);margin-top:12px;font-size:12px">After installing, refresh this page.</p>'
        + '</div>';
      return;
    }

    if (d.enabled && d.tunnelRunning) {
      badge.textContent = 'Active';
      badge.className = 'badge badge-green';
      badge.style.fontSize = '10px';
      container.innerHTML = '<div style="padding:8px 0">'
        + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">'
        + '<div class="pulse-dot" style="background:var(--green)"></div>'
        + '<span style="font-weight:600;color:var(--green)">Tunnel is running</span>'
        + '</div>'
        + '<div style="margin-bottom:16px">'
        + '<label style="font-size:12px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:4px">Public URL</label>'
        + '<div style="display:flex;gap:8px;align-items:center">'
        + '<code style="flex:1;padding:8px 12px;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;font-size:13px;word-break:break-all">' + esc(d.tunnelUrl) + '</code>'
        + '<button class="btn-sm btn-primary" onclick="copyToClipboard(\'' + esc(d.tunnelUrl) + '\')">Copy</button>'
        + '</div>'
        + '</div>'
        + '<div style="margin-bottom:16px">'
        + '<label style="font-size:12px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:4px">Access Token</label>'
        + '<div style="display:flex;gap:8px;align-items:center">'
        + '<code id="ra-token-display" style="flex:1;padding:8px 12px;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;font-size:13px;letter-spacing:1px">' + esc(d.authToken) + '</code>'
        + '<button class="btn-sm" onclick="copyToClipboard(\'' + esc(d.authToken) + '\')">Copy</button>'
        + '<button class="btn-sm" onclick="regenerateToken()">Regenerate</button>'
        + '</div>'
        + '<div style="font-size:11px;color:var(--text-muted);margin-top:4px">Share this token (securely) to grant remote access. Regenerating invalidates all sessions.</div>'
        + '</div>'
        + '<div style="display:flex;gap:8px;align-items:center;margin-bottom:16px">'
        + '<label style="font-size:12px;color:var(--text-secondary)">'
        + '<input type="checkbox" ' + (d.autoPost ? 'checked' : '') + ' onchange="toggleAutoPost()"> Auto-post URL to Discord when tunnel starts'
        + '</label>'
        + '</div>'
        + '<div style="display:flex;gap:8px">'
        + '<button class="btn-sm btn-danger" onclick="disableRemoteAccess()">Disable Remote Access</button>'
        + '</div>'
        + '</div>';
    } else if (d.enabled && !d.tunnelRunning) {
      badge.textContent = 'Enabled (Tunnel Down)';
      badge.className = 'badge badge-yellow';
      badge.style.fontSize = '10px';
      container.innerHTML = '<div style="padding:8px 0">'
        + '<p style="color:var(--yellow);margin-bottom:12px">Remote access is enabled but the tunnel is not running.</p>'
        + '<div style="display:flex;gap:8px">'
        + '<button class="btn-sm btn-primary" onclick="enableRemoteAccess()">Restart Tunnel</button>'
        + '<button class="btn-sm btn-danger" onclick="disableRemoteAccess()">Disable</button>'
        + '</div>'
        + '</div>';
    } else {
      badge.textContent = 'Disabled';
      badge.className = 'badge badge-gray';
      badge.style.fontSize = '10px';
      container.innerHTML = '<div style="padding:8px 0">'
        + '<p style="color:var(--text-muted);margin-bottom:12px">Access your dashboard from anywhere via a secure Cloudflare tunnel. No account required, no ports opened on your firewall.</p>'
        + '<p style="color:var(--text-muted);margin-bottom:12px;font-size:12px"><strong>Security:</strong> Three layers — unguessable tunnel URL, access token authentication, rate-limited login.</p>'
        + '<button class="btn-sm btn-primary" onclick="enableRemoteAccess()">Enable Remote Access</button>'
        + '</div>';
    }
  } catch (e) {
    container.innerHTML = '<div class="empty-state">Failed to load: ' + esc(String(e)) + '</div>';
  }
}

async function enableRemoteAccess() {
  var container = document.getElementById('ra-content');
  container.innerHTML = '<div class="empty-state">Starting tunnel...</div>';
  try {
    var r = await apiFetch('/api/remote-access/enable', { method: 'POST' });
    var d = await r.json();
    if (d.error) {
      container.innerHTML = '<div class="empty-state" style="color:var(--red)">' + esc(d.error) + '</div>';
      return;
    }
    refreshRemoteAccess();
  } catch (e) {
    container.innerHTML = '<div class="empty-state" style="color:var(--red)">Failed: ' + esc(String(e)) + '</div>';
  }
}

async function disableRemoteAccess() {
  try {
    await apiFetch('/api/remote-access/disable', { method: 'POST' });
    refreshRemoteAccess();
  } catch (e) {
    alert('Failed: ' + String(e));
  }
}

async function regenerateToken() {
  if (!confirm('Regenerate token? All existing sessions will be invalidated.')) return;
  try {
    var r = await apiFetch('/api/remote-access/regenerate-token', { method: 'POST' });
    var d = await r.json();
    if (d.authToken) {
      refreshRemoteAccess();
    }
  } catch (e) {
    alert('Failed: ' + String(e));
  }
}

async function toggleAutoPost() {
  try {
    await apiFetch('/api/remote-access/toggle-auto-post', { method: 'POST' });
  } catch (e) {
    alert('Failed: ' + String(e));
  }
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(function() {
    // Brief visual feedback could go here
  }).catch(function() {
    // Fallback: select text
    var ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  });
}

// ── Refresh orchestrator ──────────────────
function refreshAll() {
  refreshStatus();
  refreshSessions();
  refreshCron();
  refreshTimers();
  refreshActivity();
  refreshProjects(); // Always refresh — keeps nav badge + cron dropdown in sync
  if (currentPage === 'memory') refreshMemory();
  if (currentPage === 'logs') refreshLogs();
  if (currentPage === 'metrics') refreshMetrics();
  if (currentPage === 'self-improve') refreshSelfImprove();
  if (currentPage === 'team') refreshTeam();
  if (currentPage === 'daily-plan') refreshDailyPlan();
  if (currentPage === 'advisor') refreshAdvisorAnalytics();
  if (currentPage === 'goals') refreshGoalsProgress();
  checkVersion();
}

// ── Team ──────────────────────────────────

function fmtTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function fmtTimeAgo(iso) {
  if (!iso) return '';
  var diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
}

async function refreshTeam() {
  try {
    var officeRes = await apiFetch('/api/office');
    var data = await officeRes.json();
    var clem = data.clementine || {};
    var agents = data.agents || [];

    // Update nav badge
    var badge = document.getElementById('nav-team-count');
    if (badge) badge.textContent = agents.length || '0';

    // Auto-restart on roster change
    var currentSlugs = agents.map(function(a) { return a.slug; }).sort().join(',');
    if (prevAgentSlugs !== null && currentSlugs !== prevAgentSlugs) {
      toast('Team roster changed — restarting...', 'success');
      apiFetch('/api/restart', { method: 'POST' });
    }
    prevAgentSlugs = currentSlugs;

    // ── Clementine Hero Section ──
    var heroEl = document.getElementById('office-hero-section');
    if (heroEl) {
      var isOnline = clem.status === 'online';
      var statusPill = '<span class="status-pill ' + (isOnline ? 'online' : 'offline') + '">' +
        '<span class="dot"></span>' + (isOnline ? 'Online' : 'Offline') + '</span>';
      var uptimeStr = clem.uptime ? '<span>Uptime: ' + clem.uptime + '</span>' : '';
      var activityStr = clem.currentActivity && clem.currentActivity !== 'Idle'
        ? '<span>' + clem.currentActivity + '</span>' : '';
      var clemTokenTotal = (clem.tokens ? clem.tokens.input + clem.tokens.output : 0);

      heroEl.innerHTML =
        '<div class="office-hero">' +
          '<div class="office-hero-left">' +
            '<div class="office-hero-avatar' + (isOnline ? ' online' : '') + '">C</div>' +
            '<div class="office-hero-info">' +
              '<div class="office-hero-name">' + (clem.name || 'Clementine') + '</div>' +
              '<div class="office-hero-meta">' + statusPill + uptimeStr + activityStr + '</div>' +
            '</div>' +
          '</div>' +
          '<div class="office-hero-stats">' +
            '<div class="office-hero-stat"><div class="stat-val">' + (clem.sessions ? clem.sessions.active : 0) + '</div><div class="stat-lbl">Sessions</div></div>' +
            '<div class="office-hero-stat"><div class="stat-val">' + (clem.crons ? clem.crons.runsToday : 0) + '</div><div class="stat-lbl">Runs Today</div></div>' +
            '<div class="office-hero-stat"><div class="stat-val">' + fmtTokens(clemTokenTotal) + '</div><div class="stat-lbl">Tokens</div></div>' +
            '<div class="office-hero-stat"><div class="stat-val">' + (clem.crons ? clem.crons.total : 0) + '</div><div class="stat-lbl">Cron Jobs</div></div>' +
          '</div>' +
        '</div>';
    }

    // ── Agent desk cards ──
    var grid = document.getElementById('team-agent-grid');
    if (grid) {
      if (agents.length === 0) {
        grid.innerHTML = '<div class="desk-station desk-hire" onclick="startHiringInterview()">' +
          '<div class="desk-hire-inner"><div class="hire-icon">+</div><div class="hire-label">Hire a New Employee</div></div></div>';
      } else {
        var cards = agents.map(function(a) {
          var statusClass = 'status-offline';
          var statusLabel = 'Offline';
          var anyOnline = a.botStatus === 'online' || a.slackBotStatus === 'online';
          var anyConnecting = a.botStatus === 'connecting' || a.slackBotStatus === 'connecting';
          var anyError = a.botStatus === 'error' || a.slackBotStatus === 'error';
          if (anyOnline) { statusClass = 'status-online'; statusLabel = 'Online'; }
          else if (anyConnecting) { statusClass = 'status-connecting'; statusLabel = 'Connecting'; }
          else if (anyError) { statusClass = 'status-error'; statusLabel = 'Error'; }

          var channelDisplay = a.channelName
            ? (Array.isArray(a.channelName) ? a.channelName.map(function(c) { return '#' + c; }).join(', ') : '#' + a.channelName)
            : 'no desk';

          var avatarSrc = a.avatar || a.botAvatarUrl;
          var avatarContent = avatarSrc
            ? '<img src="' + avatarSrc + '" onerror="this.style.display=\\'none\\';this.parentElement.textContent=\\'' + a.name.charAt(0).toUpperCase() + '\\';">'
            : a.name.charAt(0).toUpperCase();

          // Badges
          var badges = [];
          if (a.model) badges.push('<span class="badge">' + a.model + '</span>');
          if (a.project) badges.push('<span class="badge" style="background:var(--purple);color:#fff">' + a.project + '</span>');
          if (a.allowedTools) badges.push('<span class="badge" style="background:var(--yellow);color:#000">' + a.allowedTools.length + ' tools</span>');
          if (a.hasDiscordToken) {
            var discordColor = a.botStatus === 'online' ? 'var(--green)' : 'var(--text-muted)';
            badges.push('<span class="badge" style="background:rgba(88,101,242,0.15);color:' + discordColor + ';font-size:10px">Discord</span>');
          }
          if (a.hasSlackToken) {
            var slackColor = a.slackBotStatus === 'online' ? 'var(--green)' : 'var(--text-muted)';
            badges.push('<span class="badge" style="background:rgba(74,21,75,0.15);color:' + slackColor + ';font-size:10px">Slack</span>');
          }

          // Actions
          var actions = a.agentDir
            ? '<button class="btn btn-sm" onclick="event.stopPropagation();editAgent(\\'' + a.slug + '\\')">Edit</button>' +
              '<button class="btn btn-sm" onclick="event.stopPropagation();deleteAgent(\\'' + a.slug + '\\')" style="color:var(--red)">Let Go</button>'
            : '';

          // Stats strip
          var aTokenTotal = a.tokens ? a.tokens.input + a.tokens.output : 0;
          var statsStrip =
            '<div class="desk-stats-strip">' +
              '<span class="dss-item"><span class="dss-icon">&#9654;</span> <span class="dss-val">' + (a.crons ? a.crons.runsToday : 0) + '</span> runs</span>' +
              '<span class="dss-item"><span class="dss-icon">&#128172;</span> <span class="dss-val">' + (a.sessions ? a.sessions.active : 0) + '</span> sess</span>' +
              '<span class="dss-item"><span class="dss-icon">&#9677;</span> <span class="dss-val">' + fmtTokens(aTokenTotal) + '</span> tok</span>' +
            '</div>';

          // Cron details (expandable)
          var cronDetails = '';
          if (a.crons && a.crons.jobs && a.crons.jobs.length > 0) {
            var cronRows = a.crons.jobs.map(function(j) {
              var dotClass = j.totalRuns === 0 ? 'none' : (j.successes === j.totalRuns ? 'ok' : 'fail');
              return '<div class="desk-cron-job">' +
                '<span class="cron-dot ' + dotClass + '"></span>' +
                '<span class="cron-name">' + j.name + '</span>' +
                (j.schedule ? '<span class="cron-schedule">' + j.schedule + '</span>' : '') +
                '<span class="cron-last">' + fmtTimeAgo(j.lastRun) + '</span>' +
              '</div>';
            }).join('');
            cronDetails = '<details class="desk-cron-details">' +
              '<summary>' + a.crons.jobs.length + ' cron job' + (a.crons.jobs.length === 1 ? '' : 's') + '</summary>' +
              cronRows +
            '</details>';
          }

          return '<div class="desk-station ' + statusClass + '">' +
            '<div class="desk-surface">' +
              '<div class="desk-monitor">' +
                '<div class="monitor-channel">' + channelDisplay + '</div>' +
                '<div class="typing-dots">&middot;&middot;&middot;</div>' +
              '</div>' +
              '<div style="position:relative">' +
                '<div class="desk-coffee"></div>' +
                '<div class="desk-steam"><span></span><span></span><span></span></div>' +
              '</div>' +
              '<div class="desk-plant"></div>' +
            '</div>' +
            '<div class="desk-agent">' +
              '<div class="desk-avatar">' + avatarContent + '</div>' +
              '<div class="desk-status"><span class="desk-status-dot"></span> ' + statusLabel + '</div>' +
              '<div class="desk-name">' + a.name + '</div>' +
              '<div class="desk-role">' + (a.description || 'No role assigned') + '</div>' +
              (badges.length ? '<div class="desk-badges">' + badges.join('') + '</div>' : '') +
              (actions ? '<div class="desk-actions">' + actions + '</div>' : '') +
            '</div>' +
            statsStrip +
            cronDetails +
          '</div>';
        });

        // Add the "Hire" empty desk at the end
        cards.push(
          '<div class="desk-station desk-hire" onclick="startHiringInterview()">' +
          '<div class="desk-hire-inner"><div class="hire-icon">+</div><div class="hire-label">Hire a New Employee</div></div></div>'
        );

        grid.innerHTML = cards.join('');
      }
    }

    // ── Pending Requests (shown above comms section) ──
    try {
      var allPending = [];
      for (var ai = 0; ai < agents.length; ai++) {
        try {
          var prRes = await apiFetch('/api/team/pending-requests?agent=' + agents[ai].slug);
          var prData = await prRes.json();
          if (prData.ok && prData.requests && prData.requests.length > 0) {
            for (var pi = 0; pi < prData.requests.length; pi++) {
              prData.requests[pi]._forAgent = agents[ai].name;
            }
            allPending = allPending.concat(prData.requests);
          }
        } catch(pe) {}
      }
      var prEl = document.getElementById('team-pending-requests');
      if (prEl) {
        if (allPending.length > 0) {
          prEl.innerHTML = '<div style="background:var(--bg-hover);border-radius:8px;padding:12px;margin-bottom:8px">' +
            '<strong style="color:var(--accent)">Pending Requests (' + allPending.length + ')</strong>' +
            allPending.map(function(r) {
              return '<div style="margin-top:8px;padding:8px;background:var(--bg);border-radius:6px">' +
                '<span style="color:var(--text-muted);font-size:12px">From ' + r.fromAgent + ' \\u2192 ' + r._forAgent + '</span>' +
                '<div style="margin-top:4px">' + (r.content || '').slice(0, 150) + '</div>' +
                '</div>';
            }).join('') +
            '</div>';
        } else {
          prEl.innerHTML = '';
        }
      }
    } catch(pe) {}

    // ── Communication (loaded on demand when details is open) ──
    var commsSection = document.getElementById('team-comms-section');
    if (commsSection && commsSection.open) {
      var [topoRes, messagesRes] = await Promise.all([
        apiFetch('/api/team/topology'),
        apiFetch('/api/team/messages?limit=50'),
      ]);
      var topology = await topoRes.json();
      var messages = await messagesRes.json();

      var topoEl = document.getElementById('team-topology');
      if (topoEl) {
        var nodes = topology.nodes || [];
        var edges = topology.edges || [];
        if (nodes.length === 0) {
          topoEl.innerHTML = '<div class="empty-state">No agents</div>';
        } else {
          var lines = nodes.map(function(n) {
            var outgoing = edges.filter(function(e) { return e.from === n.slug; }).map(function(e) { return e.to; });
            var incoming = edges.filter(function(e) { return e.to === n.slug; }).map(function(e) { return e.from; });
            return '<div style="padding:8px 12px;border-bottom:1px solid var(--border)">' +
              '<strong>' + n.name + '</strong>' +
              '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">' +
              (outgoing.length > 0 ? '&rarr; ' + outgoing.join(', ') : '<span style="opacity:0.5">no outgoing</span>') +
              ' &middot; ' +
              (incoming.length > 0 ? '&larr; ' + incoming.join(', ') : '<span style="opacity:0.5">no incoming</span>') +
              '</div></div>';
          });
          topoEl.innerHTML = lines.join('');
        }
      }

      var msgLog = document.getElementById('team-messages-log');
      if (msgLog) {
        if (messages.length === 0) {
          msgLog.innerHTML = '<div class="empty-state">No inter-agent messages yet</div>';
        } else {
          msgLog.innerHTML = messages.map(function(m) {
            var time = m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : '';
            return '<div style="padding:8px 12px;border-bottom:1px solid var(--border);font-size:13px">' +
              '<span style="color:var(--text-muted);font-size:11px">' + time + '</span> ' +
              '<strong>' + m.fromAgent + '</strong> &rarr; <strong>' + m.toAgent + '</strong>' +
              (m.depth > 0 ? ' <span style="font-size:10px;color:var(--text-muted)">(depth ' + m.depth + ')</span>' : '') +
              '<div style="margin-top:2px;color:var(--text-secondary)">' + (m.content || '').substring(0, 200) + '</div>' +
              '</div>';
          }).join('');
        }
      }
    }
  } catch(e) {
    console.error('Team refresh error:', e);
  }
}

// ── Agent CRUD Modal ──────────────────────

var HIRING_PROMPT = "I'd like to hire a new team member. Please interview me to set them up.\\n\\nWalk me through it — ask me about their name, what they'll do, what tools or capabilities they need, which project they should be attached to, and who they should be able to talk to on the team. Keep it conversational — 3 to 5 questions max, one at a time.\\n\\nOnce you have enough info, show me a summary of the proposed config, and when I approve, use create_agent to set them up. Include a detailed system prompt in the personality field that defines their expertise, communication style, and working context.";

function navigateTo(page) {
  var nav = document.querySelector('.nav-item[data-page="' + page + '"]');
  if (nav) nav.click();
}

function startHiringInterview() {
  navigateTo('chat');
  setTimeout(function() {
    document.getElementById('chat-input').value = HIRING_PROMPT;
    sendChat();
  }, 100);
}

async function loadAgentProjectOptions(selected) {
  try {
    var r = await apiFetch('/api/projects');
    var d = await r.json();
    var sel = document.getElementById('agent-project');
    sel.innerHTML = '<option value="">None</option>';
    (d.projects || []).forEach(function(p) {
      var opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.name + (p.description ? ' — ' + p.description : '');
      if (selected && p.name === selected) opt.selected = true;
      sel.appendChild(opt);
    });
  } catch(e) { /* projects are optional */ }
}

async function loadAgentToolOptions(selectedTools) {
  try {
    var r = await apiFetch('/api/available-tools');
    var d = await r.json();
    var panel = document.getElementById('agent-tools-panel');
    panel.innerHTML = '';
    var selected = selectedTools || [];
    for (var cat in d.categories) {
      var header = document.createElement('div');
      header.style.cssText = 'font-weight:600;font-size:11px;color:var(--text-muted);margin:8px 0 4px;cursor:pointer;user-select:none';
      header.textContent = '▸ ' + cat;
      header.dataset.category = cat;
      header.onclick = (function(catName, hdr) { return function() {
        var cbs = panel.querySelectorAll('.agent-tool-cb[data-cat="' + catName + '"]');
        var allChecked = Array.from(cbs).every(function(cb) { return cb.checked; });
        cbs.forEach(function(cb) { cb.checked = !allChecked; });
      }; })(cat, header);
      panel.appendChild(header);
      d.categories[cat].forEach(function(tool) {
        var label = document.createElement('label');
        label.style.cssText = 'display:block;font-size:12px;padding:2px 0 2px 8px;cursor:pointer';
        var checked = selected.indexOf(tool) >= 0 ? ' checked' : '';
        label.innerHTML = '<input type="checkbox" class="agent-tool-cb" data-cat="' + cat + '" value="' + tool + '"' + checked + ' style="margin-right:6px">' + tool;
        panel.appendChild(label);
      });
    }
  } catch(e) { /* fallback — panel stays empty */ }
}

function getSelectedTools() {
  return Array.from(document.querySelectorAll('.agent-tool-cb:checked')).map(function(cb) { return cb.value; });
}

var _discordChannelsCache = null;
async function loadDiscordChannels(selectedValues) {
  // Normalize to array
  if (!selectedValues) selectedValues = [];
  if (typeof selectedValues === 'string') selectedValues = selectedValues ? [selectedValues] : [];
  var container = document.getElementById('agent-channel-list');
  if (!_discordChannelsCache) {
    try {
      var r = await apiFetch('/api/discord/channels');
      var d = await r.json();
      if (d.ok) _discordChannelsCache = d.channels;
      else _discordChannelsCache = [];
    } catch { _discordChannelsCache = []; }
  }
  var html = '';
  var channels = _discordChannelsCache || [];
  if (channels.length === 0) {
    html = '<div style="color:var(--text-muted);font-size:12px">No channels found</div>';
  }
  channels.forEach(function(ch) {
    var checked = selectedValues.includes(ch.name) ? ' checked' : '';
    html += '<label style="display:flex;align-items:center;gap:6px;padding:3px 0;color:var(--text-primary);font-size:13px;cursor:pointer">'
      + '<input type="checkbox" class="agent-channel-cb" value="' + esc(ch.name) + '" data-channel-id="' + esc(ch.id) + '"' + checked + ' style="accent-color:var(--blue)">'
      + '#' + esc(ch.name) + (ch.guildName ? ' <span style="color:var(--text-muted);font-size:11px">(' + esc(ch.guildName) + ')</span>' : '')
      + '</label>';
  });
  // Add custom values that don't match any known channel
  selectedValues.forEach(function(v) {
    if (v && !channels.some(function(ch) { return ch.name === v; })) {
      html += '<label style="display:flex;align-items:center;gap:6px;padding:3px 0;color:var(--text-primary);font-size:13px;cursor:pointer">'
        + '<input type="checkbox" class="agent-channel-cb" value="' + esc(v) + '" checked style="accent-color:var(--blue)">'
        + '#' + esc(v) + ' <span style="color:var(--text-muted);font-size:11px">(custom)</span>'
        + '</label>';
    }
  });
  container.innerHTML = html;
}

function showAgentCreateModal() {
  document.getElementById('agent-modal').classList.add('show');
  document.getElementById('agent-modal-title').textContent = 'Hire a New Team Member';
  document.getElementById('agent-submit-btn').textContent = 'Complete Hiring';
  document.getElementById('agent-edit-slug').value = '';
  document.getElementById('agent-form').reset();
  document.getElementById('agent-token-hint').style.display = 'none';
  document.getElementById('agent-token-setup').style.display = 'none';
  document.getElementById('agent-slack-token-hint').style.display = 'none';
  document.getElementById('agent-slack-setup').style.display = 'none';
  loadAgentProjectOptions();
  loadAgentToolOptions();
  loadDiscordChannels([]);
}

async function editAgent(slug) {
  try {
    var r = await apiFetch('/api/agents');
    var agents = await r.json();
    var a = agents.find(function(x) { return x.slug === slug; });
    if (!a) { toast('Agent not found', 'error'); return; }

    document.getElementById('agent-modal').classList.add('show');
    document.getElementById('agent-modal-title').textContent = 'Update Team Member: ' + a.name;
    document.getElementById('agent-submit-btn').textContent = 'Save';
    document.getElementById('agent-edit-slug').value = slug;
    document.getElementById('agent-name').value = a.name || '';
    document.getElementById('agent-description').value = a.description || '';
    document.getElementById('agent-avatar-url').value = a.avatar || '';
    loadDiscordChannels(a.channelName || []);
    document.getElementById('agent-team-chat').checked = a.teamChat || false;
    document.getElementById('agent-respond-all').checked = a.respondToAll || false;
    document.getElementById('agent-model').value = a.model || '';
    document.getElementById('agent-tier').value = String(a.tier || 2);
    document.getElementById('agent-canmessage').value = (a.canMessage || []).join(', ');
    loadAgentProjectOptions(a.project || '');
    loadAgentToolOptions(a.allowedTools || []);
    document.getElementById('agent-discord-token').value = '';
    document.getElementById('agent-discord-channel-id').value = a.discordChannelId || '';
    document.getElementById('agent-token-setup').style.display = 'none';
    var tokenHint = document.getElementById('agent-token-hint');
    if (a.hasDiscordToken) {
      tokenHint.style.display = 'block';
      document.getElementById('discord-section').open = true;
      if (a.botInviteUrl) {
        var setupEl = document.getElementById('agent-token-setup');
        var appIdMatch = a.botInviteUrl.match(/client_id=(\d+)/);
        if (appIdMatch) {
          document.getElementById('token-invite-link').href = a.botInviteUrl;
          document.getElementById('token-app-id').textContent = appIdMatch[1];
          setupEl.style.display = 'block';
        }
      }
    } else {
      tokenHint.style.display = 'none';
    }

    // Slack fields
    document.getElementById('agent-slack-bot-token').value = '';
    document.getElementById('agent-slack-app-token').value = '';
    document.getElementById('agent-slack-channel-id').value = a.slackChannelId || '';
    document.getElementById('agent-slack-setup').style.display = 'none';
    var slackTokenHint = document.getElementById('agent-slack-token-hint');
    if (a.hasSlackToken) {
      slackTokenHint.style.display = 'block';
      document.getElementById('slack-section').open = true;
    } else {
      slackTokenHint.style.display = 'none';
    }
  } catch(e) { toast(String(e), 'error'); }
}

function hideAgentModal() {
  document.getElementById('agent-modal').classList.remove('show');
}

var tokenInputDebounce = null;
function onTokenInput(token) {
  clearTimeout(tokenInputDebounce);
  var setupEl = document.getElementById('agent-token-setup');
  if (!token || token.length < 20) {
    setupEl.style.display = 'none';
    return;
  }
  tokenInputDebounce = setTimeout(async function() {
    try {
      var r = await apiFetch('/api/bot/derive-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token }),
      });
      var d = await r.json();
      if (d.ok) {
        document.getElementById('token-invite-link').href = d.inviteUrl;
        document.getElementById('token-app-id').textContent = d.appId;
        setupEl.style.display = 'block';
      } else {
        setupEl.style.display = 'none';
        toast(d.error || 'Invalid token format', 'error');
      }
    } catch(e) {
      setupEl.style.display = 'none';
    }
  }, 400);
}

async function submitAgentForm(e) {
  e.preventDefault();
  var editSlug = document.getElementById('agent-edit-slug').value;
  var isEdit = Boolean(editSlug);

  var selectedChannels = Array.from(document.querySelectorAll('.agent-channel-cb:checked')).map(function(cb) { return cb.value; });
  var channelName = selectedChannels.length === 0 ? undefined : selectedChannels.length === 1 ? selectedChannels[0] : selectedChannels;
  var teamChat = document.getElementById('agent-team-chat').checked;
  var respondToAll = document.getElementById('agent-respond-all').checked;
  var payload = {
    name: document.getElementById('agent-name').value.trim(),
    description: document.getElementById('agent-description').value.trim(),
    personality: document.getElementById('agent-personality').value.trim() || undefined,
    channelName: channelName,
    teamChat: channelName ? teamChat : undefined,
    respondToAll: channelName ? respondToAll : undefined,
    model: document.getElementById('agent-model').value || undefined,
    project: document.getElementById('agent-project').value || undefined,
    tier: parseInt(document.getElementById('agent-tier').value) || 2,
    avatar: document.getElementById('agent-avatar-url').value.trim() || undefined,
  };

  var cm = document.getElementById('agent-canmessage').value.trim();
  if (cm) payload.canMessage = cm.split(',').map(function(s) { return s.trim(); }).filter(Boolean);

  var tools = getSelectedTools();
  if (tools.length) payload.allowedTools = tools;

  var discordToken = document.getElementById('agent-discord-token').value.trim();
  if (discordToken) payload.discordToken = discordToken;

  var discordChannelId = document.getElementById('agent-discord-channel-id').value.trim();
  if (discordChannelId) payload.discordChannelId = discordChannelId;

  var slackBotToken = document.getElementById('agent-slack-bot-token').value.trim();
  if (slackBotToken) payload.slackBotToken = slackBotToken;

  var slackAppToken = document.getElementById('agent-slack-app-token').value.trim();
  if (slackAppToken) payload.slackAppToken = slackAppToken;

  var slackChannelId = document.getElementById('agent-slack-channel-id').value.trim();
  if (slackChannelId) payload.slackChannelId = slackChannelId;

  try {
    var url = isEdit ? '/api/agents/' + editSlug : '/api/agents';
    var method = isEdit ? 'PUT' : 'POST';
    var r = await apiFetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    var d = await r.json();
    if (d.ok) {
      toast((isEdit ? 'Updated' : 'Created') + ' agent: ' + (d.agent?.name || payload.name), 'success');
      hideAgentModal();
      refreshTeam();
    } else {
      toast(d.error || 'Failed', 'error');
    }
  } catch(e) { toast(String(e), 'error'); }
}

async function deleteAgent(slug) {
  if (!confirm('Let go of "' + slug + '"? This removes the entire agent directory.')) return;
  try {
    var r = await apiFetch('/api/agents/' + slug, { method: 'DELETE' });
    var d = await r.json();
    if (d.ok) {
      toast('Deleted agent: ' + slug, 'success');
      refreshTeam();
    } else {
      toast(d.error || 'Failed', 'error');
    }
  } catch(e) { toast(String(e), 'error'); }
}

// ── Self-Improvement ──────────────────────
async function refreshSelfImprove() {
  try {
    const r = await apiFetch('/api/self-improve');
    const d = await r.json();
    const state = d.state;
    const experiments = d.experiments || [];
    const pending = d.pending || [];

    // Update nav badge
    const badge = document.getElementById('nav-si-pending');
    if (badge) badge.textContent = pending.length || '0';

    // Status cards
    const cards = document.getElementById('si-status-cards');
    if (cards && state) {
      const m = state.baselineMetrics || {};
      cards.innerHTML =
        '<div class="stat-card"><div class="stat-value">' + (state.status || 'idle') + '</div><div class="stat-label">Status</div></div>' +
        '<div class="stat-card"><div class="stat-value">' + (state.totalExperiments || 0) + '</div><div class="stat-label">Total Experiments</div></div>' +
        '<div class="stat-card"><div class="stat-value">' + (pending.length || 0) + '</div><div class="stat-label">Pending Approvals</div></div>' +
        '<div class="stat-card"><div class="stat-value">' + (state.lastRunAt ? new Date(state.lastRunAt).toLocaleDateString() : 'Never') + '</div><div class="stat-label">Last Run</div></div>' +
        '<div class="stat-card"><div class="stat-value">' + ((m.feedbackPositiveRatio || 0) * 100).toFixed(0) + '%</div><div class="stat-label">Feedback Positive</div></div>' +
        '<div class="stat-card"><div class="stat-value">' + ((m.cronSuccessRate || 0) * 100).toFixed(0) + '%</div><div class="stat-label">Cron Success</div></div>';
    } else if (cards) {
      cards.innerHTML = '<div class="stat-card"><div class="stat-value">idle</div><div class="stat-label">Status</div></div>' +
        '<div class="stat-card"><div class="stat-value">0</div><div class="stat-label">Total Experiments</div></div>';
    }

    // Pending proposals
    const pendingEl = document.getElementById('si-pending-list');
    if (pendingEl) {
      if (pending.length === 0) {
        pendingEl.innerHTML = '<div class="empty-state">No pending proposals</div>';
      } else {
        pendingEl.innerHTML = pending.map(function(p) {
          return '<div style="padding:12px;border-bottom:1px solid var(--border)">' +
            '<div style="display:flex;justify-content:space-between;align-items:center">' +
            '<div><strong>' + p.area + '</strong> &rarr; ' + (p.target || '').substring(0, 40) +
            ' <span style="color:var(--text-muted);font-size:12px">(' + ((p.score || 0) * 10).toFixed(1) + '/10)</span></div>' +
            '<div style="display:flex;gap:6px">' +
            '<button onclick="siApply(\\'' + p.id + '\\')" style="background:var(--success);color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px">Approve</button>' +
            '<button onclick="siDeny(\\'' + p.id + '\\')" style="background:var(--danger);color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px">Deny</button>' +
            '</div></div>' +
            '<div style="margin-top:6px;font-size:13px;color:var(--text-secondary)">' + (p.hypothesis || '').substring(0, 120) + '</div>' +
            '<details style="margin-top:6px"><summary style="font-size:12px;color:var(--text-muted);cursor:pointer">View proposed change</summary>' +
            '<pre style="margin-top:4px;font-size:11px;max-height:200px;overflow:auto;background:var(--bg-input);padding:8px;border-radius:4px;white-space:pre-wrap">' +
            (p.proposedChange || '').substring(0, 1000).replace(/</g, '&lt;') + '</pre></details>' +
            '</div>';
        }).join('');
      }
    }

    // Experiment history (most recent first)
    const historyEl = document.getElementById('si-history-list');
    if (historyEl) {
      const recent = experiments.slice(-20).reverse();
      if (recent.length === 0) {
        historyEl.innerHTML = '<div class="empty-state">No experiments yet</div>';
      } else {
        historyEl.innerHTML = '<table style="width:100%;font-size:13px;border-collapse:collapse">' +
          '<thead><tr style="text-align:left;color:var(--text-muted);font-size:11px;text-transform:uppercase">' +
          '<th style="padding:8px">#</th><th style="padding:8px">Area</th><th style="padding:8px">Hypothesis</th>' +
          '<th style="padding:8px">Score</th><th style="padding:8px">Status</th></tr></thead><tbody>' +
          recent.map(function(e) {
            var statusIcon = e.accepted ? (e.approvalStatus === 'approved' ? '&#9989;' : '&#9203;') : '&#10060;';
            return '<tr style="border-top:1px solid var(--border)">' +
              '<td style="padding:8px;color:var(--text-muted)">' + (e.iteration || '') + '</td>' +
              '<td style="padding:8px"><span style="background:var(--bg-input);padding:2px 6px;border-radius:4px;font-size:11px">' + (e.area || '') + '</span></td>' +
              '<td style="padding:8px">' + (e.hypothesis || '').substring(0, 60) + '</td>' +
              '<td style="padding:8px">' + ((e.score || 0) * 10).toFixed(1) + '/10</td>' +
              '<td style="padding:8px">' + statusIcon + ' ' + (e.approvalStatus || '') + '</td></tr>';
          }).join('') +
          '</tbody></table>';
      }
    }
  } catch (err) {
    console.error('Failed to refresh self-improve:', err);
  }
}

async function siApply(id) {
  try {
    const r = await apiFetch('/api/self-improve/apply/' + id, { method: 'POST' });
    const d = await r.json();
    if (d.ok) toast(d.message, 'success');
    else toast(d.message || 'Failed', 'error');
    refreshSelfImprove();
  } catch (err) { toast('Error: ' + err, 'error'); }
}

async function siDeny(id) {
  try {
    const r = await apiFetch('/api/self-improve/deny/' + id, { method: 'POST' });
    const d = await r.json();
    if (d.ok) toast(d.message, 'success');
    else toast(d.message || 'Failed', 'error');
    refreshSelfImprove();
  } catch (err) { toast('Error: ' + err, 'error'); }
}

// ── Knowledge Graph ──────────────────────
var graphNetwork = null;
var graphData = null;

async function refreshGraph() {
  var canvas = document.getElementById('graph-canvas');
  if (!canvas) return;
  try {
    var r = await apiFetch('/api/graph/visualization');
    var d = await r.json();
    graphData = d;
    if (!d.available || d.nodes.length === 0) {
      canvas.innerHTML = '<div class="empty-state" style="padding:40px;text-align:center;color:var(--text-muted)">' +
        (d.available ? 'No entities in graph yet. Chat with ${name} to populate the knowledge graph.' : 'Graph features not available. FalkorDBLite may not be installed.') + '</div>';
      document.getElementById('graph-detail-panel').innerHTML = '';
      return;
    }
    // Load vis-network from CDN if not loaded
    if (typeof vis === 'undefined') {
      await new Promise(function(resolve, reject) {
        var s = document.createElement('script');
        s.src = 'https://unpkg.com/vis-network@9.1.9/standalone/umd/vis-network.min.js';
        s.onload = resolve;
        s.onerror = function() { reject(new Error('Failed to load vis-network')); };
        document.head.appendChild(s);
      });
    }
    var filterLabel = document.getElementById('graph-filter-label').value;
    var searchTerm = document.getElementById('graph-search').value.toLowerCase();
    var filteredNodes = d.nodes.filter(function(n) {
      if (filterLabel && n.label !== filterLabel) return false;
      if (searchTerm && !n.id.toLowerCase().includes(searchTerm)) return false;
      return true;
    });
    // Deduplicate nodes by id (API may return the same entity under multiple labels)
    var seenIds = {};
    filteredNodes = filteredNodes.filter(function(n) { if (seenIds[n.id]) return false; seenIds[n.id] = true; return true; });
    var nodeIds = new Set(filteredNodes.map(function(n) { return n.id; }));
    var filteredEdges = d.edges.filter(function(e) { return nodeIds.has(e.from) && nodeIds.has(e.to); });
    var colorMap = { Person: '#4a9eff', Project: '#34d399', Topic: '#a78bfa', Agent: '#fb923c', Task: '#fbbf24', Note: '#94a3b8' };
    // Render legend
    var legendEl = document.getElementById('graph-legend');
    var usedLabels = {};
    filteredNodes.forEach(function(n) { usedLabels[n.label] = true; });
    legendEl.innerHTML = Object.keys(usedLabels).map(function(lbl) {
      var c = colorMap[lbl] || '#94a3b8';
      return '<span style="display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--text-muted)"><span style="width:10px;height:10px;border-radius:50%;background:' + c + ';display:inline-block"></span>' + lbl + '</span>';
    }).join('');
    var nodes = new vis.DataSet(filteredNodes.map(function(n) {
      return { id: n.id, label: n.id.replace(/-/g, ' '), group: n.label, title: n.label + ': ' + n.id, color: { background: colorMap[n.label] || '#94a3b8', border: colorMap[n.label] || '#94a3b8', highlight: { background: '#fff', border: colorMap[n.label] || '#94a3b8' } }, font: { color: '#e2e8f0', size: 12 } };
    }));
    var edges = new vis.DataSet(filteredEdges.map(function(e, i) {
      return { id: i, from: e.from, to: e.to, label: e.rel, arrows: 'to', color: { color: '#8892a8', highlight: '#c8d0e0' }, font: { color: '#a0aec0', size: 10, strokeWidth: 2, strokeColor: '#1e1e2e' } };
    }));
    canvas.innerHTML = '';
    graphNetwork = new vis.Network(canvas, { nodes: nodes, edges: edges }, {
      physics: { stabilization: { iterations: 100 }, barnesHut: { gravitationalConstant: -3000, springLength: 150 } },
      interaction: { hover: true, tooltipDelay: 200 },
      nodes: { shape: 'dot', size: 16, borderWidth: 2 },
      edges: { smooth: { type: 'continuous' } }
    });
    graphNetwork.on('click', function(params) {
      if (params.nodes.length > 0) {
        var nodeId = params.nodes[0];
        var node = d.nodes.find(function(n) { return n.id === nodeId; });
        if (node) showGraphDetail(node, d);
      }
    });
  } catch (err) {
    canvas.innerHTML = '<div class="empty-state" style="padding:40px;text-align:center;color:var(--text-muted)">Error loading graph: ' + err + '</div>';
  }
}

function showGraphDetail(node, data) {
  var panel = document.getElementById('graph-detail-panel');
  var rels = data.edges.filter(function(e) { return e.from === node.id || e.to === node.id; });
  var html = '<div class="card"><div class="card-header">' + node.label + ': ' + node.id.replace(/-/g, ' ') + '</div>';
  html += '<div style="padding:12px">';
  if (node.props && Object.keys(node.props).length > 0) {
    html += '<div style="margin-bottom:8px"><strong>Properties:</strong></div>';
    Object.entries(node.props).forEach(function(kv) { if (kv[1]) html += '<div style="color:var(--text-muted);font-size:13px">' + kv[0] + ': ' + kv[1] + '</div>'; });
  }
  if (rels.length > 0) {
    html += '<div style="margin-top:8px;margin-bottom:4px"><strong>Relationships (' + rels.length + '):</strong></div>';
    rels.forEach(function(r) {
      var dir = r.from === node.id ? r.from + ' → ' + r.rel + ' → ' + r.to : r.from + ' → ' + r.rel + ' → ' + r.to;
      html += '<div style="color:var(--text-muted);font-size:13px">' + dir + '</div>';
    });
  }
  html += '</div></div>';
  panel.innerHTML = html;
}

document.getElementById('graph-filter-label').addEventListener('change', function() { refreshGraph(); });
document.getElementById('graph-search').addEventListener('input', function() { clearTimeout(this._t); this._t = setTimeout(refreshGraph, 300); });

// ── Daily Plan ────────────────────────────
async function refreshDailyPlan() {
  try {
    const r = await apiFetch('/api/plans/today');
    const d = await r.json();
    const container = document.getElementById('daily-plan-content');
    if (!d.ok || !d.plan) {
      container.innerHTML = '<div class="empty-state">No plan generated for today yet. Plans are created on the first morning heartbeat tick.</div>';
      return;
    }
    const plan = d.plan;
    const urgencyColor = u => u >= 4 ? 'var(--red)' : u >= 3 ? 'var(--orange)' : u >= 2 ? 'var(--yellow)' : 'var(--text-muted)';
    const urgencyLabel = u => u >= 5 ? 'CRITICAL' : u >= 4 ? 'HIGH' : u >= 3 ? 'MEDIUM' : u >= 2 ? 'LOW' : 'NICE';

    let html = '<div class="card" style="margin-bottom:16px"><div class="card-header">Summary</div><div class="card-body">';
    html += '<p style="color:var(--text-secondary);margin:0">' + esc(plan.summary) + '</p>';
    html += '<div style="margin-top:8px;font-size:12px;color:var(--text-muted)">Generated: ' + new Date(plan.createdAt).toLocaleString() + '</div>';
    html += '</div></div>';

    if (plan.priorities?.length) {
      html += '<div class="card" style="margin-bottom:16px"><div class="card-header">Priorities (' + plan.priorities.length + ')</div><div class="card-body">';
      for (const p of plan.priorities) {
        html += '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">';
        html += '<span style="background:' + urgencyColor(p.urgency) + ';color:#000;font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px;min-width:60px;text-align:center">' + urgencyLabel(p.urgency) + '</span>';
        html += '<span style="background:var(--bg-tertiary);color:var(--text-muted);font-size:11px;padding:2px 8px;border-radius:6px">' + esc(p.type) + '</span>';
        html += '<span style="color:var(--text-primary);flex:1">' + esc(p.action) + '</span>';
        html += '</div>';
      }
      html += '</div></div>';
    }

    if (plan.suggestedCronChanges?.length) {
      html += '<div class="card" style="margin-bottom:16px"><div class="card-header">Suggested Cron Changes</div><div class="card-body">';
      for (const c of plan.suggestedCronChanges) {
        const changeColor = c.change === 'disable' ? 'var(--red)' : 'var(--orange)';
        html += '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">';
        html += '<span style="font-weight:600;color:var(--text-primary);min-width:140px">' + esc(c.job) + '</span>';
        html += '<span style="background:' + changeColor + ';color:#000;font-size:11px;font-weight:600;padding:2px 8px;border-radius:6px">' + esc(c.change) + '</span>';
        html += '<span style="color:var(--text-secondary);flex:1;font-size:13px">' + esc(c.reason) + '</span>';
        html += '<button class="btn btn-sm" onclick="applyPlanSuggestion(\'' + esc(c.job) + '\',\'' + esc(c.change) + '\',\'' + esc(c.reason) + '\')" style="background:var(--blue);color:#fff;font-size:11px">Apply</button>';
        html += '</div>';
      }
      html += '</div></div>';
    }

    if (plan.newWork?.length) {
      html += '<div class="card"><div class="card-header">New Work Suggestions</div><div class="card-body">';
      for (const w of plan.newWork) {
        html += '<div style="padding:8px 0;border-bottom:1px solid var(--border)">';
        html += '<div style="color:var(--text-primary)">' + esc(w.description) + '</div>';
        if (w.goalId) html += '<span style="font-size:12px;color:var(--text-muted)">Goal: ' + esc(w.goalId) + '</span> ';
        if (w.suggestedSchedule) html += '<span style="font-size:12px;color:var(--text-muted)">Schedule: ' + esc(w.suggestedSchedule) + '</span>';
        html += '</div>';
      }
      html += '</div></div>';
    }

    container.innerHTML = html;

    // Set date picker to today
    const now = new Date();
    document.getElementById('plan-date-picker').value = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0');

    // Load plan history
    const hr = await apiFetch('/api/plans');
    const hd = await hr.json();
    const histEl = document.getElementById('plan-history-list');
    if (hd.plans?.length) {
      histEl.innerHTML = hd.plans.map(p =>
        '<div style="display:flex;align-items:center;gap:12px;padding:6px 0;border-bottom:1px solid var(--border);cursor:pointer" onclick="loadPlanForDate(\'' + p.date + '\')">' +
        '<span style="font-weight:600;color:var(--blue);min-width:100px">' + p.date + '</span>' +
        '<span style="color:var(--text-muted);font-size:12px">' + p.priorityCount + ' priorities</span>' +
        '<span style="color:var(--text-secondary);flex:1;font-size:13px">' + esc(p.summary || '').slice(0, 120) + '</span>' +
        '</div>'
      ).join('');
    } else {
      histEl.innerHTML = '<div class="empty-state">No plan history</div>';
    }

    // Load plan diff (today vs yesterday)
    if (hd.plans?.length >= 2) {
      try {
        const today = hd.plans[0].date;
        const yesterday = hd.plans[1].date;
        const diffRes = await apiFetch('/api/plans/diff?from=' + yesterday + '&to=' + today);
        const diffData = await diffRes.json();
        const diffEl = document.getElementById('plan-diff-content');
        if (diffData.ok) {
          let dhtml = '<div class="card"><div class="card-header">Plan Changes: ' + yesterday + ' \\u2192 ' + today + '</div><div class="card-body">';
          if (diffData.resolved?.length) {
            dhtml += '<div style="margin-bottom:12px"><div style="font-size:12px;font-weight:600;color:var(--green);margin-bottom:4px">Resolved (' + diffData.resolved.length + ')</div>';
            for (const p of diffData.resolved) {
              dhtml += '<div style="padding:3px 0;color:var(--text-secondary);font-size:13px;text-decoration:line-through;opacity:0.7">\\u2714 ' + esc(p.action) + '</div>';
            }
            dhtml += '</div>';
          }
          if (diffData.carried?.length) {
            dhtml += '<div style="margin-bottom:12px"><div style="font-size:12px;font-weight:600;color:var(--orange);margin-bottom:4px">Carried Over (' + diffData.carried.length + ')</div>';
            for (const p of diffData.carried) {
              dhtml += '<div style="padding:3px 0;color:var(--text-secondary);font-size:13px">\\u21BB ' + esc(p.action) + '</div>';
            }
            dhtml += '</div>';
          }
          if (diffData.added?.length) {
            dhtml += '<div><div style="font-size:12px;font-weight:600;color:var(--blue);margin-bottom:4px">New Today (' + diffData.added.length + ')</div>';
            for (const p of diffData.added) {
              dhtml += '<div style="padding:3px 0;color:var(--text-secondary);font-size:13px">\\u2795 ' + esc(p.action) + '</div>';
            }
            dhtml += '</div>';
          }
          if (!diffData.resolved?.length && !diffData.carried?.length && !diffData.added?.length) {
            dhtml += '<div style="color:var(--text-muted);font-size:13px">Plans are identical.</div>';
          }
          dhtml += '</div></div>';
          diffEl.innerHTML = dhtml;
        } else {
          diffEl.innerHTML = '';
        }
      } catch { /* non-fatal */ }
    }
  } catch (err) {
    document.getElementById('daily-plan-content').innerHTML = '<div class="empty-state">Failed to load plan: ' + esc(String(err)) + '</div>';
  }
}

async function loadPlanForDate(date) {
  if (!date) return;
  try {
    const r = await apiFetch('/api/plans/' + date);
    const d = await r.json();
    if (!d.ok || !d.plan) { toast('No plan found for ' + date, 'error'); return; }
    // Re-render with loaded plan — swap today's API response
    const container = document.getElementById('daily-plan-content');
    // Re-use refreshDailyPlan rendering by temporarily overriding
    const plan = d.plan;
    const urgencyColor = u => u >= 4 ? 'var(--red)' : u >= 3 ? 'var(--orange)' : u >= 2 ? 'var(--yellow)' : 'var(--text-muted)';
    const urgencyLabel = u => u >= 5 ? 'CRITICAL' : u >= 4 ? 'HIGH' : u >= 3 ? 'MEDIUM' : u >= 2 ? 'LOW' : 'NICE';
    let html = '<div class="card" style="margin-bottom:16px"><div class="card-header">Plan for ' + plan.date + '</div><div class="card-body">';
    html += '<p style="color:var(--text-secondary);margin:0">' + esc(plan.summary) + '</p></div></div>';
    if (plan.priorities?.length) {
      html += '<div class="card"><div class="card-header">Priorities</div><div class="card-body">';
      for (const p of plan.priorities) {
        html += '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">';
        html += '<span style="background:' + urgencyColor(p.urgency) + ';color:#000;font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px;min-width:60px;text-align:center">' + urgencyLabel(p.urgency) + '</span>';
        html += '<span style="background:var(--bg-tertiary);color:var(--text-muted);font-size:11px;padding:2px 8px;border-radius:6px">' + esc(p.type) + '</span>';
        html += '<span style="color:var(--text-primary);flex:1">' + esc(p.action) + '</span>';
        html += '</div>';
      }
      html += '</div></div>';
    }
    container.innerHTML = html;
    document.getElementById('plan-date-picker').value = date;
  } catch (err) { toast('Error loading plan: ' + err, 'error'); }
}

async function applyPlanSuggestion(job, change, reason) {
  if (!confirm('Apply "' + change + '" to job "' + job + '"?\\n\\nReason: ' + reason)) return;
  try {
    const r = await apiFetch('/api/plans/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job, change, reason })
    });
    const d = await r.json();
    if (d.ok) { toast('Applied: ' + change + ' to ' + job, 'success'); refreshDailyPlan(); }
    else toast(d.error || 'Failed', 'error');
  } catch (err) { toast('Error: ' + err, 'error'); }
}

// ── Execution Analytics ───────────────────
async function refreshAdvisorAnalytics() {
  try {
    const r = await apiFetch('/api/advisor/analytics');
    const data = await r.json();
    const container = document.getElementById('advisor-analytics-content');

    let html = '';

    // Summary cards row
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px">';
    const stats = [
      { label: 'Interventions', value: data.totalInterventions, color: 'var(--blue)' },
      { label: 'Circuit Breakers', value: data.circuitBreakers, color: 'var(--red)' },
      { label: 'Model Upgrades', value: data.modelUpgrades, color: 'var(--orange)' },
      { label: 'Turn Adjustments', value: data.turnAdjustments, color: 'var(--yellow)' },
      { label: 'Timeout Adjustments', value: data.timeoutAdjustments, color: 'var(--purple)' },
      { label: 'Escalations', value: data.escalations, color: 'var(--red)' },
      { label: 'Enrichments', value: data.enrichments, color: 'var(--green)' },
    ];
    for (const s of stats) {
      html += '<div class="card" style="text-align:center;padding:16px">';
      html += '<div style="font-size:28px;font-weight:700;color:' + s.color + '">' + s.value + '</div>';
      html += '<div style="font-size:12px;color:var(--text-muted);margin-top:4px">' + s.label + '</div>';
      html += '</div>';
    }
    html += '</div>';

    // Intervention effectiveness
    const totalInterv = data.successAfterIntervention + data.failureAfterIntervention;
    if (totalInterv > 0) {
      const successPct = Math.round((data.successAfterIntervention / totalInterv) * 100);
      html += '<div class="card" style="margin-bottom:16px"><div class="card-header">Intervention Effectiveness</div><div class="card-body">';
      html += '<div style="display:flex;align-items:center;gap:16px">';
      html += '<div style="flex:1;background:var(--bg-tertiary);border-radius:8px;height:24px;overflow:hidden">';
      html += '<div style="width:' + successPct + '%;height:100%;background:var(--green);transition:width 0.3s"></div></div>';
      html += '<span style="font-weight:600;color:var(--green)">' + successPct + '% success</span>';
      html += '<span style="color:var(--text-muted);font-size:12px">(' + data.successAfterIntervention + '/' + totalInterv + ' runs)</span>';
      html += '</div></div></div>';
    }

    // Per-job breakdown
    const jobEntries = Object.entries(data.byJob || {}).sort((a, b) => b[1].interventions - a[1].interventions);
    if (jobEntries.length > 0) {
      html += '<div class="card" style="margin-bottom:16px"><div class="card-header">Per-Job Health</div><div class="card-body">';
      html += '<div style="display:grid;grid-template-columns:1fr 100px 100px 120px;gap:8px;font-size:12px;color:var(--text-muted);font-weight:600;padding-bottom:8px;border-bottom:1px solid var(--border)">';
      html += '<span>Job</span><span>Runs</span><span>Success</span><span>Interventions</span></div>';
      for (const [name, info] of jobEntries) {
        const rateColor = info.successRate >= 80 ? 'var(--green)' : info.successRate >= 50 ? 'var(--orange)' : 'var(--red)';
        html += '<div style="display:grid;grid-template-columns:1fr 100px 100px 120px;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);align-items:center">';
        html += '<span style="color:var(--text-primary);font-weight:500">' + esc(name) + '</span>';
        html += '<span style="color:var(--text-muted)">' + info.totalRuns + '</span>';
        html += '<span style="color:' + rateColor + ';font-weight:600">' + info.successRate + '%</span>';
        html += '<span style="color:var(--text-muted)">' + info.interventions + '</span>';
        html += '</div>';
      }
      html += '</div></div>';
    }

    // Recent decisions
    if (data.recentDecisions?.length) {
      html += '<div class="card"><div class="card-header">Recent Advisor Decisions</div><div class="card-body" style="max-height:400px;overflow-y:auto">';
      for (const d of data.recentDecisions) {
        const actions = [];
        if (d.advice?.adjustedModel) actions.push('model: ' + d.originalModel + ' \\u2192 ' + d.advice.adjustedModel);
        if (d.advice?.adjustedMaxTurns) actions.push('turns: ' + (d.originalMaxTurns || '?') + ' \\u2192 ' + d.advice.adjustedMaxTurns);
        if (d.advice?.adjustedTimeoutMs) actions.push('timeout: ' + Math.round(d.advice.adjustedTimeoutMs / 1000) + 's');
        if (d.advice?.shouldEscalate) actions.push('ESCALATED');
        if (d.advice?.promptEnrichment) actions.push('enriched prompt');
        html += '<div style="padding:8px 0;border-bottom:1px solid var(--border)">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center">';
        html += '<span style="font-weight:600;color:var(--text-primary)">' + esc(d.jobName) + '</span>';
        html += '<span style="font-size:12px;color:var(--text-muted)">' + new Date(d.timestamp).toLocaleString() + '</span>';
        html += '</div>';
        html += '<div style="font-size:13px;color:var(--text-secondary);margin-top:4px">' + actions.join(' | ') + '</div>';
        html += '</div>';
      }
      html += '</div></div>';
    }

    // Intervention effectiveness by type
    try {
      const effRes = await apiFetch('/api/advisor/effectiveness');
      const effData = await effRes.json();
      const types = Object.entries(effData.byType || {});
      if (types.length > 0) {
        html += '<div class="card" style="margin-bottom:16px"><div class="card-header">Intervention Effectiveness by Type</div><div class="card-body">';
        for (const [type, info] of types) {
          const barColor = info.rate >= 60 ? 'var(--green)' : info.rate >= 30 ? 'var(--orange)' : 'var(--red)';
          const label = type.replace(/-/g, ' ').replace(/\\b\\w/g, c => c.toUpperCase());
          html += '<div style="display:flex;align-items:center;gap:12px;padding:6px 0">';
          html += '<span style="min-width:160px;font-weight:500;color:var(--text-primary)">' + label + '</span>';
          html += '<div style="flex:1;background:var(--bg-tertiary);border-radius:6px;height:18px;overflow:hidden;position:relative">';
          html += '<div style="width:' + info.rate + '%;height:100%;background:' + barColor + ';transition:width 0.3s"></div>';
          html += '<span style="position:absolute;top:0;left:8px;line-height:18px;font-size:11px;color:#fff;font-weight:600">' + info.rate + '%</span>';
          html += '</div>';
          html += '<span style="min-width:60px;font-size:12px;color:var(--text-muted);text-align:right">' + info.success + '/' + info.total + '</span>';
          html += '</div>';
        }
        html += '</div></div>';
      }
    } catch { /* non-fatal */ }

    // Reflection quality trends
    try {
      const trendRes = await apiFetch('/api/advisor/reflection-trends');
      const trendData = await trendRes.json();
      const jobs = Object.entries(trendData.trends || {}).filter(([, pts]) => pts.length > 0);
      if (jobs.length > 0) {
        html += '<div class="card" style="margin-bottom:16px"><div class="card-header">Reflection Quality Trends</div><div class="card-body">';
        for (const [jobName, points] of jobs) {
          const avg = points.reduce((s, p) => s + p.quality, 0) / points.length;
          const avgColor = avg >= 3.5 ? 'var(--green)' : avg >= 2.5 ? 'var(--orange)' : 'var(--red)';
          // Draw sparkline as inline SVG
          const w = 200, h = 24, maxQ = 5;
          const step = w / Math.max(points.length - 1, 1);
          const svgPoints = points.map((p, i) => (i * step).toFixed(1) + ',' + (h - (p.quality / maxQ) * h).toFixed(1)).join(' ');
          html += '<div style="display:flex;align-items:center;gap:12px;padding:4px 0">';
          html += '<span style="min-width:160px;font-weight:500;color:var(--text-primary);font-size:13px">' + esc(jobName) + '</span>';
          html += '<svg width="' + w + '" height="' + h + '" style="flex-shrink:0"><polyline points="' + svgPoints + '" fill="none" stroke="' + avgColor + '" stroke-width="2"/></svg>';
          html += '<span style="font-size:12px;color:' + avgColor + ';font-weight:600;min-width:40px">avg ' + avg.toFixed(1) + '</span>';
          html += '</div>';
        }
        html += '</div></div>';
      }
    } catch { /* non-fatal */ }

    // Advisor events feed (circuit breakers, escalations, recoveries)
    try {
      const evtRes = await apiFetch('/api/advisor/events?limit=20');
      const evtData = await evtRes.json();
      if (evtData.events?.length > 0) {
        html += '<div class="card" style="margin-bottom:16px"><div class="card-header">Advisor Events</div><div class="card-body" style="max-height:300px;overflow-y:auto">';
        for (const evt of evtData.events) {
          const icon = evt.type === 'circuit-breaker' ? '\\u26A1' : evt.type === 'circuit-recovery' ? '\\u2705' : evt.type === 'escalation' ? '\\u2B06' : '\\u2139';
          const typeColor = evt.type === 'circuit-breaker' ? 'var(--red)' : evt.type === 'circuit-recovery' ? 'var(--green)' : evt.type === 'escalation' ? 'var(--orange)' : 'var(--blue)';
          html += '<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border)">';
          html += '<span style="font-size:16px">' + icon + '</span>';
          html += '<span style="background:' + typeColor + ';color:#000;font-size:10px;font-weight:700;padding:2px 8px;border-radius:6px;min-width:100px;text-align:center">' + esc(evt.type) + '</span>';
          html += '<span style="font-weight:500;color:var(--text-primary)">' + esc(evt.jobName) + '</span>';
          html += '<span style="flex:1;color:var(--text-secondary);font-size:13px">' + esc(evt.detail) + '</span>';
          html += '<span style="font-size:12px;color:var(--text-muted);white-space:nowrap">' + new Date(evt.timestamp).toLocaleString() + '</span>';
          html += '</div>';
        }
        html += '</div></div>';
      }
    } catch { /* non-fatal */ }

    if (!html) html = '<div class="empty-state">No advisor data yet. The execution advisor activates when cron jobs run.</div>';
    container.innerHTML = html;
  } catch (err) {
    document.getElementById('advisor-analytics-content').innerHTML = '<div class="empty-state">Failed to load: ' + esc(String(err)) + '</div>';
  }
}

// ── Goals Progress ────────────────────────
async function refreshGoalsProgress() {
  try {
    const r = await apiFetch('/api/goals/progress');
    const data = await r.json();
    const container = document.getElementById('goals-progress-content');

    if (!data.goals?.length) {
      container.innerHTML = '<div class="empty-state">No goals found. Create goals using the goal_create tool.</div>';
      return;
    }

    let html = '';
    const priorityColor = p => p === 'high' ? 'var(--red)' : p === 'medium' ? 'var(--orange)' : 'var(--green)';
    const statusIcon = s => s === 'active' ? '\\u25CF' : s === 'completed' ? '\\u2714' : '\\u25CB';

    for (const goal of data.goals) {
      html += '<div class="card" style="margin-bottom:16px">';
      html += '<div class="card-header" style="display:flex;align-items:center;gap:10px">';
      html += '<span style="color:' + (goal.status === 'active' ? 'var(--green)' : 'var(--text-muted)') + '">' + statusIcon(goal.status) + '</span>';
      html += '<span style="flex:1">' + esc(goal.title) + '</span>';
      html += '<span style="background:' + priorityColor(goal.priority) + ';color:#000;font-size:11px;font-weight:700;padding:2px 10px;border-radius:10px">' + esc(goal.priority) + '</span>';
      if (goal.owner) html += '<span style="font-size:12px;color:var(--text-muted)">Owner: ' + esc(goal.owner) + '</span>';
      html += '</div>';
      html += '<div class="card-body">';

      // Target date
      if (goal.targetDate) {
        const daysLeft = Math.floor((new Date(goal.targetDate).getTime() - Date.now()) / 86400000);
        const dateColor = daysLeft < 0 ? 'var(--red)' : daysLeft <= 7 ? 'var(--orange)' : 'var(--text-muted)';
        const dateLabel = daysLeft < 0 ? Math.abs(daysLeft) + 'd overdue' : daysLeft === 0 ? 'Due today' : daysLeft + 'd remaining';
        html += '<div style="margin-bottom:12px;font-size:13px"><span style="color:var(--text-muted)">Target: </span><span style="color:' + dateColor + ';font-weight:600">' + goal.targetDate + ' (' + dateLabel + ')</span></div>';
      }

      // Next actions
      if (goal.nextActions?.length) {
        html += '<div style="margin-bottom:12px"><div style="font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:4px">Next Actions</div>';
        for (const a of goal.nextActions) {
          html += '<div style="padding:3px 0;color:var(--text-secondary);font-size:13px">\\u2022 ' + esc(a) + '</div>';
        }
        html += '</div>';
      }

      // Blockers
      if (goal.blockers?.length) {
        html += '<div style="margin-bottom:12px"><div style="font-size:12px;font-weight:600;color:var(--red);margin-bottom:4px">Blockers</div>';
        for (const b of goal.blockers) {
          html += '<div style="padding:3px 0;color:var(--text-secondary);font-size:13px">\\u26A0 ' + esc(b) + '</div>';
        }
        html += '</div>';
      }

      // Agent contributions
      const agents = Object.entries(goal.agentContributions || {});
      if (agents.length > 0) {
        html += '<div style="margin-bottom:12px"><div style="font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:8px">Agent Contributions</div>';
        html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px">';
        for (const [agent, info] of agents) {
          const pct = info.runs > 0 ? Math.round((info.successes / info.runs) * 100) : 0;
          const barColor = pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--orange)' : 'var(--red)';
          html += '<div style="background:var(--bg-tertiary);border-radius:8px;padding:10px">';
          html += '<div style="font-weight:600;font-size:13px;color:var(--text-primary);margin-bottom:4px">' + esc(agent) + '</div>';
          html += '<div style="display:flex;align-items:center;gap:8px">';
          html += '<div style="flex:1;background:var(--bg-secondary);border-radius:4px;height:8px;overflow:hidden"><div style="width:' + pct + '%;height:100%;background:' + barColor + '"></div></div>';
          html += '<span style="font-size:12px;color:var(--text-muted)">' + pct + '% (' + info.runs + ' runs)</span>';
          html += '</div>';
          if (info.lastRun) html += '<div style="font-size:11px;color:var(--text-muted);margin-top:4px">Last: ' + new Date(info.lastRun).toLocaleString() + '</div>';
          html += '</div>';
        }
        html += '</div></div>';
      }

      // Delegations
      if (goal.delegations?.length) {
        html += '<div><div style="font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:4px">Delegated Tasks</div>';
        for (const d of goal.delegations) {
          const statusColor = d.status === 'completed' ? 'var(--green)' : d.status === 'in-progress' ? 'var(--blue)' : 'var(--text-muted)';
          html += '<div style="display:flex;align-items:center;gap:8px;padding:4px 0">';
          html += '<span style="color:' + statusColor + ';font-size:11px;font-weight:600;padding:1px 6px;border:1px solid ' + statusColor + ';border-radius:4px">' + esc(d.status) + '</span>';
          html += '<span style="color:var(--text-secondary);font-size:13px;flex:1">' + esc(d.task) + '</span>';
          html += '<span style="font-size:12px;color:var(--text-muted)">\\u2192 ' + esc(d.agent) + '</span>';
          html += '</div>';
        }
        html += '</div>';
      }

      // Progress notes
      if (goal.progressNotes?.length) {
        html += '<details style="margin-top:8px"><summary style="cursor:pointer;font-size:12px;color:var(--text-muted);font-weight:600">Progress Notes (' + goal.progressNotes.length + ')</summary>';
        html += '<div style="margin-top:4px;max-height:200px;overflow-y:auto">';
        for (const note of goal.progressNotes.slice(-10).reverse()) {
          html += '<div style="padding:4px 0;font-size:13px;color:var(--text-secondary);border-bottom:1px solid var(--border)">\\u2022 ' + esc(note) + '</div>';
        }
        html += '</div></details>';
      }

      html += '</div></div>';
    }

    container.innerHTML = html;
  } catch (err) {
    document.getElementById('goals-progress-content').innerHTML = '<div class="empty-state">Failed to load: ' + esc(String(err)) + '</div>';
  }
}

refreshAll();
setInterval(refreshAll, 5000);
</script>
</body>
</html>`;
}

function getLoginPageHTML(): string {
  const name = getAssistantName();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} — Remote Access</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0a0a0f;
    color: #e2e8f0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
  }
  .login-card {
    background: #12121a;
    border: 1px solid #1e1e2e;
    border-radius: 12px;
    padding: 40px;
    max-width: 400px;
    width: 100%;
    margin: 20px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
  }
  .login-avatar {
    width: 48px; height: 48px;
    background: linear-gradient(135deg, #f97316, #ea580c);
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 22px; font-weight: 700; color: white;
    margin-bottom: 20px;
  }
  .login-title { font-size: 22px; font-weight: 700; margin-bottom: 6px; }
  .login-subtitle { color: #64748b; font-size: 14px; margin-bottom: 28px; }
  .form-group { margin-bottom: 20px; }
  .form-label {
    display: block; font-size: 13px; font-weight: 600;
    color: #94a3b8; margin-bottom: 6px;
  }
  .form-input {
    width: 100%; padding: 10px 14px;
    border: 1px solid #1e1e2e; border-radius: 8px;
    background: #0a0a0f; color: #e2e8f0;
    font-size: 14px; font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    letter-spacing: 1px; transition: border-color 0.2s;
  }
  .form-input:focus { outline: none; border-color: #f97316; }
  .btn-login {
    width: 100%; padding: 10px; border: none; border-radius: 8px;
    background: #f97316; color: white;
    font-size: 14px; font-weight: 600; cursor: pointer;
    transition: background 0.2s;
  }
  .btn-login:hover { background: #ea580c; }
  .btn-login:disabled { opacity: 0.5; cursor: not-allowed; }
  .error-msg {
    color: #ef4444; font-size: 13px; margin-top: 12px;
    display: none; text-align: center;
  }
  .footer {
    margin-top: 24px; font-size: 12px;
    color: #475569; text-align: center; line-height: 1.5;
  }
</style>
</head>
<body>
  <div class="login-card">
    <div class="login-avatar">${name.charAt(0).toUpperCase()}</div>
    <div class="login-title">${name}</div>
    <div class="login-subtitle">Enter your access token to continue</div>
    <form onsubmit="doLogin(event)">
      <div class="form-group">
        <label class="form-label">Access Token</label>
        <input type="password" class="form-input" id="token-input"
          placeholder="clem_XXXX-XXXX-XXXX" autocomplete="off" autofocus>
      </div>
      <button type="submit" class="btn-login" id="login-btn">Sign In</button>
      <div class="error-msg" id="error-msg"></div>
    </form>
    <div class="footer">
      Find your token in the dashboard<br>
      <strong>Settings &rarr; Remote Access</strong>
    </div>
  </div>
  <script>
    async function doLogin(e) {
      e.preventDefault();
      var btn = document.getElementById('login-btn');
      var err = document.getElementById('error-msg');
      var token = document.getElementById('token-input').value.trim();
      if (!token) return;
      btn.disabled = true;
      btn.textContent = 'Signing in...';
      err.style.display = 'none';
      try {
        var r = await fetch('/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: token })
        });
        var d = await r.json();
        if (d.ok) {
          window.location.href = '/';
        } else {
          err.textContent = d.error || 'Invalid token';
          err.style.display = 'block';
        }
      } catch (ex) {
        err.textContent = 'Connection error';
        err.style.display = 'block';
      }
      btn.disabled = false;
      btn.textContent = 'Sign In';
    }
  </script>
</body>
</html>`;
}
