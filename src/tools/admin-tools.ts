/**
 * Clementine TypeScript — Admin/System MCP tools.
 *
 * set_timer, workspace_config/list/info, cron_run_history, cron_list,
 * add_cron_job, trigger_cron_job, workflow_list/create/run,
 * analyze_image, feedback_log/report, teach_skill, create_tool,
 * self_restart, self_improve_status/run, source_self_edit,
 * cron_progress_read/write
 */

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import {
  BASE_DIR, CRON_FILE, SYSTEM_DIR,
  env, getStore, logger, textResult, 
} from './shared.js';

function readEnvFile(): Record<string, string> { return env; }

export function registerAdminTools(server: McpServer): void {
// ── 16. set_timer ──────────────────────────────────────────────────────

const TIMERS_FILE = path.join(BASE_DIR, '.timers.json');

interface TimerEntry {
  id: string;
  message: string;
  fireAt: number;
  createdAt: number;
}

function readTimers(): TimerEntry[] {
  if (!existsSync(TIMERS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(TIMERS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function writeTimers(timers: TimerEntry[]): void {
  writeFileSync(TIMERS_FILE, JSON.stringify(timers, null, 2));
}

server.tool(
  'set_timer',
  'Set a short-term reminder/timer. Fires in N minutes and sends a notification. Use this instead of cron for reminders under 24 hours.',
  {
    minutes: z.number().describe('Minutes from now to fire the reminder'),
    message: z.string().describe('The reminder message to send'),
  },
  async ({ minutes, message }) => {
    if (minutes < 1 || minutes > 1440) {
      return textResult('Timer must be between 1 and 1440 minutes (24 hours). Use cron for longer schedules.');
    }

    const now = Date.now();
    const fireAt = now + minutes * 60 * 1000;
    const timer: TimerEntry = {
      id: `timer-${now}`,
      message,
      fireAt,
      createdAt: now,
    };

    const timers = readTimers();
    timers.push(timer);
    writeTimers(timers);

    const fireTime = new Date(fireAt).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

    return textResult(`Timer set. Reminder in ${minutes} minute${minutes !== 1 ? 's' : ''} (~${fireTime}): "${message}"`);
  },
);


// ── Workspace Tools ─────────────────────────────────────────────────────

/** Common developer directories to auto-scan (relative to home). */
const DEFAULT_WORKSPACE_CANDIDATES = [
  'Desktop', 'Documents', 'Developer', 'Projects', 'projects',
  'repos', 'Repos', 'src', 'code', 'Code', 'work', 'Work',
  'dev', 'Dev', 'github', 'GitHub', 'gitlab', 'GitLab',
];

/**
 * Build the effective workspace dirs list:
 * 1. Auto-scan common locations that exist on this machine
 * 2. Merge with explicit WORKSPACE_DIRS from .env
 * 3. Deduplicate by resolved path
 */
function getWorkspaceDirs(): string[] {
  const home = os.homedir();
  const seen = new Set<string>();
  const dirs: string[] = [];

  const add = (d: string) => {
    const resolved = path.resolve(d);
    if (!seen.has(resolved) && existsSync(resolved) && statSync(resolved).isDirectory()) {
      seen.add(resolved);
      dirs.push(resolved);
    }
  };

  // Auto-scan common locations
  for (const candidate of DEFAULT_WORKSPACE_CANDIDATES) {
    add(path.join(home, candidate));
  }

  // Merge explicit WORKSPACE_DIRS from .env
  const fresh = readEnvFile();
  const explicit = (fresh['WORKSPACE_DIRS'] ?? '')
    .split(',').map(s => s.trim()).filter(Boolean)
    .map(d => d.startsWith('~') ? d.replace('~', home) : d);
  for (const d of explicit) {
    add(d);
  }

  return dirs;
}

/** Update a single key in the .env file, preserving all other content. */
function updateEnvKey(key: string, value: string): void {
  const envPath = path.join(BASE_DIR, '.env');
  let lines: string[] = [];
  if (existsSync(envPath)) {
    lines = readFileSync(envPath, 'utf-8').split('\n');
  }

  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(`${key}=`)) {
      lines[i] = `${key}=${value}`;
      found = true;
      break;
    }
  }

  if (!found) {
    // Find or create the Workspace section
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
    lines.splice(insertIdx, 0, `${key}=${value}`);
  }

  writeFileSync(envPath, lines.join('\n'));
}

server.tool(
  'workspace_config',
  'View or modify workspace directories. Add/remove parent directories that contain your projects. Changes take effect immediately.',
  {
    action: z.enum(['list', 'add', 'remove']).describe('"list" to show current dirs, "add" to add a directory, "remove" to remove one'),
    directory: z.string().optional().describe('Directory path to add or remove (required for add/remove)'),
  },
  async ({ action, directory }) => {
    const currentDirs = getWorkspaceDirs();

    if (action === 'list') {
      if (currentDirs.length === 0) {
        return textResult('No workspace directories found. Use action "add" to add one.');
      }
      // Mark which are explicit vs auto-detected
      const fresh = readEnvFile();
      const explicitSet = new Set(
        (fresh['WORKSPACE_DIRS'] ?? '').split(',').map(s => s.trim()).filter(Boolean)
          .map(d => path.resolve(d.startsWith('~') ? d.replace('~', os.homedir()) : d)),
      );
      const lines = currentDirs.map((d, i) => {
        const tag = explicitSet.has(d) ? ' *(explicit)*' : ' *(auto-detected)*';
        return `${i + 1}. \`${d}\`${tag}`;
      });
      return textResult(`Workspace directories (${currentDirs.length}):\n\n${lines.join('\n')}`);
    }

    if (!directory) {
      throw new Error('directory is required for add/remove actions');
    }

    const resolved = path.resolve(
      directory.startsWith('~') ? directory.replace('~', os.homedir()) : directory,
    );

    if (action === 'add') {
      if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
        throw new Error(`Not a directory: ${resolved}`);
      }
      // Store with ~ for portability
      const display = resolved.startsWith(os.homedir())
        ? resolved.replace(os.homedir(), '~')
        : resolved;

      // Check for duplicates
      const currentRaw = (readEnvFile()['WORKSPACE_DIRS'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
      if (currentRaw.includes(display) || currentRaw.includes(resolved)) {
        return textResult(`\`${display}\` is already in workspace directories.`);
      }

      const updated = [...currentRaw, display].join(',');
      updateEnvKey('WORKSPACE_DIRS', updated);
      return textResult(`Added \`${display}\` to workspace directories. ${currentRaw.length + 1} total.`);
    }

    if (action === 'remove') {
      const currentRaw = (readEnvFile()['WORKSPACE_DIRS'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
      const display = resolved.startsWith(os.homedir())
        ? resolved.replace(os.homedir(), '~')
        : resolved;

      const filtered = currentRaw.filter(d => {
        const dResolved = path.resolve(d.startsWith('~') ? d.replace('~', os.homedir()) : d);
        return dResolved !== resolved;
      });

      if (filtered.length === currentRaw.length) {
        return textResult(`\`${display}\` was not found in workspace directories.`);
      }

      updateEnvKey('WORKSPACE_DIRS', filtered.join(','));
      return textResult(`Removed \`${display}\` from workspace directories. ${filtered.length} remaining.`);
    }

    throw new Error(`Unknown action: ${action}`);
  },
);

const PROJECT_MARKERS = [
  '.git', 'package.json', 'pyproject.toml', 'Cargo.toml',
  'go.mod', 'Makefile', 'CMakeLists.txt', 'build.gradle',
  'pom.xml', 'Gemfile', 'mix.exs', '.claude/CLAUDE.md',
];

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

function extractDescription(dirPath: string, entries: string[]): string {
  // Try package.json
  if (entries.includes('package.json')) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dirPath, 'package.json'), 'utf-8'));
      if (pkg.description) return pkg.description;
    } catch { /* ignore */ }
  }
  // Try pyproject.toml (basic parse)
  if (entries.includes('pyproject.toml')) {
    try {
      const toml = readFileSync(path.join(dirPath, 'pyproject.toml'), 'utf-8');
      const match = toml.match(/description\s*=\s*"([^"]+)"/);
      if (match) return match[1];
    } catch { /* ignore */ }
  }
  // Try first non-heading line of README
  for (const readme of ['README.md', 'readme.md', 'README.rst', 'README']) {
    if (entries.includes(readme)) {
      try {
        const lines = readFileSync(path.join(dirPath, readme), 'utf-8').split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('=')) {
            return trimmed.slice(0, 200);
          }
        }
      } catch { /* ignore */ }
    }
  }
  return '';
}

server.tool(
  'workspace_list',
  'List local projects found in configured workspace directories. Scans WORKSPACE_DIRS for project roots.',
  {
    filter: z.string().optional().describe('Filter project names (case-insensitive substring match)'),
  },
  async ({ filter }) => {
    const workspaceDirs = getWorkspaceDirs();

    if (workspaceDirs.length === 0) {
      return textResult(
        'No workspace directories found (none of the common locations exist and WORKSPACE_DIRS is empty). ' +
        'Use workspace_config to add a directory.',
      );
    }

    interface ProjectEntry {
      name: string;
      path: string;
      type: string;
      description: string;
      hasClaude: boolean;
    }

    const projects: ProjectEntry[] = [];
    const seenProjects = new Set<string>();

    const addProject = (fullPath: string, name: string) => {
      const resolvedProject = path.resolve(fullPath);
      if (seenProjects.has(resolvedProject)) return;
      seenProjects.add(resolvedProject);

      if (filter && !name.toLowerCase().includes(filter.toLowerCase())) return;

      let subEntries: string[];
      try { subEntries = readdirSync(fullPath); } catch { return; }

      projects.push({
        name,
        path: fullPath,
        type: detectProjectType(subEntries),
        description: extractDescription(fullPath, subEntries),
        hasClaude: existsSync(path.join(fullPath, '.claude', 'CLAUDE.md')),
      });
    };

    for (const wsDir of workspaceDirs) {
      const resolved = path.resolve(wsDir);
      if (!existsSync(resolved)) continue;

      let entries: string[];
      try {
        entries = readdirSync(resolved);
      } catch { continue; }

      // Check if the workspace dir itself is a project
      const wsDirIsProject = PROJECT_MARKERS.some(marker => {
        if (marker.includes('/')) return existsSync(path.join(resolved, marker));
        return entries.includes(marker);
      });
      if (wsDirIsProject) {
        addProject(resolved, path.basename(resolved));
      }

      // Scan subdirectories for projects
      for (const entry of entries) {
        if (entry.startsWith('.')) continue;
        const fullPath = path.join(resolved, entry);
        try {
          if (!statSync(fullPath).isDirectory()) continue;
        } catch { continue; }

        let subEntries: string[];
        try {
          subEntries = readdirSync(fullPath);
        } catch { continue; }

        const isProject = PROJECT_MARKERS.some(marker => {
          if (marker.includes('/')) {
            return existsSync(path.join(fullPath, marker));
          }
          return subEntries.includes(marker);
        });

        if (!isProject) continue;

        addProject(fullPath, entry);
      }
    }

    if (projects.length === 0) {
      return textResult(
        filter
          ? `No projects matching "${filter}" found in workspace directories.`
          : 'No projects found in workspace directories.',
      );
    }

    const lines = projects.map(p => {
      const parts = [`**${p.name}** (${p.type})`];
      if (p.description) parts.push(`  ${p.description}`);
      parts.push(`  Path: \`${p.path}\``);
      if (p.hasClaude) parts.push('  Has `.claude/CLAUDE.md`');
      return parts.join('\n');
    });

    return textResult(`Found ${projects.length} project(s):\n\n${lines.join('\n\n')}`);
  },
);

server.tool(
  'workspace_info',
  'Get detailed info about a local project: README, CLAUDE.md, manifest, structure.',
  {
    project_path: z.string().describe('Absolute path to the project root'),
    include_tree: z.boolean().optional().describe('Include directory tree (default true, depth 2)'),
  },
  async ({ project_path, include_tree }) => {
    const resolved = path.resolve(
      project_path.startsWith('~') ? project_path.replace('~', os.homedir()) : project_path,
    );

    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      throw new Error(`Not a directory: ${resolved}`);
    }

    const sections: string[] = [`# ${path.basename(resolved)}\n\nPath: \`${resolved}\``];

    // CLAUDE.md
    const claudeMd = path.join(resolved, '.claude', 'CLAUDE.md');
    if (existsSync(claudeMd)) {
      const content = readFileSync(claudeMd, 'utf-8').slice(0, 3000);
      sections.push(`## CLAUDE.md\n\n${content}`);
    }

    // README
    for (const readme of ['README.md', 'readme.md', 'README.rst', 'README']) {
      const readmePath = path.join(resolved, readme);
      if (existsSync(readmePath)) {
        const content = readFileSync(readmePath, 'utf-8').slice(0, 3000);
        sections.push(`## ${readme}\n\n${content}`);
        break;
      }
    }

    // package.json summary
    const pkgPath = path.join(resolved, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        const info: string[] = [];
        if (pkg.name) info.push(`Name: ${pkg.name}`);
        if (pkg.version) info.push(`Version: ${pkg.version}`);
        if (pkg.description) info.push(`Description: ${pkg.description}`);
        if (pkg.scripts) info.push(`Scripts: ${Object.keys(pkg.scripts).join(', ')}`);
        if (pkg.dependencies) info.push(`Dependencies: ${Object.keys(pkg.dependencies).length}`);
        if (pkg.devDependencies) info.push(`Dev dependencies: ${Object.keys(pkg.devDependencies).length}`);
        sections.push(`## package.json\n\n${info.join('\n')}`);
      } catch { /* ignore */ }
    }

    // pyproject.toml summary
    const pyprojectPath = path.join(resolved, 'pyproject.toml');
    if (existsSync(pyprojectPath)) {
      const content = readFileSync(pyprojectPath, 'utf-8').slice(0, 2000);
      sections.push(`## pyproject.toml\n\n${content}`);
    }

    // Directory tree (depth 2)
    if (include_tree !== false) {
      const tree: string[] = [];
      try {
        const topEntries = readdirSync(resolved).filter(e => !e.startsWith('.')).sort();
        for (const entry of topEntries) {
          const fullPath = path.join(resolved, entry);
          try {
            if (statSync(fullPath).isDirectory()) {
              tree.push(`${entry}/`);
              const subEntries = readdirSync(fullPath)
                .filter(e => !e.startsWith('.') && e !== 'node_modules' && e !== '__pycache__' && e !== '.git')
                .sort()
                .slice(0, 20);
              for (const sub of subEntries) {
                tree.push(`  ${sub}${statSync(path.join(fullPath, sub)).isDirectory() ? '/' : ''}`);
              }
              if (readdirSync(fullPath).filter(e => !e.startsWith('.')).length > 20) {
                tree.push('  ...');
              }
            } else {
              tree.push(entry);
            }
          } catch {
            tree.push(entry);
          }
        }
      } catch { /* ignore */ }

      if (tree.length > 0) {
        sections.push(`## Directory Structure\n\n\`\`\`\n${tree.join('\n')}\n\`\`\``);
      }
    }

    return textResult(sections.join('\n\n---\n\n'));
  },
);


// ── Cron Run History ──────────────────────────────────────────────────

server.tool(
  'cron_run_history',
  'Query your own cron job execution history — statuses, durations, errors, and reflection scores. ' +
  'Use this to understand your past performance and identify patterns.',
  {
    job_name: z.string().describe('Name of the cron job to query history for'),
    limit: z.number().optional().describe('Number of recent runs to return (default: 10, max: 50)'),
  },
  async ({ job_name, limit }) => {
    const count = Math.min(limit ?? 10, 50);

    // Read run log
    const runDir = path.join(BASE_DIR, 'cron', 'runs');
    const safeJob = job_name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const runLogPath = path.join(runDir, `${safeJob}.jsonl`);

    let runs: any[] = [];
    if (existsSync(runLogPath)) {
      const lines = readFileSync(runLogPath, 'utf-8').trim().split('\n').filter(Boolean);
      runs = lines.slice(-count).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
    }

    // Read reflections
    const reflectionsDir = path.join(BASE_DIR, 'cron', 'reflections');
    const reflPath = path.join(reflectionsDir, `${safeJob}.jsonl`);
    let reflections: any[] = [];
    if (existsSync(reflPath)) {
      const lines = readFileSync(reflPath, 'utf-8').trim().split('\n').filter(Boolean);
      reflections = lines.slice(-count).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
    }

    if (runs.length === 0 && reflections.length === 0) {
      return textResult(`No execution history found for job '${job_name}'.`);
    }

    const parts: string[] = [`## Run History: ${job_name} (last ${count})`];

    if (runs.length > 0) {
      parts.push('\n### Executions');
      for (const r of runs) {
        const dur = r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : '?';
        const err = r.error ? ` | Error: ${r.error.slice(0, 100)}` : '';
        parts.push(`- [${r.status}] ${r.startedAt} (${dur})${err}`);
      }
    }

    if (reflections.length > 0) {
      parts.push('\n### Quality Reflections');
      for (const r of reflections) {
        const flags = [
          r.existence ? 'exists' : 'MISSING',
          r.substance ? 'substantive' : 'EMPTY',
          r.actionable ? 'actionable' : 'NOT-ACTIONABLE',
        ].join(', ');
        const gap = r.gap && r.gap !== 'none' ? ` | Gap: ${r.gap.slice(0, 100)}` : '';
        parts.push(`- Quality: ${r.quality}/5 (${flags})${gap} — ${r.timestamp}`);
      }
    }

    return textResult(parts.join('\n'));
  },
);


// ── List Cron Jobs ──────────────────────────────────────────────────────

function describeCronSchedule(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return expr;
  const [min, hour, dom, mon, dow] = parts;

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const monNames = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  let timeStr = '';
  if (hour !== '*' && min !== '*') {
    const h = parseInt(hour, 10);
    const m = parseInt(min, 10);
    if (!isNaN(h) && !isNaN(m)) {
      const ampm = h >= 12 ? 'PM' : 'AM';
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      timeStr = `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
    }
  } else if (min.startsWith('*/')) {
    timeStr = `every ${min.slice(2)} min`;
  } else if (hour.startsWith('*/')) {
    timeStr = `every ${hour.slice(2)} hours`;
  }

  let dayStr = '';
  if (dow !== '*') {
    const days = dow.split(',').map(d => {
      const n = parseInt(d, 10);
      return !isNaN(n) ? (dayNames[n % 7] || d) : d;
    });
    dayStr = days.join(', ');
  } else if (dom !== '*') {
    dayStr = `day ${dom}`;
    if (mon !== '*') {
      const m = parseInt(mon, 10);
      dayStr += ` of ${!isNaN(m) ? (monNames[m] || mon) : mon}`;
    }
  } else {
    dayStr = 'daily';
  }

  return [timeStr, dayStr].filter(Boolean).join(' ');
}

function getNextRun(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return null;
  const [minF, hourF, domF, monF, dowF] = parts;

  const now = new Date();
  // Check the next 48 hours minute by minute (max 2880 iterations)
  for (let offset = 1; offset <= 2880; offset++) {
    const t = new Date(now.getTime() + offset * 60_000);
    const matches =
      fieldMatch(minF, t.getMinutes()) &&
      fieldMatch(hourF, t.getHours()) &&
      fieldMatch(domF, t.getDate()) &&
      fieldMatch(monF, t.getMonth() + 1) &&
      fieldMatch(dowF, t.getDay());
    if (matches) {
      const h = t.getHours();
      const m = t.getMinutes();
      const ampm = h >= 12 ? 'PM' : 'AM';
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      const today = t.toDateString() === now.toDateString();
      const tomorrow = t.toDateString() === new Date(now.getTime() + 86400000).toDateString();
      const dayLabel = today ? 'today' : tomorrow ? 'tomorrow' : t.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      return `${dayLabel} at ${h12}:${String(m).padStart(2, '0')} ${ampm}`;
    }
  }
  return null;
}

function fieldMatch(field: string, value: number): boolean {
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

server.tool(
  'cron_list',
  'List all scheduled cron jobs with human-readable schedules, next run times, and recent run status.',
  { _empty: z.string().optional().describe('(no parameters needed)') },
  async () => {
    if (!existsSync(CRON_FILE)) {
      return textResult('No cron jobs configured (CRON.md not found).');
    }

    const matterMod = await import('gray-matter');
    const raw = readFileSync(CRON_FILE, 'utf-8');
    let parsed;
    try {
      parsed = matterMod.default(raw);
    } catch (err) {
      return textResult(`CRON.md has a YAML syntax error — fix the file before listing jobs.\nError: ${err instanceof Error ? err.message : err}`);
    }
    const jobDefs = (parsed.data.jobs ?? []) as Array<Record<string, unknown>>;

    if (jobDefs.length === 0) {
      return textResult('No cron jobs defined in CRON.md.');
    }

    // Load recent run history
    const runsDir = path.join(BASE_DIR, 'cron', 'runs');

    const lines: string[] = [];
    for (const job of jobDefs) {
      const name = String(job.name ?? '');
      const schedule = String(job.schedule ?? '');
      const prompt = String(job.prompt ?? '');
      const enabled = job.enabled !== false;
      const mode = job.mode === 'unleashed' ? 'unleashed' : 'standard';
      const workDir = job.work_dir ? String(job.work_dir) : null;

      const humanSchedule = describeCronSchedule(schedule);
      const nextRun = enabled ? getNextRun(schedule) : null;

      let lastRunInfo = '';
      if (existsSync(runsDir)) {
        const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
        const logFile = path.join(runsDir, `${safeName}.jsonl`);
        if (existsSync(logFile)) {
          try {
            const logLines = readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean);
            if (logLines.length > 0) {
              const last = JSON.parse(logLines[logLines.length - 1]);
              const ago = Math.round((Date.now() - new Date(last.finishedAt).getTime()) / 60000);
              const agoStr = ago < 60 ? `${ago}m ago` : ago < 1440 ? `${Math.round(ago / 60)}h ago` : `${Math.round(ago / 1440)}d ago`;
              lastRunInfo = `last run: ${last.status} (${agoStr})`;
              if (last.deliveryFailed) lastRunInfo += ' [delivery failed]';
            }
          } catch { /* ignore */ }
        }
      }

      const status = enabled ? 'enabled' : 'disabled';
      lines.push(`**${name}** [${status}] ${mode === 'unleashed' ? '[unleashed] ' : ''}` +
        `\n  Schedule: ${humanSchedule} (\`${schedule}\`)` +
        (nextRun ? `\n  Next run: ${nextRun}` : '') +
        (lastRunInfo ? `\n  ${lastRunInfo}` : '') +
        (workDir ? `\n  Work dir: ${workDir}` : '') +
        `\n  Prompt: ${prompt.slice(0, 120)}${prompt.length > 120 ? '...' : ''}`);
    }

    return textResult(lines.join('\n\n'));
  },
);


// ── Add Cron Job ────────────────────────────────────────────────────────

server.tool(
  'add_cron_job',
  'Add a new scheduled cron job. Validates the schedule expression and writes to CRON.md. The daemon auto-reloads on file change. Use mode "unleashed" for multi-step tasks (browser automation, batch processing, multi-contact workflows) — they need more turns than standard mode provides. Auto-escalates to unleashed when complex patterns are detected.',
  {
    name: z.string().describe('Job name (unique identifier)'),
    schedule: z.string().describe('Cron expression (e.g., "0 9 * * 1" for Monday 9 AM)'),
    prompt: z.string().describe('The prompt/instruction for the assistant to execute'),
    tier: z.number().optional().default(1).describe('Security tier (1=auto, 2=logged, 3=approval)'),
    enabled: z.boolean().optional().default(true).describe('Whether the job is enabled'),
    work_dir: z.string().optional().describe('Project directory to run in (agent gets access to project tools, CLAUDE.md, files)'),
    mode: z.enum(['standard', 'unleashed']).optional().default('standard').describe('standard = normal cron, unleashed = long-running phased execution with checkpointing'),
    max_hours: z.number().optional().describe('Max hours for unleashed mode (default 6). Ignored for standard mode.'),
  },
  async ({ name: jobName, schedule, prompt, tier, enabled, work_dir, mode: rawMode, max_hours: rawMaxHours }) => {
    let mode = rawMode;
    let max_hours = rawMaxHours;
    // Validate cron expression
    const cronMod = await import('node-cron');
    if (!cronMod.default.validate(schedule)) {
      return textResult(`Invalid cron expression: "${schedule}". Examples: "0 9 * * 1" (Mon 9 AM), "*/30 * * * *" (every 30 min).`);
    }

    // Auto-escalate to unleashed when the job clearly needs it.
    // Tier 2 jobs with complex prompts (browser automation, multi-contact workflows,
    // multi-step sequences) will exhaust standard turn limits silently.
    if (mode !== 'unleashed' && tier >= 2) {
      const complexSignals = [
        /\bfor each\b.*\bcontact\b/i,
        /\bfor each\b.*\bprospect\b/i,
        /\bfor each\b.*\baccount\b/i,
        /\bfor each\b.*\blead\b/i,
        /\bfor each\b.*\bprofile\b/i,
        /\bplaywright\b/i,
        /\bkernel\s+browsers?\b/i,
        /\bbrowser\b.*\bautomati/i,
        /\bstep\s+\d+\b.*\bstep\s+\d+\b/is,
      ];
      const isComplex = complexSignals.some(p => p.test(prompt))
        || prompt.length > 2000;
      if (isComplex) {
        mode = 'unleashed';
        if (!max_hours) max_hours = 1;
        logger.info({ jobName }, 'Auto-escalated to unleashed mode (complex prompt detected)');
      }
    }

    // Read existing CRON.md or create empty structure
    const matterMod = await import('gray-matter');
    let parsed: ReturnType<typeof matterMod.default>;
    if (existsSync(CRON_FILE)) {
      const raw = readFileSync(CRON_FILE, 'utf-8');
      parsed = matterMod.default(raw);
    } else {
      const dir = path.dirname(CRON_FILE);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      parsed = matterMod.default('');
      parsed.data = {};
    }

    const jobs = (parsed.data.jobs ?? []) as Array<Record<string, unknown>>;

    // Check for duplicate name
    const duplicate = jobs.find(
      (j) => String(j.name ?? '').toLowerCase() === jobName.toLowerCase(),
    );
    if (duplicate) {
      return textResult(`A job named "${jobName}" already exists. Use a different name or remove the existing job first.`);
    }

    // Create and append the new job
    const newJob: Record<string, unknown> = {
      name: jobName,
      schedule,
      prompt,
      enabled,
      tier,
    };
    if (work_dir) newJob.work_dir = work_dir;
    if (mode === 'unleashed') {
      newJob.mode = 'unleashed';
      if (max_hours) newJob.max_hours = max_hours;
    }

    jobs.push(newJob);
    parsed.data.jobs = jobs;

    // Write back preserving body content — validate first to prevent daemon crash
    const output = matterMod.default.stringify(parsed.content, parsed.data);
    const { validateCronYaml } = await import('../gateway/heartbeat.js');
    const yamlErr = validateCronYaml(output);
    if (yamlErr) {
      logger.error({ yamlErr, jobName }, 'Generated CRON.md has invalid YAML — aborting write');
      return textResult(`Failed to add job "${jobName}": generated YAML is invalid. Error: ${yamlErr}`);
    }
    writeFileSync(CRON_FILE, output);

    logger.info({ jobName, schedule, tier, mode, work_dir }, 'Added cron job via MCP tool');

    // Read-back verification: confirm the job was persisted correctly
    let verified = false;
    try {
      const verifyRaw = readFileSync(CRON_FILE, 'utf-8');
      const verifyParsed = matterMod.default(verifyRaw);
      const verifyJobs = (verifyParsed.data.jobs ?? []) as Array<Record<string, unknown>>;
      const found = verifyJobs.find(
        (j) => String(j.name ?? '').toLowerCase() === jobName.toLowerCase(),
      );
      verified = !!found && String(found.schedule ?? '') === schedule;
    } catch {
      // Verification failed but file was written
    }

    const details = [
      `  Schedule: ${schedule}`,
      `  Prompt: ${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}`,
      `  Tier: ${tier}`,
      `  Enabled: ${enabled}`,
    ];
    if (work_dir) details.push(`  Project: ${work_dir}`);
    if (mode === 'unleashed') {
      const escalated = rawMode !== 'unleashed' ? ' (auto-escalated — complex prompt detected)' : '';
      details.push(`  Mode: unleashed (max ${max_hours ?? 6} hours)${escalated}`);
    }

    const verifyMsg = verified
      ? 'Verified: job persisted to CRON.md and will be picked up by the daemon.'
      : 'WARNING: Could not verify the job was written correctly. Check CRON.md manually.';

    const goalHint = `\n\n💡 **Goal tracking:** What goal does this cron job serve? Consider creating a persistent goal (\`goal_create\`) and linking it (\`goal_update\` with \`linkedCronJobs: ["${jobName}"]\`) so self-improvement can optimize this job against measurable outcomes.`;

    return textResult(
      `Added cron job "${jobName}":\n${details.join('\n')}\n\n${verifyMsg}${goalHint}`,
    );
  },
);


// ── Trigger Cron Job ────────────────────────────────────────────────────

const TRIGGER_DIR = path.join(BASE_DIR, 'cron', 'triggers');

server.tool(
  'trigger_cron_job',
  'Trigger an existing cron job to run immediately in the background. The daemon picks up the trigger and runs the job asynchronously — results are delivered via notifications. Use this when committing to background work (audits, research, etc.) instead of trying to do it all in the current chat turn.',
  {
    job_name: z.string().describe('Exact name of the cron job to trigger (use list_cron_jobs to see available jobs)'),
  },
  async ({ job_name }) => {
    // Verify the job exists in CRON.md
    const cronPath = path.join(SYSTEM_DIR, 'CRON.md');
    if (!existsSync(cronPath)) {
      return textResult('No CRON.md found. Create cron jobs first with add_cron_job.');
    }

    const raw = readFileSync(cronPath, 'utf-8');
    const matterMod = await import('gray-matter');
    const { data } = matterMod.default(raw);
    const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
    const job = jobs.find((j: any) => String(j.name ?? '') === job_name);
    if (!job) {
      const available = jobs.map((j: any) => String(j.name ?? '')).filter(Boolean).join(', ');
      return textResult(`Job "${job_name}" not found. Available: ${available || 'none'}`);
    }

    // Write trigger file for the daemon to pick up
    mkdirSync(TRIGGER_DIR, { recursive: true });
    const triggerFile = path.join(TRIGGER_DIR, `${Date.now()}-${job_name.replace(/[^a-zA-Z0-9_-]/g, '_')}.trigger`);
    writeFileSync(triggerFile, job_name, 'utf-8');

    return textResult(
      `Triggered "${job_name}" — the daemon will pick it up within a few seconds and run it in the background. ` +
      `Results will be delivered via notifications when complete.`,
    );
  },
);


// ── Workflow Tools ──────────────────────────────────────────────────────

const WORKFLOWS_DIR = path.join(SYSTEM_DIR, 'workflows');

server.tool(
  'workflow_list',
  'List all multi-step workflows with name, description, step count, trigger, and enabled status.',
  { _empty: z.string().optional().describe('(no parameters needed)') },
  async () => {
    if (!existsSync(WORKFLOWS_DIR)) {
      return textResult('No workflows directory found. Create `vault/00-System/workflows/` and add workflow .md files.');
    }

    const { parseAllWorkflows } = await import('../agent/workflow-runner.js');
    const workflows = parseAllWorkflows(WORKFLOWS_DIR);

    if (workflows.length === 0) {
      return textResult('No workflow files found in `vault/00-System/workflows/`.');
    }

    const lines: string[] = [];
    for (const wf of workflows) {
      const status = wf.enabled ? 'enabled' : 'disabled';
      const trigger = wf.trigger.schedule ? `schedule: \`${wf.trigger.schedule}\`` : 'manual only';
      lines.push(
        `**${wf.name}** [${status}]` +
        `\n  ${wf.description || '(no description)'}` +
        `\n  Trigger: ${trigger}` +
        `\n  Steps (${wf.steps.length}): ${wf.steps.map(s => s.id).join(' → ')}` +
        (Object.keys(wf.inputs).length > 0
          ? `\n  Inputs: ${Object.entries(wf.inputs).map(([k, v]) => `${k}${v.default ? `="${v.default}"` : ''}`).join(', ')}`
          : ''),
      );
    }

    return textResult(lines.join('\n\n'));
  },
);

server.tool(
  'workflow_create',
  'Create a new multi-step workflow file. Validates dependencies and writes to vault/00-System/workflows/. The daemon auto-reloads on file change.',
  {
    name: z.string().describe('Workflow name (used as filename and identifier)'),
    description: z.string().describe('What the workflow does'),
    steps: z.array(z.object({
      id: z.string().describe('Unique step identifier'),
      prompt: z.string().describe('Prompt for the step (supports {{input.*}}, {{steps.*.output}}, {{date}} variables)'),
      dependsOn: z.array(z.string()).default([]).describe('Step IDs this depends on'),
      model: z.string().optional().describe('Model tier: haiku or sonnet'),
      tier: z.number().optional().default(1).describe('Security tier (1-3)'),
      maxTurns: z.number().optional().default(15).describe('Max agent turns'),
    })).describe('Workflow steps'),
    trigger_schedule: z.string().optional().describe('Cron expression for scheduled trigger'),
    inputs: z.record(z.string(), z.object({
      type: z.enum(['string', 'number']).default('string'),
      default: z.string().optional(),
      description: z.string().optional(),
    })).optional().default({}).describe('Input parameters with optional defaults'),
    synthesis_prompt: z.string().optional().describe('Prompt to synthesize final output from all step results'),
  },
  async ({ name, description, steps, trigger_schedule, inputs, synthesis_prompt }) => {
    // Validate step IDs are unique
    const ids = new Set(steps.map(s => s.id));
    if (ids.size !== steps.length) {
      return textResult('Error: Duplicate step IDs found.');
    }

    // Validate dependencies exist
    for (const step of steps) {
      for (const dep of step.dependsOn) {
        if (!ids.has(dep)) {
          return textResult(`Error: Step "${step.id}" depends on unknown step "${dep}".`);
        }
      }
    }

    // Validate cron expression if provided
    if (trigger_schedule) {
      const cronMod = await import('node-cron');
      if (!cronMod.default.validate(trigger_schedule)) {
        return textResult(`Invalid cron expression: "${trigger_schedule}".`);
      }
    }

    // Build frontmatter
    const frontmatter: Record<string, unknown> = {
      type: 'workflow',
      name,
      description,
      enabled: true,
      trigger: {
        ...(trigger_schedule ? { schedule: trigger_schedule } : {}),
        manual: true,
      },
    };

    if (Object.keys(inputs).length > 0) {
      frontmatter.inputs = inputs;
    }

    frontmatter.steps = steps.map(s => ({
      id: s.id,
      prompt: s.prompt,
      dependsOn: s.dependsOn,
      ...(s.model ? { model: s.model } : {}),
      ...(s.tier && s.tier !== 1 ? { tier: s.tier } : {}),
      ...(s.maxTurns && s.maxTurns !== 15 ? { maxTurns: s.maxTurns } : {}),
    }));

    if (synthesis_prompt) {
      frontmatter.synthesis = { prompt: synthesis_prompt };
    }

    // Write file
    if (!existsSync(WORKFLOWS_DIR)) {
      mkdirSync(WORKFLOWS_DIR, { recursive: true });
    }

    const matterMod = await import('gray-matter');
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
    const filePath = path.join(WORKFLOWS_DIR, `${safeName}.md`);

    if (existsSync(filePath)) {
      return textResult(`Workflow file already exists: ${safeName}.md. Delete or rename it first.`);
    }

    const body = `# ${name}\n\n${description}\n`;
    const output = matterMod.default.stringify(body, frontmatter);
    writeFileSync(filePath, output);

    logger.info({ name, steps: steps.length }, 'Created workflow via MCP tool');

    const goalHint = `\n\n💡 **Goal tracking:** What goal does this workflow serve? Consider creating a persistent goal (\`goal_create\`) and linking related cron jobs so self-improvement can optimize this workflow against measurable outcomes.`;

    return textResult(
      `Created workflow "${name}" with ${steps.length} steps.\n` +
      `File: vault/00-System/workflows/${safeName}.md\n` +
      `Steps: ${steps.map(s => s.id).join(' → ')}\n` +
      (trigger_schedule ? `Schedule: ${trigger_schedule}\n` : 'Trigger: manual\n') +
      'The daemon will auto-detect it via file watcher.' +
      goalHint,
    );
  },
);

server.tool(
  'workflow_run',
  'Trigger a workflow by name with optional input overrides. Returns the workflow result.',
  {
    name: z.string().describe('Workflow name'),
    inputs: z.record(z.string(), z.string()).optional().default({}).describe('Input overrides (key=value pairs)'),
  },
  async ({ name: workflowName, inputs }) => {
    const { parseAllWorkflows } = await import('../agent/workflow-runner.js');
    const { WorkflowRunner } = await import('../agent/workflow-runner.js');

    const workflows = parseAllWorkflows(WORKFLOWS_DIR);
    const wf = workflows.find(w => w.name === workflowName);
    if (!wf) {
      const available = workflows.map(w => w.name).join(', ');
      return textResult(`Workflow "${workflowName}" not found. Available: ${available || 'none'}`);
    }

    if (!wf.enabled) {
      return textResult(`Workflow "${workflowName}" is disabled.`);
    }

    // Build a minimal assistant for standalone MCP execution
    // In daemon mode, the CronScheduler.runWorkflow() path is preferred
    // For MCP standalone, we need to create an assistant instance
    try {
      const { PersonalAssistant } = await import('../agent/assistant.js');

      const assistant = new PersonalAssistant();
      const runner = new WorkflowRunner(assistant);

      const result = await runner.run(wf, inputs as Record<string, string>);
      return textResult(
        `**Workflow: ${workflowName}** — ${result.status}\n\n${result.output.slice(0, 3000)}`,
      );
    } catch (err) {
      logger.error({ err, workflow: workflowName }, 'Workflow execution failed');
      return textResult(`Workflow "${workflowName}" failed: ${err instanceof Error ? err.message : err}`);
    }
  },
);


// ── Analyze Image ───────────────────────────────────────────────────────

server.tool(
  'analyze_image',
  'Analyze an image by URL. Fetches the image, converts to base64, and uses Claude vision to describe it. Works with any image URL — channel attachments, email attachments, web images.',
  {
    url: z.string().describe('URL of the image to analyze'),
    question: z.string().optional().default('Describe this image in detail.').describe('Specific question about the image'),
  },
  async ({ url, question }) => {
    try {
      // Fetch the image (include auth headers for Slack URLs)
      const headers: Record<string, string> = {};
      if (url.includes('slack.com') || url.includes('slack-files.com')) {
        const slackToken = env['SLACK_BOT_TOKEN'] ?? '';
        if (slackToken) {
          headers['Authorization'] = `Bearer ${slackToken}`;
        }
      }

      const response = await fetch(url, { headers });
      if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);

      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      const contentType = response.headers.get('content-type') || 'image/jpeg';

      // Validate it's an image
      if (!contentType.startsWith('image/')) {
        return textResult(`URL does not point to an image (content-type: ${contentType})`);
      }

      // Call Anthropic Messages API with vision
      const anthropic = new Anthropic({
        apiKey: env['ANTHROPIC_API_KEY'] || process.env.ANTHROPIC_API_KEY,
      });
      const result = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: contentType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: base64 },
            },
            { type: 'text', text: question },
          ],
        }],
      });

      const description = result.content.map(b => b.type === 'text' ? b.text : '').join('');
      return textResult(description);
    } catch (err: any) {
      return textResult(`Image analysis failed: ${err.message}`);
    }
  },
);


// ── Feedback: feedback_log ──────────────────────────────────────────────

server.tool(
  'feedback_log',
  'Record verbal feedback from the owner about a response quality.',
  {
    rating: z.enum(['positive', 'negative', 'mixed']).describe('Feedback rating'),
    comment: z.string().optional().describe('Additional context about the feedback'),
    messageContext: z.string().optional().describe('What the feedback is about'),
  },
  async ({ rating, comment, messageContext }) => {
    const store = await getStore();
    store.logFeedback({
      channel: 'verbal',
      rating,
      comment: comment ?? undefined,
      messageSnippet: messageContext ?? undefined,
    });
    return textResult(`Feedback recorded: ${rating}${comment ? ` — ${comment}` : ''}`);
  },
);


// ── Feedback: feedback_report ───────────────────────────────────────────

server.tool(
  'feedback_report',
  'Show feedback statistics and recent entries.',
  {
    limit: z.number().optional().default(10).describe('Number of recent entries'),
  },
  async ({ limit }) => {
    const store = await getStore();
    const stats = store.getFeedbackStats();
    const recent = store.getRecentFeedback(limit);
    const statsLine = `Stats: ${stats.positive} positive, ${stats.negative} negative, ${stats.mixed} mixed (${stats.total} total)`;
    if (recent.length === 0) {
      return textResult(`${statsLine}\n\nNo feedback entries yet.`);
    }
    const entries = recent.map((f, i) =>
      `${i + 1}. [${f.rating}] ${f.createdAt} via ${f.channel}${f.comment ? `: ${f.comment}` : ''}${f.responseSnippet ? `\n   Response: "${f.responseSnippet.slice(0, 100)}"` : ''}`
    ).join('\n');
    return textResult(`${statsLine}\n\nRecent:\n${entries}`);
  },
);


// ── Dynamic Tool Creation ───────────────────────────────────────────────

server.tool(
  'create_tool',
  'Create a new reusable tool script that becomes available as an MCP tool after daemon restart. Write bash or python scripts that automate recurring tasks.',
  {
    name: z.string().describe('Tool name (lowercase, underscores). Will be the MCP tool name.'),
    description: z.string().describe('What this tool does (shown in tool list)'),
    language: z.enum(['bash', 'python']).describe('Script language'),
    code: z.string().describe('The script code. First line should be the shebang (#!/bin/bash or #!/usr/bin/env python3)'),
    args_description: z.string().optional().describe('Description of expected arguments'),
  },
  async ({ name, description, language, code, args_description }) => {
    const toolsDir = path.join(BASE_DIR, 'tools');
    if (!existsSync(toolsDir)) mkdirSync(toolsDir, { recursive: true });

    const safeName = name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const ext = language === 'python' ? '.py' : '.sh';
    const filePath = path.join(toolsDir, `${safeName}${ext}`);

    // Prepend description as comment + shebang if not present
    let scriptContent = code;
    const shebang = language === 'python' ? '#!/usr/bin/env python3' : '#!/bin/bash';
    if (!scriptContent.startsWith('#!')) {
      scriptContent = `${shebang}\n# ${description}\n${scriptContent}`;
    } else if (!scriptContent.includes(description)) {
      // Add description after shebang
      const lines = scriptContent.split('\n');
      lines.splice(1, 0, `# ${description}`);
      scriptContent = lines.join('\n');
    }

    writeFileSync(filePath, scriptContent, { mode: 0o755 });

    // Write metadata file for richer registration
    writeFileSync(filePath + '.meta.json', JSON.stringify({
      name: safeName,
      description,
      language,
      args_description: args_description ?? '',
      createdAt: new Date().toISOString(),
    }, null, 2));

    // Hot-register: make the tool available immediately without restart
    try {
      server.tool(safeName, description, { args: z.string().optional().describe(args_description ?? 'Optional arguments') }, async ({ args }) => {
        const { execSync: execTool } = await import('node:child_process');
        try {
          const result = execTool(`"${filePath}" ${args || ''}`, {
            encoding: 'utf-8',
            timeout: 30000,
            cwd: BASE_DIR,
            env: { ...process.env, CLEMENTINE_HOME: BASE_DIR },
          });
          return textResult(result.trim() || '(no output)');
        } catch (err: any) {
          return textResult(`Tool error: ${err.stderr || err.message || String(err)}`.slice(0, 500));
        }
      });
      return textResult(
        `Tool "${safeName}" created and registered — available immediately.\n` +
        `Saved to ~/.clementine/tools/${safeName}${ext}\n` +
        (args_description ? `Args: ${args_description}` : ''),
      );
    } catch {
      return textResult(
        `Tool "${safeName}" created at ~/.clementine/tools/${safeName}${ext}\n` +
        `It will be available after daemon restart.\n` +
        (args_description ? `Args: ${args_description}` : ''),
      );
    }
  },
);


// ── Self-Restart ────────────────────────────────────────────────────────

server.tool(
  'self_restart',
  'Restart the Clementine daemon to pick up code changes. Sends SIGUSR1 to the running process, which triggers a graceful restart.',
  { _empty: z.string().optional().describe('(no parameters needed)') },
  async () => {
    const pidFile = path.join(BASE_DIR, `.${(env['ASSISTANT_NAME'] ?? 'clementine').toLowerCase()}.pid`);
    if (!existsSync(pidFile)) {
      return textResult('No PID file found — daemon may not be running.');
    }
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    if (isNaN(pid)) {
      return textResult('Invalid PID file.');
    }
    try {
      process.kill(pid, 0); // check if alive
    } catch {
      return textResult(`Process ${pid} is not running.`);
    }
    process.kill(pid, 'SIGUSR1');
    return textResult(`Restart signal (SIGUSR1) sent to PID ${pid}. Daemon will restart momentarily.`);
  },
);


// ── Self-Improvement Tools ───────────────────────────────────────────

server.tool(
  'self_improve_status',
  'Check the self-improvement system status: current state, pending approvals, baseline metrics, and recent experiment history.',
  { _empty: z.string().optional().describe('(no parameters needed)') },
  async () => {
    const siDir = path.join(BASE_DIR, 'self-improve');
    const stateFile = path.join(siDir, 'state.json');
    const logFile = path.join(siDir, 'experiment-log.jsonl');
    const pendingDir = path.join(siDir, 'pending-changes');

    let status = 'No self-improvement data found.';

    if (existsSync(stateFile)) {
      const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
      const m = state.baselineMetrics ?? {};
      status = `**Self-Improvement Status**\n` +
        `Status: ${state.status}\n` +
        `Last run: ${state.lastRunAt || 'never'}\n` +
        `Total experiments: ${state.totalExperiments}\n` +
        `Pending approvals: ${state.pendingApprovals}\n` +
        `Baseline — Feedback: ${((m.feedbackPositiveRatio ?? 0) * 100).toFixed(0)}% positive, ` +
        `Cron: ${((m.cronSuccessRate ?? 0) * 100).toFixed(0)}% success`;
    }

    if (existsSync(logFile)) {
      const lines = readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean);
      const recent = lines.slice(-5).reverse().map(l => {
        const e = JSON.parse(l);
        return `#${e.iteration} | ${e.area} | "${(e.hypothesis ?? '').slice(0, 40)}" | ` +
          `${((e.score ?? 0) * 10).toFixed(1)}/10 ${e.accepted ? '✅' : '❌'}`;
      });
      if (recent.length > 0) {
        status += `\n\n**Recent Experiments:**\n${recent.join('\n')}`;
      }
    }

    if (existsSync(pendingDir)) {
      const pending = readdirSync(pendingDir).filter(f => f.endsWith('.json'));
      if (pending.length > 0) {
        const details = pending.map(f => {
          const p = JSON.parse(readFileSync(path.join(pendingDir, f), 'utf-8'));
          return `- **${p.id}** | ${p.area} → ${p.target}: ${(p.hypothesis ?? '').slice(0, 80)}`;
        });
        status += `\n\n**Pending Proposals:**\n${details.join('\n')}`;
      }
    }

    return textResult(status);
  },
);

server.tool(
  'self_improve_run',
  'Trigger a self-improvement analysis cycle. This evaluates recent performance data and proposes improvements to system prompts, cron jobs, and workflows. Normally runs nightly via cron.',
  { _empty: z.string().optional().describe('(no parameters needed)') },
  async () => {
    return textResult(
      'Self-improvement cycle should be triggered via the CLI (`clementine self-improve run`) ' +
      'or Discord (`!self-improve run` / `/self-improve run`). ' +
      'The MCP server cannot directly run the loop as it requires the full assistant context.',
    );
  },
);


// ── Source Self-Edit Tools ──────────────────────────────────────────────

const SELF_IMPROVE_DIR = path.join(BASE_DIR, 'self-improve');
const PENDING_SOURCE_DIR = path.join(SELF_IMPROVE_DIR, 'pending-source-changes');

server.tool(
  'self_edit_source',
  'Edit most Clementine TypeScript source files (for new features or bug fixes). Validates in a staging worktree, compiles, and triggers restart on success. Blocked files: `src/config.ts`, `src/gateway/security-scanner.ts`, `src/security/scanner.ts`. Do NOT use this tool to change user-tunable settings (budget caps, model tier, heartbeat interval, timezone, channel IDs, etc.) — those live in `~/.clementine/.env` and are managed by the user via `clementine config set KEY value`, which survives `clementine update` / `npm update -g`.',
  {
    file: z.string().describe('Path relative to src/ (e.g., "channels/discord-agent-bot.ts")'),
    content: z.string().describe('Complete new file content'),
    reason: z.string().describe('Why this change is being made'),
  },
  async ({ file, content, reason }) => {
    // Security blocklist
    const BLOCKLIST = ['config.ts', 'gateway/security-scanner.ts', 'security/scanner.ts'];
    if (BLOCKLIST.some(b => file === b || file.startsWith(b))) {
      return textResult(`Blocked: ${file} is on the security blocklist and cannot be self-edited.`);
    }

    // Write pending change for the daemon to pick up
    if (!existsSync(PENDING_SOURCE_DIR)) {
      mkdirSync(PENDING_SOURCE_DIR, { recursive: true });
    }

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const pending = {
      id,
      file: `src/${file}`,
      content,
      reason,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(
      path.join(PENDING_SOURCE_DIR, `${id}.json`),
      JSON.stringify(pending, null, 2),
    );

    // Also signal the daemon via a file it watches
    const signalFile = path.join(BASE_DIR, '.pending-source-edit');
    writeFileSync(signalFile, JSON.stringify({ id, file: `src/${file}`, reason }));

    return textResult(
      `Source edit queued (id: ${id}).\n` +
      `File: src/${file}\n` +
      `Reason: ${reason}\n\n` +
      `The daemon will validate in a staging worktree, then commit + build + restart if compilation succeeds.`,
    );
  },
);

server.tool(
  'update_self',
  'Check for and apply upstream code updates. Can check without applying, or check and apply in one step.',
  {
    action: z.enum(['check', 'apply']).describe('"check" to see if updates are available, "apply" to pull and restart'),
  },
  async ({ action }) => {
    const __mcp_dirname = path.dirname(fileURLToPath(import.meta.url));
    const pkgDir = path.resolve(__mcp_dirname, '..', '..');

    if (action === 'check') {
      try {
        execSync('git fetch origin main --quiet', { cwd: pkgDir, stdio: 'pipe', timeout: 30_000 });
        const countStr = execSync('git rev-list HEAD..origin/main --count', {
          cwd: pkgDir, encoding: 'utf-8',
        }).trim();
        const count = parseInt(countStr, 10) || 0;

        if (count === 0) {
          return textResult('Already up to date. No new commits on origin/main.');
        }

        const summary = execSync('git log HEAD..origin/main --oneline', {
          cwd: pkgDir, encoding: 'utf-8',
        }).trim();

        return textResult(`${count} update(s) available:\n${summary}\n\nUse update_self with action="apply" to install.`);
      } catch (err) {
        return textResult(`Update check failed: ${String(err)}`);
      }
    }

    // action === 'apply' — write a signal file for the daemon
    const signalFile = path.join(BASE_DIR, '.pending-update');
    writeFileSync(signalFile, JSON.stringify({ requestedAt: new Date().toISOString() }));

    return textResult(
      'Update requested. The daemon will:\n' +
      '1. Fetch and pull origin/main\n' +
      '2. Rebase self-edits if any\n' +
      '3. Rebuild and restart\n\n' +
      'You will be notified when the restart completes.',
    );
  },
);


// ── Cron Progress Continuity ────────────────────────────────────────────

const CRON_PROGRESS_DIR = path.join(BASE_DIR, 'cron', 'progress');

function ensureCronProgressDir(): void {
  if (!existsSync(CRON_PROGRESS_DIR)) mkdirSync(CRON_PROGRESS_DIR, { recursive: true });
}

function safeJobName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

server.tool(
  'cron_progress_read',
  'Read progress state from a previous cron job run. Returns what was completed, what is pending, and free-form notes from the last run.',
  {
    job_name: z.string().describe('Cron job name'),
  },
  async ({ job_name }) => {
    ensureCronProgressDir();
    const filePath = path.join(CRON_PROGRESS_DIR, `${safeJobName(job_name)}.json`);
    if (!existsSync(filePath)) {
      return textResult(`No previous progress found for job "${job_name}". This is a fresh run.`);
    }
    try {
      const progress = JSON.parse(readFileSync(filePath, 'utf-8'));
      const lines = [
        `## Progress for "${job_name}"`,
        `**Last run:** ${progress.lastRunAt} | **Run count:** ${progress.runCount}`,
      ];
      if (progress.completedItems?.length > 0) {
        lines.push(`\n### Completed\n${progress.completedItems.map((i: string) => `- ${i}`).join('\n')}`);
      }
      if (progress.pendingItems?.length > 0) {
        lines.push(`\n### Pending\n${progress.pendingItems.map((i: string) => `- [ ] ${i}`).join('\n')}`);
      }
      if (progress.notes) {
        lines.push(`\n### Notes\n${progress.notes}`);
      }
      if (progress.state && Object.keys(progress.state).length > 0) {
        lines.push(`\n### Custom State\n\`\`\`json\n${JSON.stringify(progress.state, null, 2)}\n\`\`\``);
      }
      return textResult(lines.join('\n'));
    } catch {
      return textResult(`Error reading progress for "${job_name}".`);
    }
  },
);

server.tool(
  'cron_progress_write',
  'Save progress state for a cron job so the next run can continue where this one left off. Call this at the end of a cron job run.',
  {
    job_name: z.string().describe('Cron job name'),
    completedItems: z.array(z.string()).optional().describe('Items completed in this run'),
    pendingItems: z.array(z.string()).optional().describe('Items still pending for next run'),
    notes: z.string().optional().describe('Free-form observations or notes'),
    state: z.record(z.string(), z.unknown()).optional().describe('Custom key-value state to persist'),
  },
  async ({ job_name, completedItems, pendingItems, notes, state }) => {
    ensureCronProgressDir();
    const filePath = path.join(CRON_PROGRESS_DIR, `${safeJobName(job_name)}.json`);

    // Merge with existing progress
    let existing: any = { jobName: job_name, lastRunAt: '', runCount: 0, state: {}, completedItems: [], pendingItems: [], notes: '' };
    if (existsSync(filePath)) {
      try { existing = JSON.parse(readFileSync(filePath, 'utf-8')); } catch { /* start fresh */ }
    }

    const updated = {
      jobName: job_name,
      lastRunAt: new Date().toISOString(),
      runCount: (existing.runCount || 0) + 1,
      state: state ?? existing.state ?? {},
      completedItems: completedItems
        ? [...(existing.completedItems || []), ...completedItems]
        : existing.completedItems || [],
      pendingItems: pendingItems ?? existing.pendingItems ?? [],
      notes: notes ?? existing.notes ?? '',
    };

    writeFileSync(filePath, JSON.stringify(updated, null, 2));
    logger.info({ jobName: job_name, runCount: updated.runCount }, 'Cron progress saved');
    return textResult(`Progress saved for "${job_name}" (run #${updated.runCount}). ${(completedItems?.length ?? 0)} items completed, ${(updated.pendingItems?.length ?? 0)} pending.`);
  },
);


}
