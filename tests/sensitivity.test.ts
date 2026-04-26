import { describe, expect, it } from 'vitest';
import { isSensitiveEnvKey } from '../src/secrets/sensitivity.js';

describe('isSensitiveEnvKey', () => {
  describe('credential-shaped keys → sensitive', () => {
    const sensitive = [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'STRIPE_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'DISCORD_TOKEN',
      'SLACK_BOT_TOKEN',
      'SLACK_APP_TOKEN',
      'TELEGRAM_BOT_TOKEN',
      'WEBHOOK_SECRET',
      'SF_CLIENT_SECRET',
      'MS_CLIENT_SECRET',
      'TWILIO_AUTH_TOKEN',
      'TWILIO_ACCOUNT_SID',
      'GROQ_API_KEY',
      'ELEVENLABS_API_KEY',
      'GOOGLE_API_KEY',
      'SF_PASSWORD',
      'GITHUB_PRIVATE_KEY',
      'AWS_CREDENTIALS',
    ];
    for (const key of sensitive) {
      it(`${key} → sensitive`, () => {
        expect(isSensitiveEnvKey(key)).toBe(true);
      });
    }
  });

  describe('config-shaped keys → not sensitive', () => {
    const config = [
      'OWNER_NAME',
      'ASSISTANT_NAME',
      'TIMEZONE',
      'BUDGET_HEARTBEAT_USD',
      'BUDGET_CRON_T1_USD',
      'BUDGET_CRON_T2_USD',
      'BUDGET_CHAT_USD',
      'HEARTBEAT_INTERVAL_MINUTES',
      'HEARTBEAT_ACTIVE_START',
      'HEARTBEAT_ACTIVE_END',
      'UNLEASHED_PHASE_TURNS',
      'DEFAULT_MODEL_TIER',
      'WEBHOOK_PORT',
      'WEBHOOK_BIND',
      'WEBHOOK_ENABLED',
      'WHATSAPP_OWNER_PHONE',
      'WHATSAPP_FROM_PHONE',
      'DISCORD_OWNER_ID',
      'TELEGRAM_OWNER_ID',
      'SF_INSTANCE_URL',
      'SF_API_VERSION',
      'CLEMENTINE_ADVISOR_RULES_LOADER',
    ];
    for (const key of config) {
      it(`${key} → not sensitive`, () => {
        expect(isSensitiveEnvKey(key)).toBe(false);
      });
    }
  });

  it('case-insensitive', () => {
    expect(isSensitiveEnvKey('stripe_api_key')).toBe(true);
    expect(isSensitiveEnvKey('budget_chat_usd')).toBe(false);
  });
});
