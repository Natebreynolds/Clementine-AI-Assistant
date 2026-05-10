/**
 * PRD §6 Phase 4d / 1.18.102 — Path B installer.
 *
 * Drops a `.claude/settings.local.json` into a project's cwd that registers
 * the SDK's command-type hooks to POST events at the dashboard's
 * /api/hooks/event endpoint. The installer is opt-in per task — the user
 * clicks "Enable hooks" on the task card after they've decided they want
 * real per-tool latency.
 *
 * Why settings.local.json (not settings.json):
 * - The SDK's `setting_sources=['project','local']` reads both. We use
 *   the 'local' source so we never touch the user's hand-written
 *   settings.json. settings.local.json is conventionally gitignored —
 *   our hooks are per-machine config (they reference a localhost dashboard
 *   token), not source-controllable.
 * - A future "disable hooks" path can rm the file without affecting any
 *   hand-written project settings.
 *
 * Auth: the hook commands include the dashboard token in the X-Dashboard-Token
 * header. As of 1.18.151 the token is read from disk at fire-time via
 * `$(cat ~/.clementine/.dashboard-token)` instead of being baked into the
 * curl command at install time. The token-file path is interpolated at
 * install time, but its CONTENT is read on every hook fire — so dashboard
 * token rotation (which `clementine update restart` does) no longer breaks
 * installed hooks. The dashboard already maintains this file at startup
 * (dashboard.ts:2097-2098); we just point the curl at it.
 *
 * The cost is one tiny `cat` syscall per tool call — negligible compared to
 * the curl + dashboard ingestion already happening. The win is no more
 * silent 401s when the token rotates.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Hooks we install. Picked for the latency dashboard's needs:
 *  PreToolUse + PostToolUse give us tool durations (PostToolUse carries
 *  duration_ms). SubagentStart/Stop close the gap path C handles via
 *  transcript backfill. Stop / Notification add nice-to-have signal but
 *  are minimal cost. PreCompact + PostCompact (added 1.18.151) carry
 *  compaction telemetry — pre/post tokens, summary text, trigger source —
 *  which the run-detail viewer surfaces as "what got summarized away". */
const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'Notification',
  'UserPromptSubmit',
  'SessionStart',
  'PreCompact',
  'PostCompact',
] as const;

/** Bumped on every meaningful template change. Heartbeat reads installed
 *  files' `_clementine.installerVersion` and surfaces a re-install nudge
 *  when it lags this constant — see heartbeat.ts (1.18.151 stale-template
 *  detector). We never overwrite user-facing files silently; the user runs
 *  `clementine hooks install` to opt into the new template. */
export const CURRENT_INSTALLER_VERSION = '1.18.151';

/** Default location of the dashboard token file. The dashboard writes this
 *  on every startup (see dashboard.ts:2097-2098). Hooks read it at fire
 *  time via `$(cat …)` so token rotations propagate without re-installing. */
const DEFAULT_TOKEN_FILE = path.join(os.homedir(), '.clementine', '.dashboard-token');

export interface SettingsTemplateOptions {
  /** Localhost port the dashboard is listening on. Defaults to 3030. */
  port?: number;
  /** Mark the file with a comment so users know who wrote it. */
  installerVersion?: string;
  /** Absolute path to the token file the curl will `cat` at fire time.
   *  Override is for tests; production always uses the canonical
   *  ~/.clementine/.dashboard-token. */
  tokenFilePath?: string;
}

/** Build the JSON content of .claude/settings.local.json. The shape matches
 *  the SDK's hook config schema: a top-level `hooks` map keyed by event name,
 *  each value an array of `{ hooks: [{ type, command }] }` matchers. The
 *  empty matcher means "always fire". */
export function buildSettingsTemplate(opts: SettingsTemplateOptions = {}): Record<string, unknown> {
  const port = opts.port ?? 3030;
  const tokenFile = opts.tokenFilePath ?? DEFAULT_TOKEN_FILE;
  // Use POSIX `curl` — preinstalled on macOS and most Linuxes; Windows users
  // running WSL or Git Bash also have it. We add `--max-time 2` so a
  // wedged dashboard can't stall the SDK's tool execution. The
  // `$(cat … 2>/dev/null)` substitution reads the live dashboard token at
  // fire time; if the file is briefly missing during startup the curl
  // sends an empty token and the dashboard 401s harmlessly (no SDK break).
  const curlCmd = `curl -s --max-time 2 -X POST `
    + `-H "X-Dashboard-Token: $(cat ${tokenFile} 2>/dev/null)" `
    + `-H "Content-Type: application/json" `
    + `--data-binary @- `
    + `http://127.0.0.1:${port}/api/hooks/event`;

  const hooks: Record<string, Array<unknown>> = {};
  for (const eventName of HOOK_EVENTS) {
    hooks[eventName] = [
      {
        // Empty matcher fires for every event; the dashboard endpoint
        // can later expose a UI for restricting to specific tool names.
        hooks: [{ type: 'command', command: curlCmd }],
      },
    ];
  }

  return {
    // Sentinel field so we can detect (and update) installer-managed
    // settings without touching anything else in the file.
    _clementine: {
      managedBy: 'clementine-agent path-b-installer',
      installedAt: new Date().toISOString(),
      installerVersion: opts.installerVersion ?? CURRENT_INSTALLER_VERSION,
      port,
    },
    hooks,
  };
}

export interface InstallResult {
  ok: boolean;
  filePath: string;
  /** Whether the file existed before this call. */
  wasExisting: boolean;
  /** Whether we replaced an existing installer-managed file vs writing fresh. */
  wasUpdate: boolean;
  /** Set when ok=false. */
  error?: string;
}

/** Write/update .claude/settings.local.json in `workDir`. If the file
 *  already exists and is NOT installer-managed (no _clementine key), we
 *  bail out and refuse to overwrite to avoid clobbering user content.
 *
 *  As of 1.18.151 no token is required at install time — the curl reads
 *  the live token from disk at fire time. Callers can pass tokenFilePath
 *  to override the default `~/.clementine/.dashboard-token` (tests). */
export function installPathBHooks(workDir: string, opts: SettingsTemplateOptions = {}): InstallResult {
  if (!workDir) return { ok: false, filePath: '', wasExisting: false, wasUpdate: false, error: 'workDir required' };

  const dir = path.join(workDir, '.claude');
  const file = path.join(dir, 'settings.local.json');
  let wasExisting = false;
  let wasUpdate = false;

  if (existsSync(file)) {
    wasExisting = true;
    try {
      const raw = readFileSync(file, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // Only proceed if the file was previously installed by us.
      if (!parsed._clementine || typeof parsed._clementine !== 'object') {
        return {
          ok: false,
          filePath: file,
          wasExisting: true,
          wasUpdate: false,
          error: 'settings.local.json exists but was not created by clementine — refusing to overwrite. Move or delete the file and retry.',
        };
      }
      wasUpdate = true;
    } catch (err) {
      return {
        ok: false,
        filePath: file,
        wasExisting: true,
        wasUpdate: false,
        error: 'could not parse existing settings.local.json: ' + String(err),
      };
    }
  }

  try {
    mkdirSync(dir, { recursive: true });
    const content = buildSettingsTemplate(opts);
    writeFileSync(file, JSON.stringify(content, null, 2) + '\n');
    return { ok: true, filePath: file, wasExisting, wasUpdate };
  } catch (err) {
    return {
      ok: false,
      filePath: file,
      wasExisting,
      wasUpdate,
      error: 'failed to write settings.local.json: ' + String(err),
    };
  }
}

export interface HooksStatus {
  /** Whether a settings.local.json exists in the workDir. */
  installed: boolean;
  /** Whether the file is one we wrote (has _clementine sentinel). */
  managedByUs: boolean;
  /** Resolved path we checked (helpful for diagnostic toasts). */
  filePath: string;
  /** When we installed it (ISO). null if not managed by us. */
  installedAt?: string;
  /** Installer version that wrote it. null if not managed by us. */
  installerVersion?: string;
  /** True if the file exists but came from somewhere else (user). */
  conflictsWithUser: boolean;
}

/** Inspect a workDir's hook installation state. Used by the dashboard's
 *  task card to decide whether to render "Enable hooks" or "Hooks: on". */
export function getHooksStatus(workDir: string): HooksStatus {
  const filePath = path.join(workDir, '.claude', 'settings.local.json');
  if (!existsSync(filePath)) {
    return { installed: false, managedByUs: false, filePath, conflictsWithUser: false };
  }
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const sentinel = parsed._clementine as { installedAt?: string; installerVersion?: string } | undefined;
    if (sentinel && typeof sentinel === 'object') {
      return {
        installed: true,
        managedByUs: true,
        filePath,
        installedAt: sentinel.installedAt,
        installerVersion: sentinel.installerVersion,
        conflictsWithUser: false,
      };
    }
    return { installed: true, managedByUs: false, filePath, conflictsWithUser: true };
  } catch {
    // Couldn't parse — treat as a user file we shouldn't touch.
    return { installed: true, managedByUs: false, filePath, conflictsWithUser: true };
  }
}

/** Removes our installer-managed settings.local.json. Refuses if the file
 *  isn't ours (so a misclick doesn't delete user config). */
export function uninstallPathBHooks(workDir: string): { ok: boolean; error?: string } {
  const filePath = path.join(workDir, '.claude', 'settings.local.json');
  if (!existsSync(filePath)) return { ok: true };
  const status = getHooksStatus(workDir);
  if (!status.managedByUs) {
    return { ok: false, error: 'settings.local.json is not managed by clementine — refusing to delete' };
  }
  try {
    // Use unlinkSync via dynamic import to keep the static fs imports list
    // tight; this path is rarely invoked.
    const fs = require('node:fs') as typeof import('node:fs');
    fs.unlinkSync(filePath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: 'failed to remove: ' + String(err) };
  }
}
