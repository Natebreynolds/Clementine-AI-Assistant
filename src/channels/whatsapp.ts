/**
 * Clementine TypeScript — WhatsApp channel adapter (via Twilio).
 *
 * Uses Express for webhook receiving and Twilio REST API for sending.
 * Supports incoming messages with Twilio signature validation,
 * message chunking, and markdown cleanup.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';
import pino from 'pino';
import {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  WHATSAPP_OWNER_PHONE,
  WHATSAPP_FROM_PHONE,
  WHATSAPP_WEBHOOK_PORT,
} from '../config.js';
import type { NotificationDispatcher } from '../gateway/notifications.js';
import type { Gateway } from '../gateway/router.js';

const logger = pino({ name: 'clementine.whatsapp' });

const TWILIO_API_URL = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
const WHATSAPP_MAX_LENGTH = 4096;

// ── Phone hashing ─────────────────────────────────────────────────────

function hashPhone(phone: string): string {
  return createHash('sha256').update(phone).digest('hex').slice(0, 12);
}

// ── Twilio signature validation ───────────────────────────────────────

function validateTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string,
  authToken: string,
): boolean {
  // Build the data string: URL + sorted params
  let data = url;
  for (const key of Object.keys(params).sort()) {
    data += key + params[key];
  }

  const expected = createHmac('sha1', authToken).update(data).digest('base64');

  // Constant-time comparison
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ── WhatsApp formatting ───────────────────────────────────────────────

function cleanForWhatsApp(text: string): string {
  // WhatsApp supports *bold* and _italic_ natively, but not code blocks
  text = text.replace(/\*\*/g, '*'); // markdown bold -> WhatsApp bold
  text = text.replace(/```/g, '');   // code fences
  text = text.replace(/`/g, '');     // inline code
  return text;
}

function splitMessage(text: string, maxLength = WHATSAPP_MAX_LENGTH): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Find a good split point (newline or space)
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt === -1 || splitAt < maxLength / 2) {
      splitAt = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitAt === -1 || splitAt < maxLength / 2) {
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

// ── Twilio REST API sending ───────────────────────────────────────────

async function sendWhatsApp(to: string, body: string): Promise<void> {
  const params = new URLSearchParams({
    To: `whatsapp:${to}`,
    From: `whatsapp:${WHATSAPP_FROM_PHONE}`,
    Body: body,
  });

  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

  const resp = await fetch(TWILIO_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${auth}`,
    },
    body: params.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    logger.error(`Twilio send failed (${resp.status}): ${text.slice(0, 300)}`);
  }
}

// ── Entry point ───────────────────────────────────────────────────────

export async function startWhatsApp(
  gateway: Gateway,
  dispatcher: NotificationDispatcher,
): Promise<void> {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    logger.error('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set — WhatsApp channel disabled');
    return;
  }

  if (!WHATSAPP_OWNER_PHONE) {
    logger.error('WHATSAPP_OWNER_PHONE not set — WhatsApp channel disabled');
    return;
  }

  const ownerHash = hashPhone(WHATSAPP_OWNER_PHONE);
  const app = express();

  // Parse URL-encoded bodies (Twilio sends form data)
  app.use(express.urlencoded({ extended: false }));

  app.post('/webhook/whatsapp', async (req, res) => {
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.body)) {
      params[key] = String(value);
    }

    // Validate Twilio signature
    const signature = req.headers['x-twilio-signature'] as string ?? '';
    const requestUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

    if (!validateTwilioSignature(requestUrl, params, signature, TWILIO_AUTH_TOKEN)) {
      logger.warn('Invalid Twilio signature — rejecting request');
      res.status(403).send('Invalid signature');
      return;
    }

    // Extract message fields
    const body = (params.Body ?? '').trim();
    const fromNumber = (params.From ?? '').replace('whatsapp:', '');

    if (!fromNumber) {
      res.status(400).send('Missing From field');
      return;
    }

    // Owner-only check
    if (fromNumber !== WHATSAPP_OWNER_PHONE) {
      logger.warn(`Ignoring message from non-owner: ${hashPhone(fromNumber)}`);
      res.type('application/xml').send('<Response></Response>');
      return;
    }

    if (!body) {
      res.type('application/xml').send('<Response></Response>');
      return;
    }

    const sessionKey = `whatsapp:user:${ownerHash}`;
    logger.info(`WhatsApp message: ${body.slice(0, 80)}...`);

    // Return TwiML immediately; process in background
    res.type('application/xml').send('<Response></Response>');

    // Process and reply asynchronously
    try {
      const response = await gateway.handleMessage(sessionKey, body);
      if (response) {
        const clean = cleanForWhatsApp(response);
        const chunks = splitMessage(clean);
        for (const chunk of chunks) {
          await sendWhatsApp(fromNumber, chunk);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error processing WhatsApp message');
    }
  });

  // Register notification sender
  async function whatsappNotify(text: string): Promise<void> {
    const clean = cleanForWhatsApp(text);
    const chunks = splitMessage(clean);
    for (const chunk of chunks) {
      await sendWhatsApp(WHATSAPP_OWNER_PHONE, chunk);
    }
  }

  dispatcher.register('whatsapp', whatsappNotify);

  const port = WHATSAPP_WEBHOOK_PORT;
  await new Promise<void>((resolve) => {
    app.listen(port, '0.0.0.0', () => {
      logger.info(`WhatsApp webhook server listening on port ${port}`);
      resolve();
    });
  });

  // Keep alive — the Express server runs in the background
  await new Promise<void>((_, reject) => {
    process.once('SIGTERM', () => {
      dispatcher.unregister('whatsapp');
      reject(new Error('SIGTERM'));
    });
  });
}
