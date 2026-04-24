/**
 * End-to-end ingestion pipeline: seed a small CSV through the real flow
 * (with LLM override) and verify chunks, artifacts, ingested_rows, the
 * ingestion_runs audit, and the overview note all land as expected.
 *
 * CLEMENTINE_HOME is set before any src import so the store, vault dir,
 * and pipeline resolve to an isolated temp directory.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = path.join(os.tmpdir(), 'clem-ingest-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'vault'), { recursive: true });

beforeAll(() => {
  // vault dir already made above; nothing else needed for now
});

afterAll(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

describe('ingestion pipeline — CSV end-to-end', () => {
  it('ingests rows, writes vault notes, fills ingested_rows, and produces an overview', async () => {
    // Dynamic imports so CLEMENTINE_HOME is already set when config loads
    const { runIngestion } = await import('../src/brain/ingestion-pipeline.js');
    const { setLLMOverride } = await import('../src/brain/llm-client.js');
    const { getStore } = await import('../src/tools/shared.js');
    const { upsertSource, getSource } = await import('../src/brain/source-registry.js');

    // Mock LLM: schema-infer returns a deterministic mapping; overview writer
    // gets a stubbed paragraph; any other call returns a placeholder.
    let schemaInferCalls = 0;
    let overviewCalls = 0;
    setLLMOverride(async (prompt, opts) => {
      if (opts?.system?.includes('data-schema analyst')) {
        schemaInferCalls += 1;
        return JSON.stringify({
          title_template: '{{name}}',
          summary_template: '{{name}} in {{industry}} paid ${{amount}}',
          tag_templates: ['industry:{{industry}}'],
          frontmatter_keys: ['email', 'industry'],
          structured_columns: [
            { name: 'amount', type: 'REAL' },
            { name: 'industry', type: 'TEXT' },
          ],
          target_folder: '04-Ingest/customers-test',
          entity_hints: ['name'],
        });
      }
      if (opts?.system?.includes('knowledge-base curator') || opts?.system?.includes('entry-point note')) {
        overviewCalls += 1;
        return '## What was added\nThree customers ingested from a CSV.\n\n## Key themes\nAcme, Beta, Gamma.\n\n## Time/number shape\nAmounts totalling $11k.\n\n## Next questions\nWhich is the largest?';
      }
      return '';
    });

    try {
      // Create a sample CSV
      const csvPath = path.join(TMP_HOME, 'customers.csv');
      writeFileSync(csvPath, [
        'id,name,email,industry,amount',
        '1,Acme,a@b.co,software,5000',
        '2,Beta,c@d.co,retail,3000',
        '3,Gamma,e@f.co,software,3000',
      ].join('\n'));

      // Register + run
      await upsertSource({
        slug: 'customers-test',
        kind: 'seed',
        adapter: 'csv',
        configJson: JSON.stringify({ inputPath: csvPath }),
        targetFolder: '04-Ingest/customers-test',
        intelligence: 'auto',
        enabled: true,
      });
      const source = await getSource('customers-test');
      expect(source).not.toBeNull();

      const result = await runIngestion({ source: source!, inputPath: csvPath });
      expect(result.recordsIn).toBe(3);
      expect(result.recordsWritten).toBe(3);
      expect(result.recordsFailed).toBe(0);
      expect(schemaInferCalls).toBeGreaterThanOrEqual(1);
      expect(overviewCalls).toBeGreaterThanOrEqual(1);
      expect(result.overviewNotePath).toBeTruthy();

      // Vault notes exist
      const vaultDir = path.join(TMP_HOME, 'vault');
      for (const slug of ['customers-1', 'customers-2', 'customers-3']) {
        const abs = path.join(vaultDir, '04-Ingest/customers-test', slug + '.md');
        expect(existsSync(abs)).toBe(true);
      }
      // Overview note also written
      expect(existsSync(path.join(vaultDir, result.overviewNotePath!))).toBe(true);

      // Store checks
      const store = await getStore();
      const runs = store.listIngestionRuns('customers-test', 5);
      expect(runs.length).toBe(1);
      expect(runs[0].status).toBe('ok');
      expect(runs[0].recordsWritten).toBe(3);
      expect(runs[0].overviewNotePath).toBeTruthy();

      // Structured rows with aggregate-ready columns
      const rows = store.queryIngestedRows(
        'SELECT source_slug, external_id, amount, industry FROM ingested_rows ORDER BY amount DESC',
      );
      expect(rows.length).toBe(3);
      const total = store.queryIngestedRows('SELECT SUM(amount) AS total FROM ingested_rows') as any[];
      expect(Number(total[0].total)).toBe(11000);

      // Chunks got provenance tags
      const chunk = store.findChunkByExternalId('customers-test', 'customers-1');
      expect(chunk).not.toBeNull();
      expect(chunk!.sourceFile).toContain('customers-test');
    } finally {
      setLLMOverride(null);
    }
  }, 30_000);

  it('re-running the same CSV is idempotent (no duplicate ingested_rows)', async () => {
    const { runIngestion } = await import('../src/brain/ingestion-pipeline.js');
    const { setLLMOverride } = await import('../src/brain/llm-client.js');
    const { getStore } = await import('../src/tools/shared.js');
    const { getSource } = await import('../src/brain/source-registry.js');

    setLLMOverride(async (_prompt, opts) => {
      if (opts?.system?.includes('data-schema analyst')) {
        return JSON.stringify({
          title_template: '{{name}}',
          summary_template: '{{name}}',
          tag_templates: [],
          frontmatter_keys: [],
          structured_columns: [{ name: 'amount', type: 'REAL' }],
          target_folder: '04-Ingest/customers-test',
          entity_hints: [],
        });
      }
      return 'overview text';
    });

    try {
      const source = await getSource('customers-test');
      expect(source).not.toBeNull();
      const csvPath = path.join(TMP_HOME, 'customers.csv');
      const result = await runIngestion({ source: source!, inputPath: csvPath });
      expect(result.recordsIn).toBe(3);

      const store = await getStore();
      const rows = store.queryIngestedRows('SELECT COUNT(*) AS n FROM ingested_rows') as any[];
      // Still 3 (upserted in place, not duplicated)
      expect(Number(rows[0].n)).toBe(3);
    } finally {
      setLLMOverride(null);
    }
  }, 30_000);
});
