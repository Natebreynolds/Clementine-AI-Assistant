/**
 * Connector-feed ingestion should not stage raw records inside the same vault
 * folder it later indexes. The source provider's external id is the upsert key.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { RawRecord } from '../src/types.js';

const TMP_HOME = path.join(
  os.tmpdir(),
  'clem-brain-ingest-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
);
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'vault'), { recursive: true });

afterAll(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function recordFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md') && !name.startsWith('_overview-'))
    .sort();
}

describe('brain_ingest_folder direct record ingestion', () => {
  it('preserves provider external ids and upserts into one distilled note per record', async () => {
    const { ingestBrainRecords } = await import('../src/tools/brain-tools.js');
    const { setLLMOverride } = await import('../src/brain/llm-client.js');
    const { getStore } = await import('../src/tools/shared.js');

    setLLMOverride(async (_prompt, opts) => {
      if (opts?.format === 'json') {
        return JSON.stringify({
          title: 'Acme contact',
          summary: 'Acme moved to customer stage and should be tracked.',
          tags: ['hubspot', 'customer'],
          entities: [{ label: 'Company', id: 'Acme Corp' }],
          relationships: [],
        });
      }
      if (opts?.system?.includes('entry-point note')) {
        return '## What was added\nAcme contact updates were imported.\n\n## Key themes / entities\n[[Acme Corp]] customer movement.\n\n## Time/number shape\nNo aggregate numbers.\n\n## Next questions to ask\nWhat changed since the last sync?';
      }
      return 'Acme contact updates were imported.';
    });

    try {
      const record = {
        title: 'Acme Corp contact',
        externalId: 'hubspot:contact:1',
        content: [
          'Acme Corp',
          '',
          'Lifecycle stage: Customer',
          'Owner: Pat',
          'Last activity: 2026-04-30',
        ].join('\n'),
        metadata: {
          provider: 'hubspot',
          sourceUrl: 'https://app.hubspot.com/contact/1',
        },
      };

      const first = await ingestBrainRecords('tool-hubspot-contacts', [record]);
      expect(first.acceptedCount).toBe(1);
      expect(first.pipeline.recordsIn).toBe(1);
      expect(first.pipeline.recordsWritten).toBe(1);
      expect(first.pipeline.recordsFailed).toBe(0);

      const targetDir = path.join(TMP_HOME, 'vault', '04-Ingest', 'tool-hubspot-contacts');
      const targetFile = path.join(targetDir, 'hubspot-contact-1.md');
      expect(existsSync(targetFile)).toBe(true);
      expect(recordFiles(targetDir)).toEqual(['hubspot-contact-1.md']);

      const store = await getStore();
      const chunk = store.findChunkByExternalId('tool-hubspot-contacts', 'hubspot:contact:1');
      expect(chunk).not.toBeNull();
      expect(chunk!.sourceFile).toBe('04-Ingest/tool-hubspot-contacts/hubspot-contact-1.md');

      const second = await ingestBrainRecords('tool-hubspot-contacts', [{
        ...record,
        content: record.content + '\nNew finding: Renewal review started.',
      }]);
      expect(second.pipeline.recordsIn).toBe(1);
      expect(second.pipeline.recordsWritten).toBe(1);
      expect(second.pipeline.recordsFailed).toBe(0);

      expect(recordFiles(targetDir)).toEqual(['hubspot-contact-1.md']);
      const runs = store.listIngestionRuns('tool-hubspot-contacts', 10);
      expect(runs.length).toBe(2);
      expect(runs.every((run) => run.recordsIn === 1)).toBe(true);
    } finally {
      setLLMOverride(null);
    }
  }, 30_000);

  it('uses markdown frontmatter externalId when parsing markdown seeds', async () => {
    const { parseMarkdown } = await import('../src/brain/adapters/markdown.js');
    const filePath = path.join(TMP_HOME, 'markdown-seed.md');
    writeFileSync(filePath, [
      '---',
      'externalId: "sheet:row:42"',
      'title: Sheet row',
      '---',
      '',
      'Customer row body.',
    ].join('\n'));

    const records: RawRecord[] = [];
    for await (const record of parseMarkdown(filePath)) records.push(record);

    expect(records).toHaveLength(1);
    expect(records[0].externalId).toBe('sheet:row:42');
  });
});
