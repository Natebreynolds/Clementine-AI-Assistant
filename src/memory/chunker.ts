/**
 * Clementine TypeScript — Vault file chunker for memory indexing.
 *
 * Parses Markdown files into chunks by ## headers, extracts frontmatter,
 * and splits oversized sections at paragraph boundaries.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { Chunk } from '../types.js';

/** Directories to skip when scanning the vault. */
const SKIP_DIRS = new Set(['06-Templates', '.obsidian']);

/** Maximum chunk size before splitting at paragraph boundaries. */
const MAX_CHUNK_CHARS = 3000;

/**
 * Compute a truncated SHA-256 content hash (first 16 hex chars).
 */
function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * Parse a Markdown file into chunks by ## headers.
 *
 * @param filePath - Absolute path to the Markdown file.
 * @param vaultDir - Absolute path to the vault root.
 * @returns List of Chunk objects. Empty if file should be skipped.
 */
export function chunkFile(filePath: string, vaultDir: string): Chunk[] {
  const relPath = path.relative(vaultDir, filePath);

  // Skip templates and .obsidian
  for (const skip of SKIP_DIRS) {
    if (relPath.startsWith(skip)) {
      return [];
    }
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch {
    return [];
  }

  const fmJson =
    parsed.data && Object.keys(parsed.data).length > 0
      ? JSON.stringify(parsed.data)
      : '';

  const chunks: Chunk[] = [];

  // Add frontmatter as its own chunk if present
  if (parsed.data && Object.keys(parsed.data).length > 0) {
    const fmText = Object.entries(parsed.data)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    chunks.push({
      sourceFile: relPath,
      section: 'frontmatter',
      content: fmText,
      chunkType: 'frontmatter',
      frontmatterJson: fmJson,
      contentHash: contentHash(fmText),
    });
  }

  // Split body by ## headers
  const sections = splitByHeaders(parsed.content);

  for (const [sectionName, sectionContent] of sections) {
    const content = sectionContent.trim();
    if (!content) continue;

    const chunkType = sectionName === 'preamble' ? 'preamble' : 'heading';

    // Split oversized sections at paragraph boundaries
    if (content.length > MAX_CHUNK_CHARS) {
      const subChunks = splitAtParagraphs(content, MAX_CHUNK_CHARS);
      for (let i = 0; i < subChunks.length; i++) {
        const label =
          subChunks.length > 1 ? `${sectionName} (part ${i + 1})` : sectionName;
        chunks.push({
          sourceFile: relPath,
          section: label,
          chunkType,
          content: subChunks[i],
          frontmatterJson: fmJson,
          contentHash: contentHash(subChunks[i]),
        });
      }
    } else {
      chunks.push({
        sourceFile: relPath,
        section: sectionName,
        chunkType,
        content,
        frontmatterJson: fmJson,
        contentHash: contentHash(content),
      });
    }
  }

  return chunks;
}

/**
 * Split Markdown body by ## headers.
 *
 * Content before the first ## header is labeled "preamble".
 *
 * @returns Array of [sectionName, sectionContent] tuples.
 */
export function splitByHeaders(body: string): [string, string][] {
  const sections: [string, string][] = [];
  let currentName = 'preamble';
  let currentLines: string[] = [];

  for (const line of body.split('\n')) {
    if (line.startsWith('## ')) {
      // Save previous section
      if (currentLines.length > 0) {
        sections.push([currentName, currentLines.join('\n')]);
      }
      currentName = line.slice(3).trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // Don't forget the last section
  if (currentLines.length > 0) {
    sections.push([currentName, currentLines.join('\n')]);
  }

  return sections;
}

/**
 * Split text at paragraph boundaries (double newlines) to stay under maxChars.
 */
export function splitAtParagraphs(text: string, maxChars: number): string[] {
  const paragraphs = text.split('\n\n');
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;

  for (const para of paragraphs) {
    const paraLen = para.length + 2; // +2 for the \n\n separator
    if (currentLen + paraLen > maxChars && current.length > 0) {
      chunks.push(current.join('\n\n'));
      current = [para];
      currentLen = para.length;
    } else {
      current.push(para);
      currentLen += paraLen;
    }
  }

  if (current.length > 0) {
    chunks.push(current.join('\n\n'));
  }

  return chunks;
}
