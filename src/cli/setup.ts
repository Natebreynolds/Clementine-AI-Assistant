/**
 * Interactive configuration wizard.
 *
 * Prompts for assistant identity, channel tokens, and optional features,
 * then writes results to .env.
 */

import { createInterface, type Interface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';

// ── Helpers ──────────────────────────────────────────────────────────

function createRL(): Interface {
  return createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl: Interface, question: string, defaultValue = ''): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue);
    });
  });
}

function askYesNo(rl: Interface, question: string, defaultYes = false): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  return new Promise((resolve) => {
    rl.question(`  ${question} ${hint}: `, (answer) => {
      const val = answer.trim().toLowerCase();
      if (!val) {
        resolve(defaultYes);
      } else {
        resolve(val === 'y' || val === 'yes');
      }
    });
  });
}

// ── Main ─────────────────────────────────────────────────────────────

export async function runSetup(): Promise<void> {
  const rl = createRL();
  const envPath = path.join(BASE_DIR, '.env');
  const entries: Record<string, string> = {};

  // Load existing values if .env exists
  if (existsSync(envPath)) {
    const existing = readFileSync(envPath, 'utf-8');
    for (const line of existing.split('\n')) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match) {
        entries[match[1]] = match[2];
      }
    }
  }

  const DIM = '\x1b[0;90m';
  const BOLD = '\x1b[1m';
  const ORANGE = '\x1b[38;5;208m';
  const CYAN = '\x1b[0;36m';
  const RESET = '\x1b[0m';

  console.log();
  console.log(`  ${ORANGE}${BOLD}Clementine Setup Wizard${RESET}`);
  console.log(`  ${DIM}${'─'.repeat(40)}${RESET}`);
  console.log(`  ${DIM}Configure your assistant. Press Enter to accept defaults.${RESET}`);
  console.log(`  ${DIM}Existing values are preserved — leave blank to keep them.${RESET}`);
  console.log();

  // ── Identity ─────────────────────────────────────────────────────
  console.log(`  ${BOLD}Assistant Identity${RESET}`);
  entries['ASSISTANT_NAME'] = await ask(rl, 'Assistant name', entries['ASSISTANT_NAME'] || 'Clementine');
  entries['ASSISTANT_NICKNAME'] = await ask(rl, 'Nickname', entries['ASSISTANT_NICKNAME'] || 'Clemmy');
  entries['OWNER_NAME'] = await ask(rl, 'Your name', entries['OWNER_NAME'] || '');
  entries['DEFAULT_MODEL_TIER'] = await ask(rl, 'Model tier (haiku/sonnet/opus)', entries['DEFAULT_MODEL_TIER'] || 'sonnet');
  console.log();

  // ── Discord ──────────────────────────────────────────────────────
  if (await askYesNo(rl, 'Configure Discord?')) {
    console.log(`  ${DIM}  Get your bot token at ${CYAN}https://discord.com/developers/applications${RESET}`);
    console.log(`  ${DIM}  Create an app > Bot > Reset Token > copy it${RESET}`);
    entries['DISCORD_TOKEN'] = await ask(rl, 'Discord bot token', entries['DISCORD_TOKEN'] || '');
    console.log(`  ${DIM}  Right-click your name in Discord > Copy User ID (enable Developer Mode in settings)${RESET}`);
    entries['DISCORD_OWNER_ID'] = await ask(rl, 'Discord owner user ID', entries['DISCORD_OWNER_ID'] || '');
  }
  console.log();

  // ── Slack ────────────────────────────────────────────────────────
  if (await askYesNo(rl, 'Configure Slack?')) {
    console.log(`  ${DIM}  Create a Slack app at ${CYAN}https://api.slack.com/apps${RESET}`);
    console.log(`  ${DIM}  Bot token: OAuth & Permissions > Bot User OAuth Token (xoxb-...)${RESET}`);
    entries['SLACK_BOT_TOKEN'] = await ask(rl, 'Slack bot token (xoxb-...)', entries['SLACK_BOT_TOKEN'] || '');
    console.log(`  ${DIM}  App token: Basic Information > App-Level Tokens > Generate (xapp-...)${RESET}`);
    entries['SLACK_APP_TOKEN'] = await ask(rl, 'Slack app token (xapp-...)', entries['SLACK_APP_TOKEN'] || '');
    entries['SLACK_OWNER_USER_ID'] = await ask(rl, 'Slack owner user ID', entries['SLACK_OWNER_USER_ID'] || '');
  }
  console.log();

  // ── Telegram ─────────────────────────────────────────────────────
  if (await askYesNo(rl, 'Configure Telegram?')) {
    console.log(`  ${DIM}  Message ${CYAN}@BotFather${DIM} on Telegram > /newbot > follow prompts > copy token${RESET}`);
    entries['TELEGRAM_BOT_TOKEN'] = await ask(rl, 'Telegram bot token', entries['TELEGRAM_BOT_TOKEN'] || '');
    console.log(`  ${DIM}  Send /chatid to your bot after first launch to get your ID${RESET}`);
    entries['TELEGRAM_OWNER_ID'] = await ask(rl, 'Telegram owner user ID', entries['TELEGRAM_OWNER_ID'] || '');
  }
  console.log();

  // ── WhatsApp ─────────────────────────────────────────────────────
  if (await askYesNo(rl, 'Configure WhatsApp (Twilio)?')) {
    console.log(`  ${DIM}  Get credentials at ${CYAN}https://console.twilio.com${RESET}`);
    entries['TWILIO_ACCOUNT_SID'] = await ask(rl, 'Twilio Account SID', entries['TWILIO_ACCOUNT_SID'] || '');
    entries['TWILIO_AUTH_TOKEN'] = await ask(rl, 'Twilio Auth Token', entries['TWILIO_AUTH_TOKEN'] || '');
    entries['WHATSAPP_OWNER_PHONE'] = await ask(rl, 'Owner phone (+1...)', entries['WHATSAPP_OWNER_PHONE'] || '');
    entries['WHATSAPP_FROM_PHONE'] = await ask(rl, 'WhatsApp from phone', entries['WHATSAPP_FROM_PHONE'] || '');
    entries['WHATSAPP_WEBHOOK_PORT'] = await ask(rl, 'Webhook port', entries['WHATSAPP_WEBHOOK_PORT'] || '8421');
  }
  console.log();

  // ── Webhook ──────────────────────────────────────────────────────
  if (await askYesNo(rl, 'Configure Webhook API?')) {
    entries['WEBHOOK_ENABLED'] = 'true';
    entries['WEBHOOK_PORT'] = await ask(rl, 'Webhook port', entries['WEBHOOK_PORT'] || '8420');
    entries['WEBHOOK_SECRET'] = await ask(rl, 'Webhook secret', entries['WEBHOOK_SECRET'] || '');
  }
  console.log();

  // ── Voice ────────────────────────────────────────────────────────
  if (await askYesNo(rl, 'Configure voice (STT/TTS)?')) {
    console.log(`  ${DIM}  Groq (free): ${CYAN}https://console.groq.com${RESET}`);
    entries['GROQ_API_KEY'] = await ask(rl, 'Groq API key (for Whisper STT)', entries['GROQ_API_KEY'] || '');
    console.log(`  ${DIM}  ElevenLabs (free tier): ${CYAN}https://elevenlabs.io${RESET}`);
    entries['ELEVENLABS_API_KEY'] = await ask(rl, 'ElevenLabs API key (for TTS)', entries['ELEVENLABS_API_KEY'] || '');
    entries['ELEVENLABS_VOICE_ID'] = await ask(rl, 'ElevenLabs voice ID', entries['ELEVENLABS_VOICE_ID'] || '');
  }
  console.log();

  // ── Video ────────────────────────────────────────────────────────
  if (await askYesNo(rl, 'Configure video analysis (Gemini)?')) {
    console.log(`  ${DIM}  Get a free key at ${CYAN}https://aistudio.google.com${RESET}`);
    entries['GOOGLE_API_KEY'] = await ask(rl, 'Google API key', entries['GOOGLE_API_KEY'] || '');
  }
  console.log();

  // ── Security ─────────────────────────────────────────────────────
  const allowAll = await askYesNo(rl, 'Allow all users (no owner check)?');
  entries['ALLOW_ALL_USERS'] = allowAll ? 'true' : 'false';
  console.log();

  rl.close();

  // ── Write .env ───────────────────────────────────────────────────
  const sections = [
    { header: 'Assistant Identity', keys: ['ASSISTANT_NAME', 'ASSISTANT_NICKNAME', 'OWNER_NAME'] },
    { header: 'Model', keys: ['DEFAULT_MODEL_TIER'] },
    { header: 'Discord', keys: ['DISCORD_TOKEN', 'DISCORD_OWNER_ID'] },
    { header: 'Slack', keys: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_OWNER_USER_ID'] },
    { header: 'Telegram', keys: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_OWNER_ID'] },
    { header: 'WhatsApp (Twilio)', keys: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'WHATSAPP_OWNER_PHONE', 'WHATSAPP_FROM_PHONE', 'WHATSAPP_WEBHOOK_PORT'] },
    { header: 'Webhook API', keys: ['WEBHOOK_ENABLED', 'WEBHOOK_PORT', 'WEBHOOK_SECRET'] },
    { header: 'Voice', keys: ['GROQ_API_KEY', 'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID'] },
    { header: 'Video', keys: ['GOOGLE_API_KEY'] },
    { header: 'Security', keys: ['ALLOW_ALL_USERS'] },
  ];

  const lines: string[] = [];
  for (const section of sections) {
    lines.push(`# ${section.header}`);
    for (const key of section.keys) {
      lines.push(`${key}=${entries[key] ?? ''}`);
    }
    lines.push('');
  }

  writeFileSync(envPath, lines.join('\n'));
  console.log(`  ${BOLD}Configuration written to ${envPath}${RESET}`);
  console.log();
  console.log(`  ${DIM}Next steps:${RESET}`);
  console.log(`    ${BOLD}clementine launch${RESET}            Start as background daemon`);
  console.log(`    ${BOLD}clementine launch -f${RESET}         Start in foreground (debug)`);
  console.log(`    ${BOLD}clementine launch --install${RESET}  Install as login service (survives reboots)`);
  console.log(`    ${BOLD}clementine doctor${RESET}            Verify everything is configured`);
  console.log();
}
