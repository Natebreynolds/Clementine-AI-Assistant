/**
 * Interactive configuration wizard.
 *
 * Uses @inquirer/prompts for arrow-key selection, password masking,
 * and checkbox multi-select. Replaces the old readline-based flow.
 */

import { input, select, checkbox, password, confirm } from '@inquirer/prompts';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR, SYSTEM_DIR, PROJECTS_DIR, SOUL_FILE, MEMORY_FILE } from '../config.js';

// ── ANSI helpers ─────────────────────────────────────────────────────

const DIM = '\x1b[0;90m';
const BOLD = '\x1b[1m';
const ORANGE = '\x1b[38;5;208m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
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
  validate?: (value: string) => string | true;
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
        validate: (v) => /^\d{17,20}$/.test(v) || 'Must be a numeric Discord user ID (17-20 digits)',
      },
      {
        key: 'DISCORD_WATCHED_CHANNELS',
        label: 'Watched channel IDs (optional, comma-separated)',
        help: `Right-click a text channel > Copy Channel ID. Bot will listen for messages in these channels.`,
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
        validate: (v) => /^[UW][A-Z0-9]+$/.test(v) || 'Must be a Slack user ID (starts with U or W)',
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
        validate: (v) => /^\d+$/.test(v) || 'Must be a numeric Telegram user ID',
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
  {
    value: 'composio',
    name: 'Composio (1000+ services — Gmail, Slack, Notion, GitHub, …)',
    credentials: [
      {
        key: 'COMPOSIO_API_KEY',
        label: 'Composio API key',
        help: `Sign up at ${CYAN}https://app.composio.dev${DIM} (free tier) and copy your key from Developers > API Keys.\n  After setup, manage connections in the dashboard: Settings > Integrations.`,
        masked: true,
      },
    ],
  },
  {
    value: 'outlook',
    name: 'Outlook (Microsoft Graph — email + calendar)',
    credentials: [
      {
        key: 'MS_TENANT_ID',
        label: 'Azure AD tenant ID',
        help: `Azure Portal > App registrations > your app > Directory (tenant) ID`,
      },
      {
        key: 'MS_CLIENT_ID',
        label: 'Azure AD client (app) ID',
        help: `Azure Portal > App registrations > your app > Application (client) ID`,
      },
      {
        key: 'MS_CLIENT_SECRET',
        label: 'Azure AD client secret',
        help: `Azure Portal > App registrations > Certificates & secrets > New client secret`,
        masked: true,
      },
      {
        key: 'MS_USER_EMAIL',
        label: 'Mailbox email address',
        help: `The email address Clementine should access (e.g. you@example.com)`,
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
        validate: cred.validate,
      });
    }
  }
}

// ── Slug helper ──────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ── Style / proactivity / tone description maps ─────────────────────

const STYLE_DESCRIPTIONS: Record<string, string> = {
  concise: 'Keep responses brief and to the point',
  balanced: 'Standard responses with appropriate detail',
  detailed: 'Provide thorough explanations and context',
};

const PROACTIVITY_DESCRIPTIONS: Record<string, string> = {
  reactive: 'Only act when asked, don\'t volunteer suggestions',
  balanced: 'Offer relevant suggestions when appropriate',
  proactive: 'Actively suggest improvements and flag issues',
};

const TONE_DESCRIPTIONS: Record<string, string> = {
  professional: 'Maintain a formal, business-appropriate tone',
  casual: 'Use a friendly, conversational tone',
  minimal: 'Be terse and efficient, skip pleasantries',
};

// ── About You interview ─────────────────────────────────────────────

interface AboutYouAnswers {
  role: string;
  interests: string;
  projects: string;
  style: string;
  proactivity: string;
  tone: string;
}

async function aboutYouInterview(ownerName: string): Promise<void> {
  sectionHeader('Step 7: About You (optional)');

  console.log(`  ${DIM}These questions help me learn about you. Press Enter to skip any.${RESET}`);
  console.log();

  let answers: AboutYouAnswers;

  try {
    const role = await input({ message: 'What\'s your job title or role?' });
    const interests = await input({ message: 'What are your main interests or hobbies?' });
    const projects = await input({ message: 'What projects are you currently working on? (comma-separated)' });

    const style = await select({
      message: 'How should I communicate with you?',
      default: 'balanced',
      choices: [
        { value: 'concise', name: 'concise   — Brief and to the point' },
        { value: 'balanced', name: 'balanced  — Standard with appropriate detail' },
        { value: 'detailed', name: 'detailed  — Thorough explanations and context' },
      ],
    });

    const proactivity = await select({
      message: 'How proactive should I be?',
      default: 'balanced',
      choices: [
        { value: 'reactive', name: 'reactive   — Only act when asked' },
        { value: 'balanced', name: 'balanced   — Offer relevant suggestions' },
        { value: 'proactive', name: 'proactive  — Actively suggest improvements' },
      ],
    });

    const tone = await select({
      message: 'What tone should I use?',
      default: 'casual',
      choices: [
        { value: 'professional', name: 'professional — Formal and business-appropriate' },
        { value: 'casual', name: 'casual       — Friendly and conversational' },
        { value: 'minimal', name: 'minimal      — Terse and efficient' },
      ],
    });

    answers = { role, interests, projects, style, proactivity, tone };
  } catch {
    // User pressed Ctrl+C or prompt was cancelled — skip silently
    return;
  }

  const hasAbout = answers.role || answers.interests || answers.projects;
  const hasPrefs = answers.style || answers.proactivity || answers.tone;

  if (!hasAbout && !hasPrefs) return;

  // Ensure vault directories exist
  mkdirSync(SYSTEM_DIR, { recursive: true });
  mkdirSync(PROJECTS_DIR, { recursive: true });

  // ── Generate MEMORY.md ──────────────────────────────────────────
  const memoryLines: string[] = [
    '---',
    'type: system-memory',
    'tags:',
    '  - system',
    '  - memory',
    '---',
    '',
    '# Memory',
    '',
  ];

  if (hasAbout) {
    const displayName = ownerName || 'the Owner';
    memoryLines.push(`## About ${displayName}`, '');
    if (answers.role) memoryLines.push(`- Role: ${answers.role}`);
    if (answers.interests) memoryLines.push(`- Interests: ${answers.interests}`);
    if (answers.projects) memoryLines.push(`- Current projects: ${answers.projects}`);
    memoryLines.push('');
  }

  if (hasPrefs) {
    memoryLines.push('## Owner Preferences', '');
    if (answers.style) memoryLines.push(`- Communication style: ${answers.style}`);
    if (answers.proactivity) memoryLines.push(`- Proactivity: ${answers.proactivity}`);
    if (answers.tone) memoryLines.push(`- Tone: ${answers.tone}`);
    memoryLines.push('');
  }

  writeFileSync(MEMORY_FILE, memoryLines.join('\n'));
  console.log(`  ${GREEN}✔ Updated MEMORY.md with your preferences${RESET}`);

  // ── Update SOUL.md ──────────────────────────────────────────────
  if (hasPrefs && existsSync(SOUL_FILE)) {
    let soul = readFileSync(SOUL_FILE, 'utf-8');

    if (!soul.includes('## Owner Preferences')) {
      const prefLines: string[] = ['', '## Owner Preferences', ''];
      if (answers.style) {
        prefLines.push(`- Communication style: ${answers.style} — ${STYLE_DESCRIPTIONS[answers.style]}`);
      }
      if (answers.proactivity) {
        prefLines.push(`- Proactivity level: ${answers.proactivity} — ${PROACTIVITY_DESCRIPTIONS[answers.proactivity]}`);
      }
      if (answers.tone) {
        prefLines.push(`- Tone: ${answers.tone} — ${TONE_DESCRIPTIONS[answers.tone]}`);
      }
      prefLines.push('');

      soul = soul.trimEnd() + '\n' + prefLines.join('\n');
      writeFileSync(SOUL_FILE, soul);
      console.log(`  ${GREEN}✔ Updated SOUL.md with personality settings${RESET}`);
    }
  }

  // ── Create project notes ────────────────────────────────────────
  if (answers.projects) {
    const projectNames = answers.projects
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);

    let created = 0;
    const today = new Date().toISOString().slice(0, 10);

    for (const name of projectNames) {
      const slug = slugify(name);
      if (!slug) continue;

      const filePath = path.join(PROJECTS_DIR, `${slug}.md`);
      if (existsSync(filePath)) continue;

      const content = [
        '---',
        `created: ${today}`,
        'tags: [project]',
        '---',
        '',
        `# ${name}`,
        '',
        '(Add details about this project)',
        '',
      ].join('\n');

      writeFileSync(filePath, content);
      created++;
    }

    if (created > 0) {
      console.log(`  ${GREEN}✔ Created ${created} project note${created === 1 ? '' : 's'}${RESET}`);
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

  // ── Prerequisites check ─────────────────────────────────────────
  console.log();
  console.log(`  ${DIM}Checking prerequisites...${RESET}`);

  // Node version
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 20 || major > 24) {
    console.error(`\n  ${RED}✗${RESET} Node.js v${process.versions.node} detected — requires 20-24 LTS`);
    console.error(`    Fix: nvm install 22\n`);
    process.exit(1);
  }
  console.log(`  ${GREEN}✓${RESET} Node.js v${process.versions.node}`);

  // Claude Code CLI
  let hasClaude = false;
  try {
    execSync('which claude', { stdio: 'pipe' });
    hasClaude = true;
  } catch { /* not found */ }

  if (!hasClaude) {
    console.log(`  ${ORANGE}!${RESET} Claude Code CLI not found`);
    const installClaude = await confirm({
      message: 'Claude Code CLI is required. Install it now? (npm install -g @anthropic-ai/claude-code)',
      default: true,
    });
    if (installClaude) {
      console.log(`  ${DIM}Installing Claude Code CLI...${RESET}`);
      try {
        execSync('npm install -g @anthropic-ai/claude-code', { stdio: 'inherit' });
        console.log(`  ${GREEN}✓${RESET} Claude Code CLI installed`);
      } catch {
        console.error(`\n  ${RED}✗${RESET} Installation failed. Install manually: npm install -g @anthropic-ai/claude-code\n`);
        process.exit(1);
      }
    } else {
      console.error(`\n  ${RED}✗${RESET} Claude Code CLI is required. Install it: npm install -g @anthropic-ai/claude-code\n`);
      process.exit(1);
    }
  } else {
    console.log(`  ${GREEN}✓${RESET} Claude Code CLI`);
  }

  // better-sqlite3
  try {
    execSync('node -e "require(\'better-sqlite3\')"', { stdio: 'pipe', timeout: 5000 });
    console.log(`  ${GREEN}✓${RESET} better-sqlite3`);
  } catch {
    console.log(`  ${ORANGE}!${RESET} better-sqlite3 native module needs rebuild`);
    try {
      execSync('npm rebuild better-sqlite3', { stdio: 'pipe' });
      console.log(`  ${GREEN}✓${RESET} better-sqlite3 rebuilt`);
    } catch {
      console.log(`  ${DIM}  (non-fatal — memory search may not work until fixed)${RESET}`);
    }
  }

  console.log();

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

    // After Discord credentials: generate invite URL and offer to open it
    if (channelValue === 'discord' && entries['DISCORD_TOKEN']) {
      try {
        // Bot tokens are base64(app_id).timestamp.hmac — extract the app ID from the first segment
        const appId = Buffer.from(entries['DISCORD_TOKEN'].split('.')[0], 'base64').toString();
        if (/^\d{17,20}$/.test(appId)) {
          // Permissions: Send Messages, Read Messages, Read Message History, Embed Links,
          // Attach Files, Use Slash Commands, Add Reactions, Manage Messages
          const perms = '277025770560';
          const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot+applications.commands&permissions=${perms}`;

          console.log();
          console.log(`  ${GREEN}${BOLD}Add your bot to your Discord server:${RESET}`);
          console.log(`  ${CYAN}${inviteUrl}${RESET}`);
          console.log();

          const shouldOpen = await confirm({
            message: 'Open this link in your browser now?',
            default: true,
          });

          if (shouldOpen) {
            try {
              const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
              execSync(`${openCmd} "${inviteUrl}"`);
              console.log(`  ${DIM}Authorize the bot in your browser, then come back here.${RESET}`);

              await confirm({ message: 'Done? Press Enter to continue', default: true });
            } catch {
              console.log(`  ${DIM}Couldn't open browser — copy the link above and open it manually.${RESET}`);
            }
          }
        }
      } catch {
        // Token format unexpected — skip invite URL, non-fatal
      }
    }

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

  // ── Step 5: Workspace ──────────────────────────────────────────────
  sectionHeader('Step 5: Workspace');

  console.log(`  ${DIM}Point Clementine at parent directories containing your projects.${RESET}`);
  console.log(`  ${DIM}She'll auto-discover project roots (git repos, npm packages, etc.)${RESET}`);
  console.log();

  entries['WORKSPACE_DIRS'] = await input({
    message: 'Workspace directories (comma-separated, optional)',
    default: entries['WORKSPACE_DIRS'] || '',
  });

  // ── Step 6: Security ─────────────────────────────────────────────
  sectionHeader('Step 6: Security');

  const allowAll = await confirm({
    message: 'Allow all users (no owner check)?',
    default: entries['ALLOW_ALL_USERS'] === 'true',
  });
  entries['ALLOW_ALL_USERS'] = allowAll ? 'true' : 'false';

  // ── Step 7: About You ─────────────────────────────────────────
  await aboutYouInterview(entries['OWNER_NAME'] || '');

  // ── Write .env ─────────────────────────────────────────────────
  const sections = [
    { header: 'Assistant Identity', keys: ['ASSISTANT_NAME', 'ASSISTANT_NICKNAME', 'OWNER_NAME'] },
    { header: 'Model', keys: ['DEFAULT_MODEL_TIER'] },
    { header: 'Discord', keys: ['DISCORD_TOKEN', 'DISCORD_OWNER_ID', 'DISCORD_WATCHED_CHANNELS'] },
    { header: 'Slack', keys: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_OWNER_USER_ID'] },
    { header: 'Telegram', keys: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_OWNER_ID'] },
    { header: 'WhatsApp (Twilio)', keys: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'WHATSAPP_OWNER_PHONE', 'WHATSAPP_FROM_PHONE', 'WHATSAPP_WEBHOOK_PORT'] },
    { header: 'Webhook API', keys: ['WEBHOOK_ENABLED', 'WEBHOOK_PORT', 'WEBHOOK_SECRET'] },
    { header: 'Voice', keys: ['GROQ_API_KEY', 'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID'] },
    { header: 'Video', keys: ['GOOGLE_API_KEY'] },
    { header: 'Outlook (Microsoft Graph)', keys: ['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_USER_EMAIL'] },
    { header: 'Composio (1000+ services broker)', keys: ['COMPOSIO_API_KEY', 'COMPOSIO_USER_ID'] },
    { header: 'Workspace', keys: ['WORKSPACE_DIRS'] },
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

  // ── Step 8: Auto-start on login ───────────────────────────────────
  if (process.platform === 'darwin' || process.platform === 'linux') {
    sectionHeader('Step 8: Auto-Start');

    const serviceName = process.platform === 'darwin' ? 'LaunchAgent' : 'systemd service';
    console.log(`  ${DIM}Install a ${serviceName} so ${entries['ASSISTANT_NAME'] || 'Clementine'} starts${RESET}`);
    console.log(`  ${DIM}automatically when the system boots.${RESET}`);
    console.log();

    const installService = await confirm({
      message: 'Start automatically on boot? (recommended)',
      default: true,
    });

    if (installService) {
      // Signal to the caller that the service should be installed
      writeFileSync(path.join(BASE_DIR, '.install-service'), '');
      console.log(`  ${GREEN}✔ Will install ${serviceName} after first launch${RESET}`);
    }
  }

  console.log();
  console.log(`  ${BOLD}Next steps${RESET}`);
  console.log(`  ${DIM}${'─'.repeat(50)}${RESET}`);
  console.log(`    ${BOLD}clementine launch${RESET}    Start the assistant`);
  console.log(`    ${BOLD}clementine doctor${RESET}    Verify everything is configured`);
  console.log();
}
