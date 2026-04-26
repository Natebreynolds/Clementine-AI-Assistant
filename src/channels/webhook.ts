/**
 * Clementine TypeScript — HTTP API webhook server.
 *
 * Provides a REST API for programmatic access to the assistant.
 * Uses Express with Bearer token authentication.
 */

import express from 'express';
import pino from 'pino';
import { WEBHOOK_BIND, WEBHOOK_PORT, WEBHOOK_SECRET } from '../config.js';
import type { Gateway } from '../gateway/router.js';

const logger = pino({ name: 'clementine.webhook' });

// ── Entry point ───────────────────────────────────────────────────────

export async function startWebhook(gateway: Gateway): Promise<void> {
  if (!WEBHOOK_SECRET) {
    throw new Error(
      'WEBHOOK_ENABLED=true requires WEBHOOK_SECRET to be set. Refusing to start an unauthenticated webhook server.',
    );
  }

  const app = express();
  app.use(express.json());

  // ── Bearer token auth middleware ──────────────────────────────────

  function requireAuth(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): void {
    const authHeader = req.headers.authorization ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!token || token !== WEBHOOK_SECRET) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  }

  // ── POST /api/message — process a message ─────────────────────────

  app.post('/api/message', requireAuth, async (req, res) => {
    const { text, session_key: sessionKey, model } = req.body as {
      text?: string;
      session_key?: string;
      model?: string;
    };

    if (!text) {
      res.status(400).json({ error: 'Missing "text" field' });
      return;
    }

    const effectiveSessionKey = sessionKey ?? 'webhook:default';

    try {
      const response = await gateway.handleMessage(effectiveSessionKey, text, undefined, model);
      res.json({ response, session_key: effectiveSessionKey });
    } catch (err) {
      logger.error({ err }, 'Webhook message processing failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── POST /webhook/:source — generic webhook intake ────────────────

  app.post('/webhook/:source', requireAuth, async (req, res) => {
    const source = req.params.source;
    const body = req.body as Record<string, unknown>;
    const text = String(body.text ?? body.message ?? body.content ?? JSON.stringify(body));
    const sessionKey = `webhook:${source}`;

    try {
      const response = await gateway.handleMessage(sessionKey, text);
      res.json({ response, source, session_key: sessionKey });
    } catch (err) {
      logger.error({ err, source }, 'Webhook intake processing failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/status — health check (auth-gated to avoid uptime leakage) ──

  app.get('/api/status', requireAuth, (_req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // ── Start server ──────────────────────────────────────────────────

  const port = WEBHOOK_PORT;
  const bind = WEBHOOK_BIND;
  if (bind !== '127.0.0.1' && bind !== 'localhost') {
    logger.warn({ bind }, '⚠ Webhook bound to non-localhost address — bearer auth is your only protection. Prefer tunneling (cloudflared) over exposing directly.');
  }
  await new Promise<void>((resolve) => {
    app.listen(port, bind, () => {
      logger.info({ bind, port }, 'Webhook API server listening');
      resolve();
    });
  });

  // Keep alive
  await new Promise<void>((_, reject) => {
    process.once('SIGTERM', () => reject(new Error('SIGTERM')));
  });
}
