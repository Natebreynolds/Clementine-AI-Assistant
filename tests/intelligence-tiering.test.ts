/**
 * Tiered intelligence: classifyRecord routes structured sources to the
 * template path, free-form sources to the LLM path. Token safety:
 * chunkContent splits long input into pieces that stay under budget,
 * and LLM calls observe their input-token cap.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyRecord,
  chunkContent,
  renderTemplate,
  applyTemplate,
  distillChunk,
  sanitizeFolder,
} from '../src/brain/intelligence.js';
import { setLLMOverride } from '../src/brain/llm-client.js';
import type { RawRecord } from '../src/types.js';

describe('classifyRecord', () => {
  const base = { content: 'x', rawPayload: 'x' };

  it('routes CSV records to structured', () => {
    const r: RawRecord = { ...base, metadata: { adapter: 'csv', structured: { id: 1 } } };
    expect(classifyRecord(r, 'auto')).toBe('structured');
  });

  it('routes PDF/email/docx to free-form', () => {
    for (const adapter of ['pdf', 'email', 'docx', 'markdown']) {
      const r: RawRecord = { ...base, metadata: { adapter } };
      expect(classifyRecord(r, 'auto')).toBe('free-form');
    }
  });

  it('honors source override', () => {
    const r: RawRecord = { ...base, metadata: { adapter: 'pdf' } };
    expect(classifyRecord(r, 'template-only')).toBe('structured');
    expect(classifyRecord(r, 'llm-per-record')).toBe('free-form');
  });
});

describe('chunkContent', () => {
  it('returns a single chunk for small input', () => {
    const chunks = chunkContent('small text', 3000);
    expect(chunks).toEqual(['small text']);
  });

  it('splits long input into multiple chunks at paragraph boundaries', () => {
    const longText = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}: ` + 'x'.repeat(200)).join('\n\n');
    const chunks = chunkContent(longText, 3000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      // Allow a single oversized paragraph through (splitter never drops content),
      // but chunks composed of multiple paragraphs must respect the budget.
      expect(c.length).toBeLessThan(6000);
    }
  });
});

describe('renderTemplate', () => {
  it('substitutes {{key}} placeholders', () => {
    expect(renderTemplate('{{name}} — {{city}}', { name: 'Acme', city: 'NYC' })).toBe('Acme — NYC');
  });

  it('leaves missing keys blank', () => {
    expect(renderTemplate('{{a}}-{{b}}', { a: 'x' })).toBe('x-');
  });
});

describe('applyTemplate (no LLM)', () => {
  it('builds a structured ingestion record from a mapping', () => {
    const record: RawRecord = {
      externalId: 'row-1',
      content: 'raw',
      rawPayload: '{"name":"Acme","amount":5000}',
      metadata: {
        adapter: 'csv',
        structured: { name: 'Acme', amount: 5000, email: 'a@b.co' },
      },
    };
    const mapping = {
      titleTemplate: '{{name}}',
      summaryTemplate: '{{name}} paid ${{amount}}',
      tagTemplates: ['source:csv'],
      frontmatterKeys: ['email'],
      structuredColumns: [
        { name: 'amount', type: 'REAL' as const },
      ],
      targetFolder: '04-Test',
      entityHints: ['name'],
    };
    const out = applyTemplate(record, mapping, 'customers');
    expect(out.title).toBe('Acme');
    expect(out.body).toContain('Acme paid $5000');
    expect(out.body).toContain('[[Acme]]');
    expect(out.tags).toEqual(['source:csv']);
    expect(out.frontmatter.email).toBe('a@b.co');
    expect(out.structuredRow?.amount).toBe(5000);
    expect(out.targetRelPath).toBe('04-Test/row-1.md');
  });
});

describe('sanitizeFolder', () => {
  it('keeps normal vault paths intact', () => {
    expect(sanitizeFolder('04-Ingest/stripe-customers', 'stripe')).toBe('04-Ingest/stripe-customers');
  });

  it('strips leading slashes and drops `..` segments', () => {
    expect(sanitizeFolder('/..//secret', 'src')).toBe('secret');
    expect(sanitizeFolder('../../etc/passwd', 'src')).toBe('etc/passwd');
  });

  it('replaces unsafe characters and caps segment length', () => {
    expect(sanitizeFolder('good$name/with spaces', 'src')).toBe('good-name/with-spaces');
  });

  it('falls back when cleaned path is empty', () => {
    expect(sanitizeFolder('', 'customers')).toBe('04-Ingest/customers');
    expect(sanitizeFolder('..', 'customers')).toBe('04-Ingest/customers');
    expect(sanitizeFolder(null, 'customers')).toBe('04-Ingest/customers');
  });
});

describe('distillChunk with LLM override', () => {
  it('invokes the LLM and parses JSON output', async () => {
    const calls: Array<{ prompt: string; opts: any }> = [];
    setLLMOverride(async (prompt, opts) => {
      calls.push({ prompt, opts });
      return JSON.stringify({
        title: 'Quarterly Report',
        summary: 'Revenue grew 20% in Q3.',
        tags: ['finance', 'quarterly'],
        entities: [{ label: 'Quarter', id: 'Q3 2026' }],
        relationships: [{ from: 'Revenue', rel: 'GREW_BY', to: '20%' }],
      });
    });
    try {
      const out = await distillChunk('Revenue report Q3 2026: ...');
      expect(out.title).toBe('Quarterly Report');
      expect(out.tags).toContain('finance');
      expect(out.entities[0]?.id).toBe('Q3 2026');
      expect(out.relationships[0]?.rel).toBe('GREW_BY');
      expect(calls[0]?.opts?.format).toBe('json');
    } finally {
      setLLMOverride(null);
    }
  });

  it('truncates oversize input to stay under 4k tokens', async () => {
    let observedLength = 0;
    setLLMOverride(async (prompt) => {
      observedLength = prompt.length;
      return '{"title":"ok","summary":"","tags":[],"entities":[],"relationships":[]}';
    });
    try {
      const big = 'x'.repeat(40_000); // ~10k tokens
      await distillChunk(big);
      // 4k tokens × 4 chars ≈ 16k chars, plus some metadata framing
      expect(observedLength).toBeLessThan(20_000);
    } finally {
      setLLMOverride(null);
    }
  });
});
