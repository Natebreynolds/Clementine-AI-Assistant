/**
 * 1.18.158 — guard rail against the recurring "served HTML inline JS doesn't
 * parse" bug. Twice in two days I shipped a SyntaxError into the dashboard
 * SPA (1.18.142 escaped \n that the outer template literal turned into a
 * literal newline; 1.18.155 unescaped apostrophe in title= attribute that
 * terminated the surrounding single-quoted JS string). Both ships passed
 * tsc + vitest because vitest only checks our TypeScript, not the rendered
 * HTML.
 *
 * This test calls getDashboardHTML() with a fake token, extracts every
 * inline <script> block, and feeds them to the V8 parser via `new Function`.
 * Any SyntaxError fails the test loudly. Doesn't run the script (no DOM
 * needed) — just parses.
 */
import { describe, it, expect } from 'vitest';
import { getDashboardHTML, redactMcpServersForDashboard } from '../src/cli/dashboard.js';

describe('dashboard SPA inline JS parses', () => {
  it('every inline <script> block is valid JS', () => {
    const html = getDashboardHTML('a'.repeat(48));
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(100_000);
    // Pull every non-src <script>...</script> block.
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
    const blocks: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      blocks.push(m[1]);
    }
    expect(blocks.length).toBeGreaterThan(0);
    const errors: Array<{ block: number; preview: string; error: string }> = [];
    for (let i = 0; i < blocks.length; i++) {
      try {
        // `new Function` parses without executing. Wrap in IIFE-friendly
        // shim so top-level returns / awaits don't throw.
        new Function('"use strict"; ' + blocks[i] + '\n;void 0;');
      } catch (err) {
        const errMsg = (err as Error).message;
        // Find the line in the block that contains the error context, if any.
        const lineMatch = errMsg.match(/at <anonymous>.*?:(\d+)/) || errMsg.match(/line (\d+)/);
        const lineNo = lineMatch ? parseInt(lineMatch[1]!, 10) : 0;
        const lines = blocks[i].split('\n');
        const preview = lineNo > 0 && lineNo <= lines.length
          ? lines[lineNo - 1]?.slice(0, 200) ?? ''
          : blocks[i].slice(0, 200);
        errors.push({ block: i, preview, error: errMsg });
      }
    }
    if (errors.length > 0) {
      const detail = errors.map(e =>
        `\n  Block ${e.block}: ${e.error}\n    near: ${e.preview}`
      ).join('\n');
      throw new Error(`Dashboard SPA has ${errors.length} inline JS parse error(s):${detail}`);
    }
  });

  it('redacts MCP server env and header values from dashboard API payloads', () => {
    const servers = redactMcpServersForDashboard([
      {
        name: 'sensitive',
        type: 'stdio',
        command: 'npx',
        args: ['tool'],
        env: {
          API_TOKEN: 'secret-token-value',
          DATAFORSEO_PASSWORD: 'secret-password-value',
        },
        headers: {
          Authorization: 'Bearer secret-header-value',
        },
        description: 'Sensitive server',
        enabled: true,
        source: 'user',
      },
    ]);
    const json = JSON.stringify(servers);
    expect(json).not.toContain('secret-token-value');
    expect(json).not.toContain('secret-password-value');
    expect(json).not.toContain('secret-header-value');
    expect(servers[0].envKeys).toEqual(['API_TOKEN', 'DATAFORSEO_PASSWORD']);
    expect(servers[0].headerKeys).toEqual(['Authorization']);
    expect(servers[0]).not.toHaveProperty('env');
    expect(servers[0]).not.toHaveProperty('headers');
  });
});
