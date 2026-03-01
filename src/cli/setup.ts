/**
 * Interactive configuration wizard.
 *
 * Uses @inquirer/prompts for arrow-key selection, password masking,
 * and checkbox multi-select. Replaces the old readline-based flow.
 */

import { input, select, checkbox, password, confirm } from '@inquirer/prompts';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';

// ── ANSI helpers ─────────────────────────────────────────────────────

const DIM = '\x1b[0;90m';
const BOLD = '\x1b[1m';
const ORANGE = '\x1b[38;5;208m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[0;36m';
const RESET = '\x1b[0m';

const BANNER = `
${ORANGE} ██████╗██╗     ███████╗███╗   ███╗███████╗███╗   ██╗████████╗██╗███╗   ██╗███████╗
██╔════╝██║     ██╔════╝████╗ ████║██╔════╝████╗  ██║╚══██╔══╝██║████╗  ██║██╔════╝
██║     ██║     █████╗  ██╔████╔██║█████╗  ██╔██╗ ██║   ██║   ██║██╔██╗ ██║█████╗
██║     ██║     ██╔══╝  ██║╚██╔╝██║██╔══╝  ██║╚██╗██║   ██║   ██║██║╚██╗██║██╔══╝
╚██████╗███████╗███████╗██║ ╚═╝ ██║███████╗██║ ╚████║   ██║   ██║██║ ╚████║███████╗
 ╚═════╝╚══════╝╚══════╝╚═╝     ╚═╝╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝╚═╝  ╚═══╝╚══════╝${RESET}
`;

function sectionHeader(title: string): void {
  console.log();
  console.log(`  ${ORANGE}${BOLD}── ${title} ${'─'.repeat(Math.max(0, 50 - title.length))}${RESET}`);
  console.log();
}

// ── Channel / feature definitions ────────────────────────────────────

interface ChannelDef {
  value: string;
  name: string;
  credentials: CredentialDef[];
}

interface CredentialDef {
  key: string;
  label: string;
  help?: string;
  masked?: boolean;
  defaultValue?: string;
}

const CHANNELS: ChannelDef[] = [
  {
    value: 'discord',
    name: 'Discord',
    credentials: [
      {
        key: 'DISCORD_TOKEN',
        label: 'Discord bot token',
        help: `Get your bot token at ${CYAN}https://discord.com/developers/applications${DIM}\n  Create an app > Bot > Reset Token > copy it`,
        masked: true,
      },
      {
        key: 'DISCORD_OWNER_ID',
        label: 'Discord owner user ID',
        help: `Right-click your name in Discord > Copy User ID (enable Developer Mode in settings)`,
      },
    ],
  },
  {
    value: 'slack',
    name: 'Slack',
    credentials: [
      {
        key: 'SLACK_BOT_TOKEN',
        label: 'Slack bot token (xoxb-...)',
        help: `Create a Slack app at ${CYAN}https://api.slack.com/apps${DIM}\n  OAuth & Permissions > Bot User OAuth Token`,
        masked: true,
      },
      {
        key: 'SLACK_APP_TOKEN',
        label: 'Slack app token (xapp-...)',
        help: `Basic Information > App-Level Tokens > Generate`,
        masked: true,
      },
      {
        key: 'SLACK_OWNER_USER_ID',
        label: 'Slack owner user ID',
      },
    ],
  },
  {
    value: 'telegram',
    name: 'Telegram',
    credentials: [
      {
        key: 'TELEGRAM_BOT_TOKEN',
        label: 'Telegram bot token',
        help: `Message ${CYAN}@BotFather${DIM} on Telegram > /newbot > follow prompts > copy token`,
        masked: true,
      },
      {
        key: 'TELEGRAM_OWNER_ID',
        label: 'Telegram owner user ID',
        help: `Send /chatid to your bot after first launch to get your ID`,
      },
    ],
  },
  {
    value: 'whatsapp',
    name: 'WhatsApp (Twilio)',
    credentials: [
      {
        key: 'TWILIO_ACCOUNT_SID',
        label: 'Twilio Account SID',
        help: `Get credentials at ${CYAN}https://console.twilio.com${DIM}`,
      },
      {
        key: 'TWILIO_AUTH_TOKEN',
        label: 'Twilio Auth Token',
        masked: true,
      },
      {
        key: 'WHATSAPP_OWNER_PHONE',
        label: 'Owner phone (+1...)',
      },
      {
        key: 'WHATSAPP_FROM_PHONE',
        label: 'WhatsApp from phone',
      },
      {
        key: 'WHATSAPP_WEBHOOK_PORT',
        label: 'Webhook port',
        defaultValue: '8421',
      },
    ],
  },
  {
    value: 'webhook',
    name: 'Webhook API',
    credentials: [
      {
        key: 'WEBHOOK_PORT',
        label: 'Webhook port',
        defaultValue: '8420',
      },
      {
        key: 'WEBHOOK_SECRET',
        label: 'Webhook secret',
        masked: true,
      },
    ],
  },
];

interface FeatureDef {
  value: string;
  name: string;
  credentials: CredentialDef[];
}

const FEATURES: FeatureDef[] = [
  {
    value: 'voice',
    name: 'Voice (STT via Groq + TTS via ElevenLabs)',
    credentials: [
      {
        key: 'GROQ_API_KEY',
        label: 'Groq API key (for Whisper STT)',
        help: `Free tier: ${CYAN}https://console.groq.com${DIM}`,
        masked: true,
      },
      {
        key: 'ELEVENLABS_API_KEY',
        label: 'ElevenLabs API key (for TTS)',
        help: `Free tier: ${CYAN}https://elevenlabs.io${DIM}`,
        masked: true,
      },
      {
        key: 'ELEVENLABS_VOICE_ID',
        label: 'ElevenLabs voice ID',
      },
    ],
  },
  {
    value: 'video',
    name: 'Video analysis (Google Gemini)',
    credentials: [
      {
        key: 'GOOGLE_API_KEY',
        label: 'Google API key',
        help: `Get a free key at ${CYAN}https://aistudio.google.com${DIM}`,
        masked: true,
      },
    ],
  },
];

// ── Credential collection helper ─────────────────────────────────────

async function collectCredentials(
  creds: CredentialDef[],
  entries: Record<string, string>,
): Promise<void> {
  for (const cred of creds) {
    if (cred.help) {
      console.log(`  ${DIM}${cred.help}${RESET}`);
    }
    const existing = entries[cred.key] || cred.defaultValue || '';
    if (cred.masked) {
      const hint = existing ? ` ${DIM}(leave blank to keep current)${RESET}` : '';
      const val = await password({
        message: `${cred.label}${hint}`,
        mask: '*',
      });
      entries[cred.key] = val || existing;
    } else {
      entries[cred.key] = await input({
        message: cred.label,
        default: existing,
      });
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────

export async function runSetup(): Promise<void> {
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

  // ── Banner ───────────────────────────────────────────────────────
  console.log(BANNER);
  console.log(`  ${BOLD}Setup Wizard${RESET}`);
  console.log(`  ${DIM}Use arrow keys to navigate, space to toggle, enter to confirm.${RESET}`);
  console.log(`  ${DIM}Existing values are preserved as defaults.${RESET}`);

  // ── Step 1: Identity ─────────────────────────────────────────────
  sectionHeader('Step 1: Identity');

  entries['ASSISTANT_NAME'] = await input({
    message: 'Assistant name',
    default: entries['ASSISTANT_NAME'] || 'Clementine',
  });

  entries['ASSISTANT_NICKNAME'] = await input({
    message: 'Nickname',
    default: entries['ASSISTANT_NICKNAME'] || 'Clemmy',
  });

  entries['OWNER_NAME'] = await input({
    message: 'Your name',
    default: entries['OWNER_NAME'] || undefined,
  });

  // ── Step 2: Model ────────────────────────────────────────────────
  sectionHeader('Step 2: Model');

  entries['DEFAULT_MODEL_TIER'] = await select({
    message: 'Default model tier',
    default: entries['DEFAULT_MODEL_TIER'] || 'sonnet',
    choices: [
      { value: 'sonnet', name: 'sonnet  — Balanced (recommended)' },
      { value: 'haiku', name: 'haiku   — Fast and affordable' },
      { value: 'opus', name: 'opus    — Most capable' },
    ],
  });

  // ── Step 3: Channels ─────────────────────────────────────────────
  sectionHeader('Step 3: Channels');

  const selectedChannels = await checkbox({
    message: 'Which channels do you want to connect?',
    choices: CHANNELS.map((ch) => ({
      value: ch.value,
      name: ch.name,
      checked: ch.credentials.some((c) => !!entries[c.key]),
    })),
  });

  for (const channelValue of selectedChannels) {
    const channel = CHANNELS.find((c) => c.value === channelValue);
    if (!channel) continue;

    console.log();
    console.log(`  ${BOLD}${channel.name}${RESET}`);
    await collectCredentials(channel.credentials, entries);

    // Set webhook enabled flag
    if (channelValue === 'webhook') {
      entries['WEBHOOK_ENABLED'] = 'true';
    }
  }

  // ── Step 4: Optional features ────────────────────────────────────
  sectionHeader('Step 4: Optional Features');

  const selectedFeatures = await checkbox({
    message: 'Optional features to enable',
    choices: FEATURES.map((f) => ({
      value: f.value,
      name: f.name,
      checked: f.credentials.some((c) => !!entries[c.key]),
    })),
  });

  for (const featureValue of selectedFeatures) {
    const feature = FEATURES.find((f) => f.value === featureValue);
    if (!feature) continue;

    console.log();
    console.log(`  ${BOLD}${feature.name}${RESET}`);
    await collectCredentials(feature.credentials, entries);
  }

  // ── Step 5: Security ─────────────────────────────────────────────
  sectionHeader('Step 5: Security');

  const allowAll = await confirm({
    message: 'Allow all users (no owner check)?',
    default: entries['ALLOW_ALL_USERS'] === 'true',
  });
  entries['ALLOW_ALL_USERS'] = allowAll ? 'true' : 'false';

  // ── Write .env ─────────────────────────────────────────────────
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
    const hasValues = section.keys.some((k) => entries[k]);
    if (!hasValues) continue;
    lines.push(`# ${section.header}`);
    for (const key of section.keys) {
      if (entries[key] !== undefined) {
        lines.push(`${key}=${entries[key]}`);
      }
    }
    lines.push('');
  }

  writeFileSync(envPath, lines.join('\n'));

  // ── Summary ────────────────────────────────────────────────────
  console.log();
  console.log(`  ${GREEN}${BOLD}✔ Configuration written to ${envPath}${RESET}`);
  console.log();

  console.log(`  ${BOLD}Summary${RESET}`);
  console.log(`  ${DIM}${'─'.repeat(50)}${RESET}`);
  console.log(`  Assistant:  ${entries['ASSISTANT_NAME']} (${entries['ASSISTANT_NICKNAME']})`);
  console.log(`  Owner:      ${entries['OWNER_NAME'] || '(not set)'}`);
  console.log(`  Model:      ${entries['DEFAULT_MODEL_TIER']}`);
  console.log(`  Channels:   ${selectedChannels.length > 0 ? selectedChannels.join(', ') : 'none'}`);
  console.log(`  Features:   ${selectedFeatures.length > 0 ? selectedFeatures.join(', ') : 'none'}`);
  console.log(`  All users:  ${allowAll ? 'yes' : 'no (owner only)'}`);
  console.log();

  console.log(`  ${BOLD}Next steps${RESET}`);
  console.log(`  ${DIM}${'─'.repeat(50)}${RESET}`);
  console.log(`    ${BOLD}clementine launch${RESET}            Start as background daemon`);
  console.log(`    ${BOLD}clementine launch -f${RESET}         Start in foreground (debug)`);
  console.log(`    ${BOLD}clementine launch --install${RESET}  Install as login service (survives reboots)`);
  console.log(`    ${BOLD}clementine doctor${RESET}            Verify everything is configured`);
  console.log();
}
