/**
 * Clementine TypeScript — File integrity monitor (Layer 3).
 *
 * Computes SHA-256 checksums for critical vault system files and detects tampering.
 * Zero external dependencies — uses node:crypto and node:fs only.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import {
  SOUL_FILE,
  AGENTS_FILE,
  MEMORY_FILE,
  HEARTBEAT_FILE,
  CRON_FILE,
} from '../config.js';

export interface IntegrityResult {
  file: string;
  expected: string;
  actual: string;
  tampered: boolean;
}

const CRITICAL_FILES: readonly string[] = [
  SOUL_FILE,
  AGENTS_FILE,
  MEMORY_FILE,
  HEARTBEAT_FILE,
  CRON_FILE,
];

function hashFile(filePath: string): string {
  if (!existsSync(filePath)) return 'MISSING';
  const content = readFileSync(filePath, 'utf-8');
  return createHash('sha256').update(content).digest('hex');
}

export class IntegrityMonitor {
  private checksums = new Map<string, string>();
  private lastRefreshTime = 0;

  constructor() {
    this.refresh();
  }

  /** Re-baseline checksums for all critical files. */
  refresh(): void {
    for (const file of CRITICAL_FILES) {
      this.checksums.set(file, hashFile(file));
    }
    this.lastRefreshTime = Date.now();
  }

  /** Skip refresh if already refreshed within maxAgeMs. */
  refreshIfStale(maxAgeMs = 5000): void {
    if (Date.now() - this.lastRefreshTime < maxAgeMs) return;
    this.refresh();
  }

  /** Check all critical files against stored checksums. */
  check(): IntegrityResult[] {
    const results: IntegrityResult[] = [];
    for (const file of CRITICAL_FILES) {
      const expected = this.checksums.get(file) ?? 'UNKNOWN';
      const actual = hashFile(file);
      results.push({
        file,
        expected,
        actual,
        tampered: expected !== actual,
      });
    }
    return results;
  }
}
