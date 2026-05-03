/**
 * Clementine — PDF adapter.
 *
 * Fast path: pdf-parse extracts the text layer. Yields one RawRecord per
 * page (pdf-parse concatenates pages with \f).
 *
 * OCR fallback: for image-only / scanned PDFs, pdf-parse returns empty
 * text. We then ask Claude Code to read the PDF itself — its built-in
 * Read tool handles PDFs natively (including vision for scanned pages),
 * and the call goes through the Agent SDK so it works with the user's
 * OAuth session (no separate ANTHROPIC_API_KEY required).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import pdfParse from 'pdf-parse';
import type { RawRecord } from '../../types.js';
import { contentHash } from './common.js';
import {
  MODELS,
  applyOneMillionContextRecovery,
  looksLikeClaudeOneMillionContextError,
  normalizeClaudeSdkOptionsForOneMillionContext,
} from '../../config.js';

export async function* parsePdf(filePath: string): AsyncIterable<RawRecord> {
  let buf: Buffer;
  try { buf = readFileSync(filePath); }
  catch (err) {
    throw new Error(`Failed to read PDF ${path.basename(filePath)}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let result: { text: string; numpages: number; info?: Record<string, unknown> };
  try {
    result = await pdfParse(buf);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = /password/i.test(msg) ? ' (looks password-protected)' : '';
    throw new Error(`Failed to parse PDF ${path.basename(filePath)}${hint}: ${msg}`);
  }

  const hint = path.basename(filePath, path.extname(filePath));
  const pages = splitPages(result.text);
  const hasAnyText = pages.some((p) => p.trim().length > 0);
  if (!hasAnyText) {
    // Image-only / scanned PDF — fall back to Claude's native PDF reading.
    const ocrPages = await ocrPdfViaClaude(filePath);
    if (ocrPages.length === 0) {
      throw new Error(`PDF ${path.basename(filePath)} has no extractable text and OCR returned nothing. The file may be corrupt or empty.`);
    }
    for (let i = 0; i < ocrPages.length; i++) {
      const pageText = ocrPages[i].trim();
      if (!pageText) continue;
      yield {
        externalId: `pdf-ocr-${hint}-p${i + 1}-${contentHash(pageText)}`,
        content: pageText,
        rawPayload: pageText,
        metadata: {
          adapter: 'pdf',
          extraction: 'claude-ocr',
          source_file: filePath,
          page: i + 1,
          total_pages: ocrPages.length,
          content_hash: contentHash(pageText),
        },
      };
    }
    return;
  }

  for (let i = 0; i < pages.length; i++) {
    const pageText = pages[i].trim();
    if (!pageText) continue;
    yield {
      externalId: `pdf-${hint}-p${i + 1}-${contentHash(pageText)}`,
      content: pageText,
      rawPayload: pageText,
      metadata: {
        adapter: 'pdf',
        extraction: 'text-layer',
        source_file: filePath,
        page: i + 1,
        total_pages: result.numpages,
        pdf_info: result.info ?? {},
        content_hash: contentHash(pageText),
      },
    };
  }
}

/**
 * OCR fallback via the Claude Agent SDK. Asks Claude Code to Read the PDF
 * and transcribe every page verbatim, separated by \f. Returns one string
 * per page. Empty array on failure (caller decides how to handle).
 */
async function ocrPdfViaClaude(filePath: string): Promise<string[]> {
  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const stream = query({
      prompt: `Read the PDF at ${JSON.stringify(filePath)} using the Read tool. Transcribe every page's text verbatim — preserve the reading order, headings, lists, and paragraphs exactly as they appear. Separate pages with the form-feed character (\\f). Do NOT summarize, paraphrase, add commentary, or wrap in code fences. Output only the transcribed text.`,
      options: normalizeClaudeSdkOptionsForOneMillionContext({
        model: MODELS.haiku,
        maxTurns: 4, // Read tool call + response (a few turns of thinking is fine)
        systemPrompt: 'You are a faithful OCR transcriber. Copy text exactly as written. When the PDF has images or scans, read the text from them using vision. Never invent content.',
        // Claude Code's built-in Read tool handles PDFs (text + vision)
        allowedTools: ['Read'],
        permissionMode: 'bypassPermissions' as const,
        settingSources: [],
      }),
    });
    let text = '';
    for await (const message of stream) {
      if (message.type === 'assistant') {
        const content = (message as { message?: { content?: Array<{ type: string; text?: string }> } })
          .message?.content ?? [];
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            text += block.text;
          }
        }
      } else if (message.type === 'result') {
        const result = message as { is_error?: boolean; errors?: string[]; result?: string };
        if (result.is_error) {
          const errorText = Array.isArray(result.errors) ? result.errors.join('; ') : String(result.result ?? '');
          if (looksLikeClaudeOneMillionContextError(errorText)) applyOneMillionContextRecovery();
          return [];
        }
        break;
      }
    }
    const cleaned = text.trim();
    if (cleaned.length < 20) return [];
    return splitPages(cleaned);
  } catch (err) {
    if (looksLikeClaudeOneMillionContextError(err)) applyOneMillionContextRecovery();
    return [];
  }
}

/** pdf-parse inserts \f between pages. Fall back to paragraph-size chunks if not. */
function splitPages(text: string): string[] {
  if (text.includes('\f')) return text.split('\f');
  return [text];
}
