/**
 * SessionStore adapter: mirrors the Claude Agent SDK's JSONL session
 * transcript into Clementine's SQLite memory store so resume works from
 * the durable store instead of local files.
 *
 * Introduced after upgrading to @anthropic-ai/claude-agent-sdk 0.2.119.
 * The SDK still writes to local disk first (durability is guaranteed
 * before our adapter sees the batch); this adapter is the secondary
 * copy and is the source of truth for long-term resume.
 */

import {
  foldSessionSummary,
  type SessionKey,
  type SessionStore,
  type SessionStoreEntry,
  type SessionSummaryEntry,
} from '@anthropic-ai/claude-agent-sdk';
import type { MemoryStoreType } from '../tools/shared.js';

type StoreWithSdkSessions = MemoryStoreType & {
  appendSessionEntries(
    sessionId: string,
    projectKey: string,
    subpath: string,
    entries: Array<Record<string, unknown>>,
  ): void;
  loadSessionEntries(sessionId: string, subpath: string): Array<Record<string, unknown>> | null;
  listSdkSessions(projectKey: string): Array<{ sessionId: string; mtime: number }>;
  listSdkSessionSubkeys(sessionId: string): string[];
  listSdkSessionSummaries(projectKey: string): Array<{
    sessionId: string; subpath: string; mtime: number; data: Record<string, unknown>;
  }>;
  deleteSdkSession(sessionId: string): void;
  upsertSessionSummary(
    sessionId: string, subpath: string, projectKey: string, mtime: number, data: Record<string, unknown>,
  ): void;
};

function subkey(key: SessionKey): string {
  return key.subpath ?? '';
}

export function createMemorySessionStore(store: MemoryStoreType): SessionStore {
  const s = store as StoreWithSdkSessions;

  return {
    async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
      if (entries.length === 0) return;
      const sub = subkey(key);
      // Persist the raw entries first so load() is coherent even if the
      // summary sidecar fold throws.
      s.appendSessionEntries(
        key.sessionId,
        key.projectKey,
        sub,
        entries as Array<Record<string, unknown>>,
      );

      // Maintain the incrementally-folded summary for cheap listing.
      try {
        const existing = s
          .listSdkSessionSummaries(key.projectKey)
          .find(row => row.sessionId === key.sessionId && row.subpath === sub);
        const prev: SessionSummaryEntry | undefined = existing
          ? {
              sessionId: existing.sessionId,
              mtime: existing.mtime,
              data: existing.data,
            }
          : undefined;
        const next = foldSessionSummary(prev, key, entries);
        s.upsertSessionSummary(
          key.sessionId,
          sub,
          key.projectKey,
          Date.now(),
          next.data,
        );
      } catch {
        // Non-fatal — summary is a convenience, not a correctness concern.
      }
    },

    async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
      const rows = s.loadSessionEntries(key.sessionId, subkey(key));
      if (rows === null) return null;
      return rows as SessionStoreEntry[];
    },

    async listSessions(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>> {
      return s.listSdkSessions(projectKey);
    },

    async listSessionSummaries(projectKey: string): Promise<SessionSummaryEntry[]> {
      return s
        .listSdkSessionSummaries(projectKey)
        .filter(r => r.subpath === '')
        .map(r => ({ sessionId: r.sessionId, mtime: r.mtime, data: r.data }));
    },

    async delete(key: SessionKey): Promise<void> {
      // SDK passes per-key deletes; we scope the delete to all subpaths
      // under the session so a top-level delete wipes subagent trails too.
      s.deleteSdkSession(key.sessionId);
    },

    async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
      return s.listSdkSessionSubkeys(key.sessionId);
    },
  };
}
