/**
 * Clementine TypeScript — Agent profile management.
 *
 * Profiles are Markdown files with YAML frontmatter stored in
 * vault/00-System/profiles/. Each profile defines a persona with its own
 * tone, tool restrictions, security tier, and system prompt body.
 *
 * ProfileManager scans the directory, caches AgentProfile objects, and
 * hot-reloads when files change (60-second TTL).
 */

import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { AgentProfile } from '../types.js';

const CACHE_TTL_MS = 60_000;

export class ProfileManager {
  private dir: string;
  private cache = new Map<string, AgentProfile>();
  private cacheTime = 0;

  constructor(profilesDir: string) {
    this.dir = profilesDir;
  }

  private refreshIfStale(): void {
    const now = Date.now();
    if (now - this.cacheTime < CACHE_TTL_MS && this.cache.size > 0) {
      return;
    }

    if (!fs.existsSync(this.dir)) {
      this.cache.clear();
      this.cacheTime = now;
      return;
    }

    const profiles = new Map<string, AgentProfile>();

    const files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.md') && !f.startsWith('_')).sort();

    for (const file of files) {
      try {
        const filePath = path.join(this.dir, file);
        const profile = this.loadProfile(filePath, file);
        const slug = file.replace(/\.md$/, '');
        profiles.set(slug, profile);
      } catch {
        // Skip malformed profile files
      }
    }

    this.cache = profiles;
    this.cacheTime = now;
  }

  private loadProfile(filePath: string, fileName: string): AgentProfile {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const { data: meta, content } = matter(raw);

    const slug = fileName.replace(/\.md$/, '');
    // Cap tier at 2 — profiles can never grant Tier 3
    const tier = Math.min(Number(meta.tier ?? 1), 2);

    return {
      slug,
      name: String(meta.name ?? slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())),
      tier,
      description: String(meta.description ?? meta.role ?? ''),
      systemPromptBody: content.trim(),
      model: meta.model ? String(meta.model) : undefined,
    };
  }

  get(slug: string): AgentProfile | null {
    this.refreshIfStale();
    return this.cache.get(slug) ?? null;
  }

  listAll(): AgentProfile[] {
    this.refreshIfStale();
    return [...this.cache.values()];
  }
}
