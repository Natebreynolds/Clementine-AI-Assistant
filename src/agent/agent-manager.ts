/**
 * Clementine TypeScript — Agent manager (scoped multi-agent system).
 *
 * Loads agent profiles from two sources:
 *   1. vault/00-System/agents/{slug}/agent.md  — new agent directory format
 *   2. vault/00-System/profiles/*.md           — legacy profile files
 *
 * Same slug in agents/ wins over profiles/ (agents/ is the primary source).
 * Uses the same 60s TTL cache as ProfileManager.
 *
 * Provides CRUD operations for creating/updating/deleting agents.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { AgentProfile, AgentStatus, SendPolicy, TeamAgentConfig } from '../types.js';
import { ProfileManager } from './profiles.js';
import { getScaffoldForRole } from './role-scaffolds.js';

// ── Keychain helpers for agent secrets ────────────────────────────────

function storeAgentSecret(slug: string, key: string, value: string): void {
  execSync(
    `security add-generic-password -U -s "clementine" -a "AGENT_${slug.toUpperCase()}_${key}" -w "${value}"`,
    { stdio: 'pipe', timeout: 3000 },
  );
}

function getAgentSecret(slug: string, key: string): string {
  try {
    return execSync(
      `security find-generic-password -s "clementine" -a "AGENT_${slug.toUpperCase()}_${key}" -w`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000 },
    ).trim();
  } catch {
    return '';
  }
}

function deleteAgentSecret(slug: string, key: string): void {
  try {
    execSync(
      `security delete-generic-password -s "clementine" -a "AGENT_${slug.toUpperCase()}_${key}"`,
      { stdio: 'pipe', timeout: 3000 },
    );
  } catch { /* not found — ok */ }
}

const CACHE_TTL_MS = 60_000;

export interface AgentCreateConfig {
  name: string;
  description: string;
  personality?: string;            // System prompt body
  tier?: number;
  model?: string;
  avatar?: string;
  channelName?: string | string[];  // Single channel name or array of channel names
  teamChat?: boolean;              // If true, shared team channel — agents respond when @mentioned
  respondToAll?: boolean;          // If true, agent responds to all messages even in team chat
  canMessage?: string[];
  allowedTools?: string[];
  allowedUsers?: string[];           // Discord/Slack user IDs that can interact with this agent
  project?: string;
  projects?: string[];
  discordToken?: string;           // Dedicated Discord bot token
  discordChannelId?: string;       // Channel ID for bot to listen in
  slackBotToken?: string;          // Slack bot token (xoxb-...)
  slackAppToken?: string;          // Slack app token (xapp-...)
  slackChannelId?: string;         // Explicit Slack channel ID override
  sendPolicy?: SendPolicy;         // Autonomous outbound email policy
  role?: string;                   // Role template (e.g., 'sdr', 'researcher') — auto-scaffolds working directory
  status?: AgentStatus;            // Initial status (default: active)
  budgetMonthlyCents?: number;     // Monthly token budget in cents (0 = unlimited)
}

export class AgentManager {
  private agentsDir: string;
  private legacyManager: ProfileManager;
  private cache = new Map<string, AgentProfile>();
  private cacheTime = 0;

  constructor(agentsDir: string, legacyProfilesDir: string) {
    this.agentsDir = agentsDir;
    this.legacyManager = new ProfileManager(legacyProfilesDir);
  }

  private refreshIfStale(): void {
    const now = Date.now();
    if (now - this.cacheTime < CACHE_TTL_MS && this.cache.size > 0) {
      return;
    }

    const profiles = new Map<string, AgentProfile>();

    // 1. Load from agents/{slug}/agent.md (primary)
    if (fs.existsSync(this.agentsDir)) {
      try {
        const dirs = fs.readdirSync(this.agentsDir, { withFileTypes: true })
          .filter(d => d.isDirectory() && !d.name.startsWith('_'))
          .map(d => d.name)
          .sort();

        for (const slug of dirs) {
          const agentFile = path.join(this.agentsDir, slug, 'agent.md');
          if (!fs.existsSync(agentFile)) continue;

          try {
            const profile = this.loadAgentFile(agentFile, slug);
            profiles.set(slug, profile);
          } catch {
            // Skip malformed agent files
          }
        }
      } catch {
        // agents dir not readable
      }
    }

    // 2. Load legacy profiles (only for slugs not already loaded)
    for (const legacy of this.legacyManager.listAll()) {
      if (!profiles.has(legacy.slug)) {
        profiles.set(legacy.slug, legacy);
      }
    }

    this.cache = profiles;
    this.cacheTime = now;
  }

  private loadAgentFile(filePath: string, slug: string): AgentProfile {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const { data: meta, content } = matter(raw);

    // Cap tier at 2 — agents can never grant Tier 3
    const tier = Math.min(Number(meta.tier ?? 1), 2);

    // Parse team-specific frontmatter
    let team: TeamAgentConfig | undefined;
    const channelName: string | string[] | undefined = Array.isArray(meta.channelName)
      ? meta.channelName.map(String).filter(Boolean)
      : meta.channelName ? String(meta.channelName) : undefined;
    const canMessage = Array.isArray(meta.canMessage)
      ? meta.canMessage.map(String).filter(Boolean)
      : [];
    const allowedTools = Array.isArray(meta.allowedTools)
      ? meta.allowedTools.map(String).filter(Boolean)
      : undefined;
    const allowedUsers = Array.isArray(meta.allowedUsers)
      ? meta.allowedUsers.map(String).filter(Boolean)
      : typeof meta.allowedUsers === 'string'
        ? meta.allowedUsers.split(',').map((s: string) => s.trim()).filter(Boolean)
        : undefined;

    if (channelName && (typeof channelName === 'string' || channelName.length > 0)) {
      const teamChat = meta.teamChat === true || meta.teamChat === 'true';
      const respondToAll = meta.respondToAll === true || meta.respondToAll === 'true';
      team = { channelName, channels: [], canMessage, allowedTools, allowedUsers, teamChat, respondToAll: respondToAll || undefined };
    }

    // Resolve Discord token — migrate plaintext to Keychain if needed
    let discordToken: string | undefined;
    if (meta.discordToken) {
      const raw = String(meta.discordToken);
      if (raw === 'keychain') {
        discordToken = getAgentSecret(slug, 'DISCORD_TOKEN') || undefined;
      } else {
        // Plaintext token in frontmatter — migrate to Keychain
        discordToken = raw;
        try {
          storeAgentSecret(slug, 'DISCORD_TOKEN', raw);
          meta.discordToken = 'keychain';
          const updated = matter.stringify(content, meta);
          fs.writeFileSync(filePath, updated);
        } catch { /* migration failed — continue with plaintext */ }
      }
    }

    // Resolve Slack tokens — same keychain migration pattern as Discord
    let slackBotToken: string | undefined;
    if (meta.slackBotToken) {
      const rawSlack = String(meta.slackBotToken);
      if (rawSlack === 'keychain') {
        slackBotToken = getAgentSecret(slug, 'SLACK_BOT_TOKEN') || undefined;
      } else {
        slackBotToken = rawSlack;
        try {
          storeAgentSecret(slug, 'SLACK_BOT_TOKEN', rawSlack);
          meta.slackBotToken = 'keychain';
          const updated = matter.stringify(content, meta);
          fs.writeFileSync(filePath, updated);
        } catch { /* migration failed — continue with plaintext */ }
      }
    }

    let slackAppToken: string | undefined;
    if (meta.slackAppToken) {
      const rawApp = String(meta.slackAppToken);
      if (rawApp === 'keychain') {
        slackAppToken = getAgentSecret(slug, 'SLACK_APP_TOKEN') || undefined;
      } else {
        slackAppToken = rawApp;
        try {
          storeAgentSecret(slug, 'SLACK_APP_TOKEN', rawApp);
          meta.slackAppToken = 'keychain';
          const updated = matter.stringify(content, meta);
          fs.writeFileSync(filePath, updated);
        } catch { /* migration failed — continue with plaintext */ }
      }
    }

    // Parse sendPolicy from frontmatter
    let sendPolicy: SendPolicy | undefined;
    if (meta.sendPolicy && typeof meta.sendPolicy === 'object') {
      const sp = meta.sendPolicy;
      const requiresApproval = ['none', 'first-in-sequence', 'all'].includes(sp.requiresApproval)
        ? sp.requiresApproval as SendPolicy['requiresApproval']
        : 'all';
      sendPolicy = {
        maxDailyEmails: Number(sp.maxDailyEmails ?? 50),
        requiresApproval,
        businessHoursOnly: sp.businessHoursOnly === true || sp.businessHoursOnly === 'true',
      };
      if (Array.isArray(sp.allowedTemplates) && sp.allowedTemplates.length > 0) {
        sendPolicy.allowedTemplates = sp.allowedTemplates.map(String);
      }
    }

    return {
      slug,
      name: String(meta.name ?? slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())),
      tier,
      description: String(meta.description ?? ''),
      systemPromptBody: content.trim(),
      model: meta.model ? String(meta.model) : undefined,
      avatar: meta.avatar ? String(meta.avatar) : undefined,
      team,
      project: meta.project ? String(meta.project) : undefined,
      projects: Array.isArray(meta.projects) ? meta.projects.map(String) : undefined,
      agentDir: path.dirname(filePath),
      discordToken,
      discordChannelId: meta.discordChannelId ? String(meta.discordChannelId) : undefined,
      slackBotToken,
      slackAppToken,
      slackChannelId: meta.slackChannelId ? String(meta.slackChannelId) : undefined,
      sendPolicy,
      allowedMcpServers: Array.isArray(meta.allowedMcpServers)
        ? meta.allowedMcpServers.map(String).filter(Boolean)
        : undefined,
      status: (['active', 'paused', 'error', 'terminated'].includes(meta.status) ? meta.status : 'active') as AgentStatus,
      budgetMonthlyCents: meta.budgetMonthlyCents ? Number(meta.budgetMonthlyCents) : undefined,
    };
  }

  // ── ProfileManager-compatible interface ───────────────────────────

  get(slug: string): AgentProfile | null {
    this.refreshIfStale();
    return this.cache.get(slug) ?? null;
  }

  listAll(): AgentProfile[] {
    this.refreshIfStale();
    return [...this.cache.values()];
  }

  // ── Agent directory helpers ───────────────────────────────────────

  /** Get the agent's directory path (only for agents/ dir agents, not legacy). */
  getAgentDir(slug: string): string | null {
    const dir = path.join(this.agentsDir, slug);
    return fs.existsSync(path.join(dir, 'agent.md')) ? dir : null;
  }

  /** Check if an agent has its own CRON.md. */
  hasOwnCron(slug: string): boolean {
    const dir = this.getAgentDir(slug);
    return dir !== null && fs.existsSync(path.join(dir, 'CRON.md'));
  }

  /** Check if an agent has its own workflows directory. */
  hasOwnWorkflows(slug: string): boolean {
    const dir = this.getAgentDir(slug);
    return dir !== null && fs.existsSync(path.join(dir, 'workflows'));
  }

  /** Get the path to an agent's CRON.md (or null). */
  getCronPath(slug: string): string | null {
    const dir = this.getAgentDir(slug);
    if (!dir) return null;
    const cronPath = path.join(dir, 'CRON.md');
    return fs.existsSync(cronPath) ? cronPath : null;
  }

  /** Get the path to an agent's workflows directory (or null). */
  getWorkflowsDir(slug: string): string | null {
    const dir = this.getAgentDir(slug);
    if (!dir) return null;
    const wfDir = path.join(dir, 'workflows');
    return fs.existsSync(wfDir) ? wfDir : null;
  }

  // ── CRUD ──────────────────────────────────────────────────────────

  createAgent(config: AgentCreateConfig): AgentProfile {
    const slug = config.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const agentDir = path.join(this.agentsDir, slug);

    if (fs.existsSync(path.join(agentDir, 'agent.md'))) {
      throw new Error(`Agent '${slug}' already exists.`);
    }

    // Ensure directories exist
    fs.mkdirSync(agentDir, { recursive: true });

    // Build frontmatter
    const frontmatter: Record<string, unknown> = {
      name: config.name,
      description: config.description,
      tier: Math.min(config.tier ?? 2, 2),
    };
    if (config.model) frontmatter.model = config.model;
    if (config.avatar) frontmatter.avatar = config.avatar;
    if (config.channelName) frontmatter.channelName = config.channelName;
    if (config.teamChat) frontmatter.teamChat = config.teamChat;
    if (config.respondToAll) frontmatter.respondToAll = config.respondToAll;
    if (config.canMessage?.length) frontmatter.canMessage = config.canMessage;
    if (config.allowedTools?.length) frontmatter.allowedTools = config.allowedTools;
    if (config.allowedUsers?.length) frontmatter.allowedUsers = config.allowedUsers;
    if (config.project) frontmatter.project = config.project;
    if (config.discordToken) {
      storeAgentSecret(slug, 'DISCORD_TOKEN', config.discordToken);
      frontmatter.discordToken = 'keychain';
    }
    if (config.discordChannelId) frontmatter.discordChannelId = config.discordChannelId;
    if (config.slackBotToken) {
      storeAgentSecret(slug, 'SLACK_BOT_TOKEN', config.slackBotToken);
      frontmatter.slackBotToken = 'keychain';
    }
    if (config.slackAppToken) {
      storeAgentSecret(slug, 'SLACK_APP_TOKEN', config.slackAppToken);
      frontmatter.slackAppToken = 'keychain';
    }
    if (config.slackChannelId) frontmatter.slackChannelId = config.slackChannelId;
    if (config.sendPolicy) frontmatter.sendPolicy = config.sendPolicy;
    if (config.status) frontmatter.status = config.status;
    if (config.budgetMonthlyCents) frontmatter.budgetMonthlyCents = config.budgetMonthlyCents;

    const body = config.personality || `You are ${config.name}. ${config.description}`;
    const content = matter.stringify(body, frontmatter);
    fs.writeFileSync(path.join(agentDir, 'agent.md'), content);

    // Scaffold role-specific working directory (CRON.md, playbook, sequences)
    if (config.role) {
      const scaffolder = getScaffoldForRole(config.role);
      if (scaffolder) {
        const scaffold = scaffolder(config.name, slug);
        // Write CRON.md — the autonomous job definitions
        if (scaffold.cronMd) {
          fs.writeFileSync(path.join(agentDir, 'CRON.md'), scaffold.cronMd);
        }
        // Write playbook — ICP, email rules, escalation criteria
        if (scaffold.playbook) {
          fs.writeFileSync(path.join(agentDir, 'PLAYBOOK.md'), scaffold.playbook);
        }
        // Write sequence definitions
        if (scaffold.sequences) {
          fs.writeFileSync(path.join(agentDir, 'SEQUENCES.md'), scaffold.sequences);
        }
      }
    }

    // Invalidate cache
    this.cacheTime = 0;

    return this.get(slug)!;
  }

  updateAgent(slug: string, changes: Partial<AgentCreateConfig>): AgentProfile {
    const agentDir = path.join(this.agentsDir, slug);
    const agentFile = path.join(agentDir, 'agent.md');

    if (!fs.existsSync(agentFile)) {
      throw new Error(`Agent '${slug}' not found in agents directory.`);
    }

    const raw = fs.readFileSync(agentFile, 'utf-8');
    const { data: meta, content: body } = matter(raw);

    // Merge changes into frontmatter
    if (changes.name !== undefined) meta.name = changes.name;
    if (changes.description !== undefined) meta.description = changes.description;
    if (changes.tier !== undefined) meta.tier = Math.min(changes.tier, 2);
    if (changes.model !== undefined) meta.model = changes.model;
    if (changes.avatar !== undefined) meta.avatar = changes.avatar;
    if (changes.channelName !== undefined) meta.channelName = changes.channelName;
    if (changes.teamChat !== undefined) meta.teamChat = changes.teamChat;
    if (changes.respondToAll !== undefined) meta.respondToAll = changes.respondToAll;
    if (changes.canMessage !== undefined) meta.canMessage = changes.canMessage;
    if (changes.allowedTools !== undefined) meta.allowedTools = changes.allowedTools;
    if (changes.allowedUsers !== undefined) meta.allowedUsers = changes.allowedUsers;
    if (changes.project !== undefined) meta.project = changes.project;
    if (changes.discordToken !== undefined) {
      if (changes.discordToken) {
        storeAgentSecret(slug, 'DISCORD_TOKEN', changes.discordToken);
        meta.discordToken = 'keychain';
      } else {
        deleteAgentSecret(slug, 'DISCORD_TOKEN');
        meta.discordToken = undefined;
      }
    }
    if (changes.discordChannelId !== undefined) meta.discordChannelId = changes.discordChannelId || undefined;
    if (changes.slackBotToken !== undefined) {
      if (changes.slackBotToken) {
        storeAgentSecret(slug, 'SLACK_BOT_TOKEN', changes.slackBotToken);
        meta.slackBotToken = 'keychain';
      } else {
        deleteAgentSecret(slug, 'SLACK_BOT_TOKEN');
        meta.slackBotToken = undefined;
      }
    }
    if (changes.slackAppToken !== undefined) {
      if (changes.slackAppToken) {
        storeAgentSecret(slug, 'SLACK_APP_TOKEN', changes.slackAppToken);
        meta.slackAppToken = 'keychain';
      } else {
        deleteAgentSecret(slug, 'SLACK_APP_TOKEN');
        meta.slackAppToken = undefined;
      }
    }
    if (changes.slackChannelId !== undefined) meta.slackChannelId = changes.slackChannelId || undefined;
    if (changes.sendPolicy !== undefined) meta.sendPolicy = changes.sendPolicy || undefined;
    if (changes.status !== undefined) meta.status = changes.status;
    if (changes.budgetMonthlyCents !== undefined) meta.budgetMonthlyCents = changes.budgetMonthlyCents || undefined;

    const newBody = changes.personality ?? body;
    const updated = matter.stringify(newBody, meta);
    fs.writeFileSync(agentFile, updated);

    // Invalidate cache
    this.cacheTime = 0;

    return this.get(slug)!;
  }

  /** Quick status update without touching other config. */
  setStatus(slug: string, status: AgentStatus): void {
    this.updateAgent(slug, { status } as Partial<AgentCreateConfig>);
  }

  /** Check if an agent is runnable (active status). */
  isRunnable(slug: string): boolean {
    const agent = this.get(slug);
    if (!agent) return false;
    return !agent.status || agent.status === 'active';
  }

  deleteAgent(slug: string): void {
    const agentDir = path.join(this.agentsDir, slug);

    if (!fs.existsSync(agentDir)) {
      throw new Error(`Agent '${slug}' not found.`);
    }

    // Clean up Keychain secrets
    deleteAgentSecret(slug, 'DISCORD_TOKEN');
    deleteAgentSecret(slug, 'SLACK_BOT_TOKEN');
    deleteAgentSecret(slug, 'SLACK_APP_TOKEN');

    // Remove directory recursively
    fs.rmSync(agentDir, { recursive: true, force: true });

    // Invalidate cache
    this.cacheTime = 0;
  }

  /** Force cache refresh (used after external modifications). */
  invalidateCache(): void {
    this.cacheTime = 0;
  }
}
