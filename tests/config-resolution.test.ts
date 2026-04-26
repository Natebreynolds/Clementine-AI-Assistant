/**
 * Phase 6b — verify clementine.json values flow through to the exported
 * config constants. Sets CLEMENTINE_HOME before any src import, writes
 * a fully populated clementine.json, then dynamically imports config.ts
 * and asserts each schema field reaches the right export.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = path.join(
  os.tmpdir(),
  'clem-config-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
);
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(TMP_HOME, { recursive: true });

writeFileSync(
  path.join(TMP_HOME, 'clementine.json'),
  JSON.stringify({
    schemaVersion: 1,
    ownerName: 'Nate',
    assistantName: 'JsonClem',
    timezone: 'America/Denver',
    models: {
      default: 'haiku',
      haiku: 'pinned-haiku-id',
      sonnet: 'pinned-sonnet-id',
      opus: 'pinned-opus-id',
    },
    budgets: { heartbeat: 0.25, cronT1: 1.5, cronT2: 7.5, chat: 9.99 },
    heartbeat: { intervalMinutes: 45, activeStart: 6, activeEnd: 23 },
    unleashed: { phaseTurns: 100, defaultMaxHours: 4, maxPhases: 25 },
  }),
);

afterAll(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

describe('Phase 6b: clementine.json fields reach config exports', () => {
  it('models, budgets, heartbeat, and unleashed all read from JSON', async () => {
    const cfg = await import('../src/config.js');
    expect(cfg.OWNER_NAME).toBe('Nate');
    expect(cfg.ASSISTANT_NAME).toBe('JsonClem');
    expect(cfg.TIMEZONE).toBe('America/Denver');

    expect(cfg.MODELS.haiku).toBe('pinned-haiku-id');
    expect(cfg.MODELS.sonnet).toBe('pinned-sonnet-id');
    expect(cfg.MODELS.opus).toBe('pinned-opus-id');
    expect(cfg.DEFAULT_MODEL_TIER).toBe('haiku');
    expect(cfg.MODEL).toBe('pinned-haiku-id');

    expect(cfg.BUDGET.heartbeat).toBe(0.25);
    expect(cfg.BUDGET.cronT1).toBe(1.5);
    expect(cfg.BUDGET.cronT2).toBe(7.5);
    expect(cfg.BUDGET.chat).toBe(9.99);

    expect(cfg.HEARTBEAT_INTERVAL_MINUTES).toBe(45);
    expect(cfg.HEARTBEAT_ACTIVE_START).toBe(6);
    expect(cfg.HEARTBEAT_ACTIVE_END).toBe(23);

    expect(cfg.UNLEASHED_PHASE_TURNS).toBe(100);
    expect(cfg.UNLEASHED_DEFAULT_MAX_HOURS).toBe(4);
    expect(cfg.UNLEASHED_MAX_PHASES).toBe(25);
  });
});
