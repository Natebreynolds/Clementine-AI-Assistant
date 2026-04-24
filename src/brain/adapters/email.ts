/**
 * Clementine — Email adapter.
 *
 * Handles a single .eml message or an .mbox mailbox. Each email yields
 * one RawRecord with the plaintext body + structured headers in metadata.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import type { RawRecord } from '../../types.js';
import { contentHash } from './common.js';

export async function* parseEmail(filePath: string): AsyncIterable<RawRecord> {
  let raw: string;
  try { raw = readFileSync(filePath, 'utf-8'); } catch { return; }

  const isMbox = filePath.toLowerCase().endsWith('.mbox') || /^From /.test(raw);
  const messages = isMbox ? splitMbox(raw) : [raw];
  const hint = path.basename(filePath, path.extname(filePath));

  for (let i = 0; i < messages.length; i++) {
    const source = messages[i];
    if (!source.trim()) continue;
    let parsed;
    try { parsed = await simpleParser(source); } catch { continue; }

    const htmlText = typeof parsed.html === 'string' ? parsed.html : '';
    const body = (parsed.text ?? htmlText ?? '').trim();
    if (!body) continue;

    const messageId = (parsed.messageId ?? '').replace(/[<>]/g, '').trim();
    const externalId = messageId
      ? `eml-${messageId}`
      : `eml-${hint}-${i}-${contentHash(body)}`;

    const fromAddr = Array.isArray(parsed.from)
      ? parsed.from[0]?.text
      : parsed.from?.text;

    yield {
      externalId,
      content: [
        parsed.subject ? `Subject: ${parsed.subject}` : '',
        fromAddr ? `From: ${fromAddr}` : '',
        parsed.date ? `Date: ${parsed.date.toISOString()}` : '',
        '',
        body,
      ].filter(Boolean).join('\n'),
      rawPayload: source,
      metadata: {
        adapter: 'email',
        source_file: filePath,
        message_id: messageId,
        subject: parsed.subject ?? '',
        from: fromAddr ?? '',
        to: Array.isArray(parsed.to) ? parsed.to.map((t) => t.text).join(', ') : parsed.to?.text ?? '',
        date: parsed.date?.toISOString() ?? '',
        content_hash: contentHash(body),
      },
    };
  }
}

/** Split an mbox by the `From ` envelope-sender line that begins each message. */
function splitMbox(raw: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('From ') && current.length > 0) {
      out.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) out.push(current.join('\n'));
  return out;
}
