/**
 * Prompt Overrides — schema types.
 *
 * Markdown files in ~/.clementine/prompt-overrides/ that get prepended to
 * cron job prompts at runtime. Frontmatter is optional; the bare body of
 * a markdown file is enough to override a prompt.
 *
 * Layout:
 *   _global.md                — appended for every job (low priority)
 *   agents/<slug>.md          — every job for an agent
 *   jobs/<jobName>.md         — specific job
 *
 * Default priority: global=10, agent=50, job=100. Lower priority concatenates first
 * (i.e. "outermost" — read by the LLM earlier).
 */

export type OverridePosition = 'append' | 'prepend';

export interface PromptOverrideFrontmatter {
  schemaVersion?: 1;
  priority?: number;
  position?: OverridePosition;
}

export interface PromptOverride {
  /** Raw body content (markdown), with frontmatter stripped. */
  body: string;
  /** Effective priority (frontmatter > scope default). */
  priority: number;
  /** Where the file lives — for logging only. */
  sourcePath: string;
  /** What scope this override targets. */
  scope: 'global' | 'agent' | 'job';
  /** For job/agent scope, the matched name; null for global. */
  scopeKey: string | null;
}
