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
import type { Chunk, ChunkCategory } from '../types.js';

/** Directories to skip when scanning the vault. */
const SKIP_DIRS = new Set(['06-Templates', '.obsidian']);

/** Maximum chunk size before splitting at paragraph boundaries. */
const MAX_CHUNK_CHARS = 3000;

/** Directory-to-category mapping for vault structure. */
const DIR_CATEGORY_MAP: Record<string, ChunkCategory> = {
  '00-System': 'advice',
  '01-Daily-Notes': 'events',
  '02-People': 'facts',
  '03-Projects': 'discoveries',
  '04-Topics': 'facts',
  '05-Tasks': 'advice',
  '07-Inbox': 'events',
};

/** Content keyword patterns for category detection (used as fallback). */
const CATEGORY_KEYWORDS: Array<[RegExp, ChunkCategory]> = [
  [/\b(prefer|always use|never use|i like|i don'?t like|i hate)\b/i, 'preferences'],
  [/\b(learned|discovered|TIL|turns out|insight|breakthrough)\b/i, 'discoveries'],
  [/\b(reminder|tip|rule of thumb|always|never|best practice)\b/i, 'advice'],
];

/**
 * Detect category and topic for a chunk based on vault path, frontmatter, and content.
 */
function detectCategoryAndTopic(
  relPath: string,
  frontmatter: Record<string, any>,
  content: string,
): { category: ChunkCategory | null; topic: string | null } {
  // Category detection (cascade)
  let category: ChunkCategory | null = null;

  // 1. Explicit frontmatter category
  if (frontmatter.category) {
    const fm = String(frontmatter.category).toLowerCase();
    if (['facts', 'events', 'discoveries', 'preferences', 'advice'].includes(fm)) {
      category = fm as ChunkCategory;
    }
  }

  // 2. Directory-based
  if (!category) {
    const topDir = relPath.split('/')[0];
    category = DIR_CATEGORY_MAP[topDir] ?? null;
  }

  // 3. Content keyword heuristics (only if nothing else matched)
  if (!category) {
    for (const [pattern, cat] of CATEGORY_KEYWORDS) {
      if (pattern.test(content)) {
        category = cat;
        break;
      }
    }
  }

  // Topic detection (cascade)
  let topic: string | null = null;

  // 1. Explicit frontmatter topic or first tag
  if (frontmatter.topic) {
    topic = String(frontmatter.topic);
  } else if (Array.isArray(frontmatter.tags) && frontmatter.tags.length > 0) {
    topic = String(frontmatter.tags[0]);
  }

  // 2. Second path segment (subdirectory name)
  if (!topic) {
    const parts = relPath.split('/');
    if (parts.length >= 3) {
      topic = parts[1];
    }
  }

  return { category, topic };
}

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
  const { category, topic } = detectCategoryAndTopic(relPath, parsed.data ?? {}, parsed.content);

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
      category,
      topic,
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
          category,
          topic,
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
        category,
        topic,
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
