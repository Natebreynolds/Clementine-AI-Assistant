import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerProjectTools } from '../src/tools/project-tools.js';

function textFromResult(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((item) => item.text ?? '').join('\n');
}

describe('project MCP tools', () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function registerHandlers() {
    const handlers = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>();
    const server = {
      tool: (
        name: string,
        _description: string,
        _schema: unknown,
        handler: (input: Record<string, unknown>) => Promise<unknown>,
      ) => {
        handlers.set(name, handler);
      },
    };
    registerProjectTools(server as never);
    return handlers;
  }

  it('supports custom deploy commands without requiring Netlify or an output folder', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'clementine-project-tool-'));
    mkdirSync(path.join(dir, '.clementine'), { recursive: true });
    writeFileSync(
      path.join(dir, '.clementine', 'deploy.json'),
      JSON.stringify({
        kind: 'custom',
        command: 'npm run deploy',
        verifyUrl: 'https://example.com/',
      }),
    );

    const handlers = registerHandlers();
    const result = await handlers.get('project_deploy')?.({ project_path: dir, dry_run: true });
    const text = textFromResult(result);

    expect(text).toContain('[DRY RUN]');
    expect(text).toContain('npm run deploy');
    expect(text).toContain('https://example.com/');
  });

  it('keeps the built-in Netlify adapter as an optional provider adapter', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'clementine-project-tool-'));
    mkdirSync(path.join(dir, '.clementine'), { recursive: true });
    mkdirSync(path.join(dir, 'output'));
    writeFileSync(
      path.join(dir, '.clementine', 'deploy.json'),
      JSON.stringify({
        kind: 'netlify',
        site: 'example-site',
        dir: 'output',
        verifyUrl: 'https://example-site.netlify.app/',
      }),
    );

    const handlers = registerHandlers();
    const result = await handlers.get('project_deploy')?.({ project_path: dir, dry_run: true });
    const text = textFromResult(result);

    expect(text).toContain('netlify deploy --prod');
    expect(text).toContain('example-site');
    expect(text).toContain('https://example-site.netlify.app/');
  });
});
