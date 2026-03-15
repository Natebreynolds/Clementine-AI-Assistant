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

import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { AgentProfile, TeamAgentConfig } from '../types.js';
import { ProfileManager } from './profiles.js';

const CACHE_TTL_MS = 60_000;

export interface AgentCreateConfig {
  name: string;
  description: string;
  personality?: string;            // System prompt body
  tier?: number;
  model?: string;
  avatar?: string;
  channelName?: string;
  canMessage?: string[];
  allowedTools?: string[];
  project?: string;
  discordToken?: string;           // Dedicated Discord bot token
  discordChannelId?: string;       // Channel ID for bot to listen in
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
    const channelName = meta.channelName ? String(meta.channelName) : undefined;
    const canMessage = Array.isArray(meta.canMessage)
      ? meta.canMessage.map(String).filter(Boolean)
      : [];
    const allowedTools = Array.isArray(meta.allowedTools)
      ? meta.allowedTools.map(String).filter(Boolean)
      : undefined;

    if (channelName) {
      team = { channelName, channels: [], canMessage, allowedTools };
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
      agentDir: path.dirname(filePath),
      discordToken: meta.discordToken ? String(meta.discordToken) : undefined,
      discordChannelId: meta.discordChannelId ? String(meta.discordChannelId) : undefined,
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
      tier: config.tier ?? 2,
    };
    if (config.model) frontmatter.model = config.model;
    if (config.avatar) frontmatter.avatar = config.avatar;
    if (config.channelName) frontmatter.channelName = config.channelName;
    if (config.canMessage?.length) frontmatter.canMessage = config.canMessage;
    if (config.allowedTools?.length) frontmatter.allowedTools = config.allowedTools;
    if (config.project) frontmatter.project = config.project;
    if (config.discordToken) frontmatter.discordToken = config.discordToken;
    if (config.discordChannelId) frontmatter.discordChannelId = config.discordChannelId;

    const body = config.personality || `You are ${config.name}. ${config.description}`;
    const content = matter.stringify(body, frontmatter);
    fs.writeFileSync(path.join(agentDir, 'agent.md'), content);

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
    if (changes.tier !== undefined) meta.tier = changes.tier;
    if (changes.model !== undefined) meta.model = changes.model;
    if (changes.avatar !== undefined) meta.avatar = changes.avatar;
    if (changes.channelName !== undefined) meta.channelName = changes.channelName;
    if (changes.canMessage !== undefined) meta.canMessage = changes.canMessage;
    if (changes.allowedTools !== undefined) meta.allowedTools = changes.allowedTools;
    if (changes.project !== undefined) meta.project = changes.project;
    if (changes.discordToken !== undefined) meta.discordToken = changes.discordToken || undefined;
    if (changes.discordChannelId !== undefined) meta.discordChannelId = changes.discordChannelId || undefined;

    const newBody = changes.personality ?? body;
    const updated = matter.stringify(newBody, meta);
    fs.writeFileSync(agentFile, updated);

    // Invalidate cache
    this.cacheTime = 0;

    return this.get(slug)!;
  }

  deleteAgent(slug: string): void {
    const agentDir = path.join(this.agentsDir, slug);

    if (!fs.existsSync(agentDir)) {
      throw new Error(`Agent '${slug}' not found.`);
    }

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
