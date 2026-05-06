/**
 * Gemini Live voice relay.
 *
 * The browser/Electron renderer connects to this local WebSocket. The relay
 * owns the Google API key and forwards raw PCM audio to Gemini Live over the
 * upstream WebSocket API.
 */

import type http from 'node:http';
import type { Duplex } from 'node:stream';
import { createRequire } from 'node:module';
import { URL } from 'node:url';
import pino from 'pino';

import {
  GEMINI_API_KEY,
  GEMINI_LIVE_MODEL,
  GEMINI_LIVE_VOICE_NAME,
  VOICE_ENABLED,
  VOICE_PROVIDER,
} from '../config.js';

const logger = pino({ name: 'clementine.gemini-live' });
const require = createRequire(import.meta.url);
const GEMINI_WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const WS_OPEN = 1;

type WebSocketLike = {
  readyState: number;
  send(data: string, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate?: () => void;
  on(event: string, listener: (...args: any[]) => void): void;
};

type WebSocketServerLike = {
  on(event: string, listener: (...args: any[]) => void): void;
  handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, cb: (ws: WebSocketLike) => void): void;
  emit(event: string, ...args: any[]): boolean;
  close(cb?: () => void): void;
};

type WsModule = {
  WebSocket: new (url: string) => WebSocketLike;
  WebSocketServer: new (opts: { noServer: true; maxPayload?: number }) => WebSocketServerLike;
};

export type GeminiLiveStatus = {
  enabled: boolean;
  provider: string;
  configured: boolean;
  available: boolean;
  model: string;
  voiceName: string;
  reason?: string;
};

export type GeminiLiveRelayHandle = {
  available: boolean;
  close: () => void;
};

export type GeminiLiveRelayOptions = {
  isTokenValid: (token: string) => boolean;
};

type GeminiSetupOptions = {
  model?: string;
  voiceName?: string;
  systemInstruction?: string;
};

function runtimeValue(key: string, fallback = ''): string {
  return String(process.env[key] ?? fallback ?? '').trim();
}

function currentApiKey(): string {
  return runtimeValue('GEMINI_API_KEY', GEMINI_API_KEY) || runtimeValue('GOOGLE_API_KEY');
}

function currentModel(): string {
  return runtimeValue('GEMINI_LIVE_MODEL', GEMINI_LIVE_MODEL) || 'gemini-3.1-flash-live-preview';
}

function currentVoiceName(): string {
  return runtimeValue('GEMINI_LIVE_VOICE_NAME', GEMINI_LIVE_VOICE_NAME) || 'Kore';
}

function currentVoiceProvider(): string {
  return runtimeValue('VOICE_PROVIDER', VOICE_PROVIDER) || 'gemini-live';
}

function currentVoiceEnabled(): boolean {
  return runtimeValue('VOICE_ENABLED', String(VOICE_ENABLED)).toLowerCase() !== 'false';
}

function loadWs(): WsModule | null {
  try {
    return require('ws') as WsModule;
  } catch (err) {
    logger.warn({ err }, 'ws package is not available; Gemini Live relay disabled');
    return null;
  }
}

function stripModelsPrefix(model: string): string {
  return model.replace(/^models\//, '').trim();
}

export function buildGeminiLiveSetup(opts: GeminiSetupOptions = {}): Record<string, unknown> {
  const model = stripModelsPrefix(opts.model || currentModel());
  const voiceName = opts.voiceName || currentVoiceName();
  const systemInstruction = opts.systemInstruction
    || 'You are Clementine, a concise voice assistant. Keep spoken replies brief and conversational unless the user asks for detail.';
  const config: Record<string, unknown> = {
    model: `models/${model}`,
    responseModalities: ['AUDIO'],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    systemInstruction: {
      parts: [{ text: systemInstruction }],
    },
  };
  if (voiceName) {
    config.speechConfig = {
      voiceConfig: {
        prebuiltVoiceConfig: { voiceName },
      },
    };
  }
  return { config };
}

export function getGeminiLiveStatus(): GeminiLiveStatus {
  const enabled = currentVoiceEnabled();
  const provider = currentVoiceProvider();
  const configured = Boolean(currentApiKey());
  const wsAvailable = Boolean(loadWs());
  const available = enabled && provider === 'gemini-live' && configured && wsAvailable;
  const reason = !enabled
    ? 'VOICE_ENABLED=false'
    : provider !== 'gemini-live'
      ? `VOICE_PROVIDER=${provider}`
      : !configured
        ? 'Set GEMINI_API_KEY or GOOGLE_API_KEY'
        : !wsAvailable
          ? 'Install ws'
          : undefined;
  return {
    enabled,
    provider,
    configured,
    available,
    model: currentModel(),
    voiceName: currentVoiceName(),
    ...(reason ? { reason } : {}),
  };
}

function sendJson(ws: WebSocketLike, payload: Record<string, unknown>): void {
  if (ws.readyState !== WS_OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (err) {
    logger.debug({ err }, 'Gemini Live client send failed');
  }
}

function closeSocket(ws: WebSocketLike | null, code = 1000, reason = 'closed'): void {
  if (!ws) return;
  try {
    ws.close(code, reason);
  } catch {
    try { ws.terminate?.(); } catch { /* ignore */ }
  }
}

function connectGemini(wsMod: WsModule, client: WebSocketLike, query: URLSearchParams): WebSocketLike | null {
  const apiKey = currentApiKey();
  if (!apiKey) {
    sendJson(client, { type: 'error', error: 'Gemini Live is not configured. Set GEMINI_API_KEY or GOOGLE_API_KEY.' });
    closeSocket(client, 1011, 'Gemini API key missing');
    return null;
  }

  const upstreamUrl = `${GEMINI_WS_URL}?key=${encodeURIComponent(apiKey)}`;
  const upstream = new wsMod.WebSocket(upstreamUrl);
  const pending: string[] = [];
  let upstreamOpen = false;

  const flush = (): void => {
    if (!upstreamOpen || upstream.readyState !== WS_OPEN) return;
    while (pending.length > 0) upstream.send(pending.shift()!);
  };

  const sendUpstream = (payload: Record<string, unknown>): void => {
    const text = JSON.stringify(payload);
    if (upstreamOpen && upstream.readyState === WS_OPEN) upstream.send(text);
    else pending.push(text);
  };

  upstream.on('open', () => {
    upstreamOpen = true;
    const setup = buildGeminiLiveSetup({
      model: query.get('model') || undefined,
      voiceName: query.get('voice') || undefined,
    });
    upstream.send(JSON.stringify(setup));
    flush();
    sendJson(client, { type: 'ready', model: currentModel(), voiceName: currentVoiceName() });
  });

  upstream.on('message', (data: Buffer | string) => {
    let response: Record<string, any>;
    try {
      response = JSON.parse(String(data)) as Record<string, any>;
    } catch {
      sendJson(client, { type: 'raw', data: String(data) });
      return;
    }

    const content = response.serverContent;
    if (content?.modelTurn?.parts) {
      for (const part of content.modelTurn.parts) {
        const inline = part.inlineData;
        if (inline?.data) {
          sendJson(client, {
            type: 'audio',
            data: inline.data,
            mimeType: inline.mimeType || 'audio/pcm;rate=24000',
          });
        }
      }
    }
    if (content?.inputTranscription?.text) {
      sendJson(client, { type: 'transcript', role: 'user', text: content.inputTranscription.text });
    }
    if (content?.outputTranscription?.text) {
      sendJson(client, { type: 'transcript', role: 'assistant', text: content.outputTranscription.text });
    }
    if (content?.interrupted) {
      sendJson(client, { type: 'interrupted' });
    }
    if (content?.turnComplete) {
      sendJson(client, { type: 'turn_complete' });
    }
    if (response.toolCall) {
      sendJson(client, { type: 'tool_call', toolCall: response.toolCall });
    }
    sendJson(client, { type: 'event', event: response });
  });

  upstream.on('error', (err: Error) => {
    logger.warn({ err }, 'Gemini Live upstream error');
    sendJson(client, { type: 'error', error: err.message || String(err) });
  });

  upstream.on('close', (code: number, reason: Buffer) => {
    sendJson(client, { type: 'closed', code, reason: reason?.toString?.() || '' });
    closeSocket(client, 1000, 'Gemini Live upstream closed');
  });

  client.on('message', (data: Buffer | string) => {
    let message: Record<string, any>;
    try {
      message = JSON.parse(String(data)) as Record<string, any>;
    } catch {
      sendJson(client, { type: 'error', error: 'Invalid voice message JSON' });
      return;
    }

    if (message.type === 'audio' && message.data) {
      sendUpstream({
        realtimeInput: {
          audio: {
            data: String(message.data),
            mimeType: String(message.mimeType || 'audio/pcm;rate=16000'),
          },
        },
      });
    } else if (message.type === 'text' && message.text) {
      sendUpstream({ realtimeInput: { text: String(message.text) } });
    } else if (message.type === 'audio_stream_end' || message.type === 'stop') {
      sendUpstream({ realtimeInput: { audioStreamEnd: true } });
    }
  });

  client.on('close', () => closeSocket(upstream));
  client.on('error', () => closeSocket(upstream));
  return upstream;
}

export function installGeminiLiveRelay(
  server: http.Server,
  opts: GeminiLiveRelayOptions,
): GeminiLiveRelayHandle {
  const wsMod = loadWs();
  if (!wsMod) return { available: false, close: () => undefined };

  const wss = new wsMod.WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  wss.on('connection', (client: WebSocketLike, req: http.IncomingMessage) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    connectGemini(wsMod, client, url.searchParams);
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname !== '/api/voice/live/ws') return;
    const token = url.searchParams.get('token') || '';
    const status = getGeminiLiveStatus();
    if (!opts.isTokenValid(token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!status.available) {
      socket.write(`HTTP/1.1 503 Service Unavailable\r\n\r\n${status.reason || 'Gemini Live unavailable'}`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  logger.info('Gemini Live relay attached to dashboard server');
  return {
    available: true,
    close: () => wss.close(),
  };
}
