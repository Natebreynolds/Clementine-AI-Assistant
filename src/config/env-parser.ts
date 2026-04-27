/**
 * Shared parser for `.env`-style files.
 *
 * Phase 14 cleanup: this logic was previously duplicated in 4+ places
 * (src/config.ts, src/tools/shared.ts, src/config/effective-config.ts,
 * src/vault-migrations/0005-create-clementine-json.ts). All implementations
 * were identical line-for-line; consolidating here avoids future drift.
 *
 * Each caller still wraps this with its own file-read since the path
 * varies (BASE_DIR-relative vs explicit baseDir param vs lazy/cached).
 *
 * Format:
 *   KEY=value             — bare value
 *   KEY="value"           — double-quoted; quotes stripped
 *   KEY='value'           — single-quoted; quotes stripped
 *   # comment             — ignored
 *   <blank line>          — ignored
 *   malformed lines       — silently skipped (no `=` separator)
 */

export function parseEnvText(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex);
    let value = trimmed.slice(eqIndex + 1);
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/**
 * POSIX shell single-quote escape. Used by every keychain shell-out site.
 * Phase 14 cleanup: was duplicated in src/config.ts and
 * src/config/effective-config.ts.
 */
export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
