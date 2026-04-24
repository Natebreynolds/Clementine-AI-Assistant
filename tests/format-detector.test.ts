/**
 * Format detector: classifies files by extension + content sniffing,
 * walks folders to produce a manifest.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detectFormat, detectManifest } from '../src/brain/format-detector.js';

let dir: string;

beforeEach(() => {
  dir = path.join(os.tmpdir(), 'clem-fmt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('detectFormat', () => {
  it('classifies CSV by extension', () => {
    const p = path.join(dir, 'data.csv');
    writeFileSync(p, 'a,b,c\n1,2,3\n');
    expect(detectFormat(p)).toBe('csv');
  });

  it('classifies JSONL by extension', () => {
    const p = path.join(dir, 'lines.jsonl');
    writeFileSync(p, '{"a":1}\n{"a":2}\n');
    expect(detectFormat(p)).toBe('jsonl');
  });

  it('distinguishes JSON array from JSONL stream', () => {
    const json = path.join(dir, 'wrapped.json');
    writeFileSync(json, '[{"a":1},{"a":2}]');
    expect(detectFormat(json)).toBe('json');

    const jsonl = path.join(dir, 'streamy.json');
    writeFileSync(jsonl, '{"a":1}\n{"a":2}\n{"a":3}\n');
    expect(detectFormat(jsonl)).toBe('jsonl');
  });

  it('classifies markdown and txt as markdown', () => {
    const md = path.join(dir, 'notes.md');
    writeFileSync(md, '# Hi\n\nBody text.');
    expect(detectFormat(md)).toBe('markdown');

    const txt = path.join(dir, 'notes.txt');
    writeFileSync(txt, 'just text');
    expect(detectFormat(txt)).toBe('markdown');
  });

  it('classifies PDF by magic bytes when extension missing', () => {
    const p = path.join(dir, 'doc-no-ext');
    writeFileSync(p, '%PDF-1.4\nbinary contents');
    expect(detectFormat(p)).toBe('pdf');
  });

  it('classifies unknown for unknown content', () => {
    const p = path.join(dir, 'weird.xyz');
    writeFileSync(p, 'random binary');
    expect(detectFormat(p)).toBe('unknown');
  });
});

describe('detectManifest', () => {
  it('walks a folder and counts formats', () => {
    writeFileSync(path.join(dir, 'a.csv'), 'x,y\n1,2');
    writeFileSync(path.join(dir, 'b.json'), '{"ok":true}');
    writeFileSync(path.join(dir, 'notes.md'), '# Title');
    mkdirSync(path.join(dir, 'nested'));
    writeFileSync(path.join(dir, 'nested', 'c.csv'), 'a\n1');

    const manifest = detectManifest(dir);
    expect(manifest.totalFiles).toBe(4);
    expect(manifest.formats.csv).toBe(2);
    expect(manifest.formats.json).toBe(1);
    expect(manifest.formats.markdown).toBe(1);
    expect(manifest.totalBytes).toBeGreaterThan(0);
  });

  it('skips dotfiles and common vendor dirs', () => {
    writeFileSync(path.join(dir, '.hidden.csv'), 'a\n1');
    mkdirSync(path.join(dir, 'node_modules'));
    writeFileSync(path.join(dir, 'node_modules', 'pkg.json'), '{}');
    writeFileSync(path.join(dir, 'visible.csv'), 'a\n1');

    const manifest = detectManifest(dir);
    expect(manifest.totalFiles).toBe(1);
    expect(manifest.formats.csv).toBe(1);
  });

  it('handles a single-file target', () => {
    const p = path.join(dir, 'only.csv');
    writeFileSync(p, 'a,b\n1,2');
    const manifest = detectManifest(p);
    expect(manifest.totalFiles).toBe(1);
    expect(manifest.files[0].format).toBe('csv');
  });
});
