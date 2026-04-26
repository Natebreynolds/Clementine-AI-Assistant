/**
 * Prompt Overrides — loader.
 *
 * Reads markdown files from ~/.clementine/prompt-overrides/ and serves
 * scope-resolved override text for a given (jobName, agentSlug). Hot-reloads
 * via fs.watch (debounced).
 *
 * No package builtins — these are purely user/LLM authored. The directory
 * is created on first load so users have an obvious empty home for overrides.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, watch as fsWatch } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import matter from 'gray-matter';

import { BASE_DIR } from '../../config.js';
import type { PromptOverride, PromptOverrideFrontmatter } from './types.js';

const logger = pino({ name: 'clementine.prompt-overrides' });

// ── Paths ────────────────────────────────────────────────────────────

export interface LoaderOptions {
  baseDir?: string;
}

function rootDir(baseDir: string): string {
  return path.join(baseDir, 'prompt-overrides');
}

// ── State ────────────────────────────────────────────────────────────

let cached: PromptOverride[] = [];
let watcherInstalled = false;
let watchDebounce: NodeJS.Timeout | null = null;

// ── Parse one file ───────────────────────────────────────────────────

function parseOverride(
  filePath: string,
  scope: PromptOverride['scope'],
  scopeKey: string | null,
): PromptOverride | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = matter(raw);
    const fm = (parsed.data ?? {}) as PromptOverrideFrontmatter;
    const body = parsed.content.trim();
    if (!body) return null;
    const defaultPriority =
      scope === 'global' ? 10 :
      scope === 'agent' ? 50 :
      100;
    return {
      body,
      priority: typeof fm.priority === 'number' ? fm.priority : defaultPriority,
      sourcePath: filePath,
      scope,
      scopeKey,
    };
  } catch (err) {
    logger.warn({ err, filePath }, 'Failed to parse prompt override — skipping');
    return null;
  }
}

function readMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => path.join(dir, f));
}

// ── Loader ───────────────────────────────────────────────────────────

export function loadPromptOverrides(opts?: LoaderOptions): PromptOverride[] {
  const baseDir = opts?.baseDir ?? BASE_DIR;
  const root = rootDir(baseDir);
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
  }
  const out: PromptOverride[] = [];

  // _global.md (or any *.md) at root with bare name "_global"
  const globalPath = path.join(root, '_global.md');
  if (existsSync(globalPath)) {
    const o = parseOverride(globalPath, 'global', null);
    if (o) out.push(o);
  }

  // agents/<slug>.md
  for (const f of readMarkdownFiles(path.join(root, 'agents'))) {
    const slug = path.basename(f, '.md');
    const o = parseOverride(f, 'agent', slug);
    if (o) out.push(o);
  }

  // jobs/<jobName>.md
  for (const f of readMarkdownFiles(path.join(root, 'jobs'))) {
    const jobName = path.basename(f, '.md');
    const o = parseOverride(f, 'job', jobName);
    if (o) out.push(o);
  }

  cached = out;
  logger.info(
    { total: out.length, global: out.filter(o => o.scope === 'global').length, agent: out.filter(o => o.scope === 'agent').length, job: out.filter(o => o.scope === 'job').length },
    'Prompt overrides loaded',
  );
  return out;
}

export function getLoadedOverrides(): PromptOverride[] {
  return cached;
}

/**
 * Resolve overrides applicable to a given job: global + agent (if agentSlug
 * matches) + job (if jobName matches), sorted by priority ascending and
 * concatenated into a single string. Empty if no overrides apply.
 */
export function loadPromptOverridesForJob(
  jobName: string,
  agentSlug?: string,
  opts?: LoaderOptions,
): string {
  // Use cached if loaded, else load fresh.
  if (cached.length === 0) {
    loadPromptOverrides(opts);
  }
  const applicable = cached.filter(o => {
    if (o.scope === 'global') return true;
    if (o.scope === 'agent') return agentSlug != null && o.scopeKey === agentSlug;
    if (o.scope === 'job') return o.scopeKey === jobName;
    return false;
  });
  if (applicable.length === 0) return '';
  applicable.sort((a, b) => a.priority - b.priority);
  return applicable.map(o => o.body).join('\n\n');
}

/** Install fs.watch on the overrides directory tree. Safe to call multiple times. */
export function watchPromptOverrides(opts?: LoaderOptions): void {
  if (watcherInstalled) return;
  const baseDir = opts?.baseDir ?? BASE_DIR;
  const root = rootDir(baseDir);
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
  }
  // Pre-create subdirs so fs.watch picks up future changes
  for (const sub of ['agents', 'jobs']) {
    const p = path.join(root, sub);
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
  }
  try {
    fsWatch(root, { recursive: true }, () => {
      if (watchDebounce) clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => {
        try {
          loadPromptOverrides(opts);
        } catch (err) {
          logger.warn({ err }, 'Hot reload failed — keeping previous overrides');
        }
      }, 250);
    });
    watcherInstalled = true;
    logger.debug({ root }, 'Watching prompt-overrides for hot reload');
  } catch (err) {
    logger.warn({ err }, 'Failed to install prompt-overrides watcher — hot reload disabled');
  }
}

/** Test-only: clear cached state. */
export function _resetLoaderState(): void {
  cached = [];
  watcherInstalled = false;
  if (watchDebounce) {
    clearTimeout(watchDebounce);
    watchDebounce = null;
  }
}
