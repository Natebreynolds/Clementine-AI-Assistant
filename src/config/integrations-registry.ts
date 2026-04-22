/**
 * Clementine TypeScript — Integration registry.
 *
 * Declarative metadata for every integration Clementine knows how to set up.
 * The registry is the single source of truth for:
 *   - What env vars an integration needs
 *   - Where to get each credential (doc URLs)
 *   - Whether the integration is configured right now
 *   - How to surface gaps to the owner proactively
 *
 * Used by:
 *   - integration_status()  — reports configured/partial/missing per integration
 *   - setup_integration()   — walks the owner through setup conversationally
 *   - list_integrations()   — enumerates what's available
 *   - System prompt         — "Notion is configured, Stripe needs STRIPE_API_KEY"
 *
 * Replaces the previous pattern where the agent had to recall from chat
 * history or invent which env vars a provider needs — the registry tells her
 * exactly, with docs links, so she never has to guess.
 */

export type IntegrationKind = 'api-key' | 'oauth' | 'hybrid' | 'channel';

export interface IntegrationRequirement {
  /** Env var name (uppercase, underscores). */
  envVar: string;
  /** One-line description shown during setup. */
  label: string;
  /** Whether this credential is required (false = optional). */
  required: boolean;
  /** Doc link where the owner can find or generate this credential. */
  docUrl?: string;
  /** Optional regex the value must match (for early validation). */
  pattern?: RegExp;
  /** If true, value is long-lived (API key). If false, short-lived (OAuth token). */
  persistent?: boolean;
}

export interface IntegrationDefinition {
  /** Machine-readable slug (kebab-case). */
  slug: string;
  /** Human-friendly label. */
  label: string;
  /** One-line summary shown in status output. */
  description: string;
  /** Credential style. */
  kind: IntegrationKind;
  /** Required + optional env vars. */
  requirements: IntegrationRequirement[];
  /** Top-level docs URL. */
  docUrl?: string;
  /** Tools/capabilities this integration unlocks, for the status panel. */
  capabilities?: string[];
}

/**
 * The curated registry. Keep entries alphabetical within each kind for
 * easier scanning. Adding a new integration: declare it here, and both
 * integration_status and setup_integration automatically pick it up.
 */
export const INTEGRATIONS: IntegrationDefinition[] = [
  // NOTE: Anthropic auth is handled through `clementine login` (OAuth) or
  // the ANTHROPIC_API_KEY env var — it's foundational and managed outside
  // this registry because the auth path isn't uniform.

  // ── Channels ──────────────────────────────────────────────────────
  {
    slug: 'discord',
    label: 'Discord',
    description: 'Main chat channel. Bot token + owner ID required.',
    kind: 'channel',
    docUrl: 'https://discord.com/developers/applications',
    capabilities: ['chat', 'DMs', 'agent bots', 'notifications'],
    requirements: [
      { envVar: 'DISCORD_TOKEN', label: 'Bot token', required: true, docUrl: 'https://discord.com/developers/applications', persistent: true },
      { envVar: 'DISCORD_OWNER_ID', label: 'Your Discord user ID (right-click your name → Copy User ID)', required: true, pattern: /^\d{15,22}$/, persistent: true },
    ],
  },
  {
    slug: 'slack',
    label: 'Slack',
    description: 'Alternate chat channel. Socket-mode app with bot + app tokens.',
    kind: 'channel',
    docUrl: 'https://api.slack.com/apps',
    capabilities: ['chat', 'DMs', 'channel posts'],
    requirements: [
      { envVar: 'SLACK_BOT_TOKEN', label: 'Bot token (xoxb-...)', required: true, docUrl: 'https://api.slack.com/apps', pattern: /^xoxb-/, persistent: true },
      { envVar: 'SLACK_APP_TOKEN', label: 'App-level token (xapp-...)', required: true, docUrl: 'https://api.slack.com/apps', pattern: /^xapp-/, persistent: true },
      { envVar: 'SLACK_OWNER_USER_ID', label: 'Your Slack user ID (starts with U)', required: false, pattern: /^U[A-Z0-9]{6,}$/, persistent: true },
    ],
  },
  {
    slug: 'telegram',
    label: 'Telegram',
    description: 'Chat channel via Bot API.',
    kind: 'channel',
    docUrl: 'https://core.telegram.org/bots',
    capabilities: ['chat', 'DMs'],
    requirements: [
      { envVar: 'TELEGRAM_BOT_TOKEN', label: 'Bot token from @BotFather', required: true, docUrl: 'https://t.me/BotFather', persistent: true },
      { envVar: 'TELEGRAM_OWNER_CHAT_ID', label: 'Your Telegram chat ID', required: false, pattern: /^-?\d+$/, persistent: true },
    ],
  },
  {
    slug: 'whatsapp',
    label: 'WhatsApp (via Twilio)',
    description: 'Chat channel via Twilio WhatsApp API.',
    kind: 'channel',
    docUrl: 'https://www.twilio.com/docs/whatsapp',
    capabilities: ['chat', 'DMs'],
    requirements: [
      { envVar: 'TWILIO_ACCOUNT_SID', label: 'Twilio account SID (AC...)', required: true, pattern: /^AC[a-f0-9]{32}$/i, persistent: true },
      { envVar: 'TWILIO_AUTH_TOKEN', label: 'Twilio auth token', required: true, persistent: true },
      { envVar: 'TWILIO_WHATSAPP_FROM', label: 'Twilio WhatsApp sender (whatsapp:+14155238886)', required: true, persistent: true },
      { envVar: 'WHATSAPP_OWNER_NUMBER', label: 'Your WhatsApp number (E.164 format, e.g. +15551234567)', required: true, pattern: /^\+\d{8,15}$/, persistent: true },
    ],
  },

  // ── Productivity / knowledge ──────────────────────────────────────
  {
    slug: 'notion',
    label: 'Notion',
    description: 'Read/write Notion pages and databases via integration.',
    kind: 'api-key',
    docUrl: 'https://www.notion.so/my-integrations',
    capabilities: ['docs', 'databases', 'task tracking'],
    requirements: [
      { envVar: 'NOTION_API_KEY', label: 'Internal integration secret (secret_... or ntn_...)', required: true, docUrl: 'https://www.notion.so/my-integrations', persistent: true },
    ],
  },
  {
    slug: 'linear',
    label: 'Linear',
    description: 'Issue tracking and project management.',
    kind: 'api-key',
    docUrl: 'https://linear.app/settings/api',
    capabilities: ['issues', 'projects', 'teams'],
    requirements: [
      { envVar: 'LINEAR_API_KEY', label: 'Personal API key (lin_api_...)', required: true, docUrl: 'https://linear.app/settings/api', pattern: /^lin_api_/, persistent: true },
    ],
  },
  {
    slug: 'github',
    label: 'GitHub',
    description: 'Read PRs, issues, manage releases.',
    kind: 'api-key',
    docUrl: 'https://github.com/settings/tokens',
    capabilities: ['pull requests', 'issues', 'releases'],
    requirements: [
      { envVar: 'GITHUB_TOKEN', label: 'Personal access token (ghp_... or github_pat_...)', required: true, docUrl: 'https://github.com/settings/tokens?type=beta', pattern: /^(ghp_|github_pat_)/, persistent: true },
    ],
  },

  // ── Email / calendar (OAuth) ──────────────────────────────────────
  {
    slug: 'microsoft-365',
    label: 'Microsoft 365 (Outlook/Graph)',
    description: 'Email, calendar, Teams, SharePoint via Microsoft Graph. OAuth app-only or delegated.',
    kind: 'oauth',
    docUrl: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    capabilities: ['outlook inbox', 'outlook send', 'calendar', 'teams chat'],
    requirements: [
      { envVar: 'MS_TENANT_ID', label: 'Azure AD tenant ID', required: true, pattern: /^[a-f0-9-]{36}$/i, persistent: true },
      { envVar: 'MS_CLIENT_ID', label: 'App registration client ID', required: true, pattern: /^[a-f0-9-]{36}$/i, persistent: true },
      { envVar: 'MS_CLIENT_SECRET', label: 'App registration client secret value', required: true, persistent: true },
      { envVar: 'MS_USER_EMAIL', label: 'Your primary email (used for delegated calls)', required: false, pattern: /@/, persistent: true },
    ],
  },

  // ── CRM / sales ───────────────────────────────────────────────────
  {
    slug: 'salesforce',
    label: 'Salesforce',
    description: 'CRM access via SOAP/REST. Username + password + token flow.',
    kind: 'api-key',
    docUrl: 'https://help.salesforce.com/s/articleView?id=sf.code_sample_auth_api_oauth.htm',
    capabilities: ['leads', 'contacts', 'opportunities', 'custom objects'],
    requirements: [
      { envVar: 'SF_INSTANCE_URL', label: 'Salesforce instance URL (https://your-org.my.salesforce.com)', required: true, pattern: /^https?:\/\//, persistent: true },
      { envVar: 'SF_CLIENT_ID', label: 'Connected app consumer key', required: true, persistent: true },
      { envVar: 'SF_CLIENT_SECRET', label: 'Connected app consumer secret', required: true, persistent: true },
      { envVar: 'SF_USERNAME', label: 'Salesforce username (email)', required: true, pattern: /@/, persistent: true },
      { envVar: 'SF_PASSWORD', label: 'Salesforce password + security token concatenated', required: true, persistent: true },
    ],
  },

  // ── AI auxiliaries ────────────────────────────────────────────────
  {
    slug: 'openai',
    label: 'OpenAI',
    description: 'GPT + Whisper (used for auxiliary tasks and fallback).',
    kind: 'api-key',
    docUrl: 'https://platform.openai.com/api-keys',
    capabilities: ['transcription', 'image generation', 'fallback model'],
    requirements: [
      { envVar: 'OPENAI_API_KEY', label: 'API key (sk-...)', required: true, docUrl: 'https://platform.openai.com/api-keys', pattern: /^sk-/, persistent: true },
    ],
  },
  {
    slug: 'elevenlabs',
    label: 'ElevenLabs',
    description: 'Text-to-speech for voice replies.',
    kind: 'api-key',
    docUrl: 'https://elevenlabs.io/app/settings/api-keys',
    capabilities: ['voice synthesis'],
    requirements: [
      { envVar: 'ELEVENLABS_API_KEY', label: 'API key', required: true, docUrl: 'https://elevenlabs.io/app/settings/api-keys', persistent: true },
    ],
  },
  {
    slug: 'groq',
    label: 'Groq',
    description: 'Fast inference, used for real-time transcription.',
    kind: 'api-key',
    docUrl: 'https://console.groq.com/keys',
    capabilities: ['voice transcription'],
    requirements: [
      { envVar: 'GROQ_API_KEY', label: 'API key (gsk_...)', required: true, docUrl: 'https://console.groq.com/keys', pattern: /^gsk_/, persistent: true },
    ],
  },
  {
    slug: 'google-ai',
    label: 'Google AI (Gemini)',
    description: 'Used for video analysis and multimodal tasks.',
    kind: 'api-key',
    docUrl: 'https://aistudio.google.com/apikey',
    capabilities: ['video analysis', 'multimodal'],
    requirements: [
      { envVar: 'GOOGLE_API_KEY', label: 'Gemini API key', required: true, docUrl: 'https://aistudio.google.com/apikey', persistent: true },
    ],
  },

  // ── Payments ──────────────────────────────────────────────────────
  {
    slug: 'stripe',
    label: 'Stripe',
    description: 'Payments read/write (one-off or recurring).',
    kind: 'api-key',
    docUrl: 'https://dashboard.stripe.com/apikeys',
    capabilities: ['customers', 'payments', 'subscriptions'],
    requirements: [
      { envVar: 'STRIPE_SECRET_KEY', label: 'Secret key (sk_live_... or sk_test_...)', required: true, docUrl: 'https://dashboard.stripe.com/apikeys', pattern: /^sk_(live|test)_/, persistent: true },
    ],
  },
];

export type IntegrationStatus = 'configured' | 'partial' | 'missing';

export interface IntegrationStatusReport {
  slug: string;
  label: string;
  status: IntegrationStatus;
  /** All required env vars that are currently set. */
  have: string[];
  /** Required env vars that are missing. */
  missing: string[];
  /** Optional env vars that are missing (informational only). */
  optionalMissing: string[];
  /** Helpful setup link. */
  docUrl?: string;
}

/**
 * Classify each integration against the current environment.
 * Pure function — caller passes in env so this is testable.
 */
export function classifyIntegrations(
  env: NodeJS.ProcessEnv,
  slugs?: string[],
): IntegrationStatusReport[] {
  const targets = slugs?.length
    ? INTEGRATIONS.filter(i => slugs.includes(i.slug))
    : INTEGRATIONS;

  return targets.map(integration => {
    const required = integration.requirements.filter(r => r.required);
    const optional = integration.requirements.filter(r => !r.required);

    const have: string[] = [];
    const missing: string[] = [];
    for (const req of required) {
      if (env[req.envVar]) have.push(req.envVar);
      else missing.push(req.envVar);
    }
    const optionalMissing = optional
      .filter(r => !env[r.envVar])
      .map(r => r.envVar);

    let status: IntegrationStatus;
    if (missing.length === 0 && have.length > 0) status = 'configured';
    else if (have.length > 0) status = 'partial';
    else status = 'missing';

    // Special case for hybrid: "have" counts if ANY required-or-alternative is set.
    if (integration.kind === 'hybrid' && missing.length > 0 && integration.requirements.some(r => env[r.envVar])) {
      status = 'configured';
    }

    return {
      slug: integration.slug,
      label: integration.label,
      status,
      have,
      missing,
      optionalMissing,
      docUrl: integration.docUrl,
    };
  });
}

export function findIntegration(slug: string): IntegrationDefinition | undefined {
  const normalized = slug.trim().toLowerCase();
  return INTEGRATIONS.find(i => i.slug === normalized);
}

/** A short one-line summary for prompt injection. */
export function summarizeIntegrationStatus(env: NodeJS.ProcessEnv): string {
  const reports = classifyIntegrations(env);
  const configured = reports.filter(r => r.status === 'configured').map(r => r.label);
  const partial = reports.filter(r => r.status === 'partial').map(r => `${r.label} (missing ${r.missing.join(', ')})`);
  const missing = reports.filter(r => r.status === 'missing').map(r => r.label);
  const lines: string[] = [];
  if (configured.length > 0) lines.push(`**Configured:** ${configured.join(', ')}`);
  if (partial.length > 0) lines.push(`**Partial:** ${partial.join('; ')}`);
  if (missing.length > 0) lines.push(`**Available but not configured:** ${missing.join(', ')}`);
  return lines.join('\n');
}
