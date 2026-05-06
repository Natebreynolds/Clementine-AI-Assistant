/**
 * Build the enriched user message the trick builder sends to the
 * canonical chat path. Single source of truth shared by both
 * /api/builder/chat and /api/builder/chat/stream.
 *
 * Two non-obvious things:
 *
 * 1. "First message" detection uses the SDK session ID, not an
 *    in-memory Set. Daemon restart wipes in-memory state, so the
 *    prior implementation re-sent the system prefix on the very next
 *    turn even though SDK session resume kept the agent's memory of
 *    it. Anchoring detection to the persisted SDK session means
 *    the prefix is sent exactly once per genuine new conversation.
 *
 * 2. Model names referenced in the workflow prefix come from the
 *    MODELS config so they don't rot when models advance.
 */
import { MODELS } from '../../config.js';

export type BuilderType = 'skill' | 'cron' | 'agent' | 'workflow';

export interface BuildBuilderMessageOptions {
  /** What the user typed in the chat box. */
  message: string;
  /** Type of artifact being drafted. Defaults to 'skill'. */
  artifactType?: string;
  /** When set, the artifact is scoped to this hired agent. */
  agentSlug?: string;
  /** Current artifact JSON the dashboard is holding. Re-sent each
   *  turn so the agent has the live state in front of it. */
  currentArtifact?: unknown;
  /** Files the user dragged in for context. Each entry has a
   *  filename + base64-encoded content. Decoded + capped per file. */
  attachments?: Array<{ filename?: string; content?: string }>;
  /** Pre-selected MCP / local tool names the artifact should use. */
  linkedTools?: string[];
  /** Whether this is the first turn of a new conversation (no prior
   *  SDK session). When true, the system prefix is included. */
  isFirstMessage: boolean;
}

const FILE_MAX_CHARS = 4000;

function buildArtifactContext(currentArtifact: unknown): string {
  if (!currentArtifact) return '';
  return `\n[CURRENT ARTIFACT STATE]\n\`\`\`json-artifact\n${JSON.stringify(currentArtifact)}\n\`\`\`\n`;
}

function buildFileContext(attachments?: BuildBuilderMessageOptions['attachments']): string {
  if (!Array.isArray(attachments) || attachments.length === 0) return '';
  const parts: string[] = [];
  for (const att of attachments) {
    if (!att.filename || !att.content) continue;
    try {
      const decoded = Buffer.from(att.content, 'base64').toString('utf-8');
      const trimmed = decoded.length > FILE_MAX_CHARS
        ? decoded.slice(0, FILE_MAX_CHARS) + '\n... (truncated)'
        : decoded;
      parts.push(`### ${att.filename}\n\`\`\`\n${trimmed}\n\`\`\``);
    } catch {
      // Binary file; skip.
    }
  }
  if (parts.length === 0) return '';
  return `\n[REFERENCE FILES — the user attached these for context]\n${parts.join('\n\n')}\n`;
}

function buildToolContext(linkedTools?: string[]): string {
  if (!Array.isArray(linkedTools) || linkedTools.length === 0) return '';
  return `\n[LINKED TOOLS — this artifact should use these tools: ${linkedTools.join(', ')}]\n`;
}

function buildSystemPrefix(type: string, agentSlug?: string): string {
  const agentContext = agentSlug
    ? `You are building this for the agent "${agentSlug}". The artifact will be scoped to this agent specifically.\n`
    : '';

  if (type === 'skill') {
    return `[BUILDER MODE: You are helping build a reusable skill. ${agentContext}As you develop the procedure, output the current state as a JSON block:\n` +
      '```json-artifact\n{"type":"skill","title":"...","description":"...","triggers":["..."],"steps":"markdown procedure","toolsUsed":["tool1","tool2"]}\n```\n' +
      `Update this block in EVERY response as the skill evolves. If the user has linked tools, include them in the toolsUsed array. Ask clarifying questions to refine the procedure. Keep it conversational — one question at a time. ` +
      `When the user says "save" or approves, output the final artifact block.]\n\n`;
  }

  if (type === 'cron') {
    return `[BUILDER MODE: You are helping build a scheduled cron job. ${agentContext}As you develop the job, output the current state as a JSON block:\n` +
      '```json-artifact\n{"type":"cron","name":"...","schedule":"cron expression","tier":1,"prompt":"the full job prompt","enabled":true}\n```\n' +
      `Update this block in EVERY response as the job evolves. Ask about schedule, what it should do, which tools/APIs it needs, and what tier (1=read-only, 2=read-write). ` +
      `Cron jobs automatically pull in matching skills (learned procedures) at runtime. If the user describes a workflow that should be reusable, suggest creating it as a skill first, then building the cron job that references those trigger keywords.\n` +
      `When the user says "save" or approves, output the final artifact block.]\n\n`;
  }

  if (type === 'agent') {
    return `[BUILDER MODE: You are helping create a new AI agent team member. As you develop the agent config, output the current state as a JSON block:\n` +
      '```json-artifact\n{"type":"agent","name":"...","description":"role description","model":"sonnet","personality":"system prompt / onboarding brief","tools":["tool1","tool2"],"channel":"","tier":2}\n```\n' +
      `Update this block in EVERY response as the agent evolves. Ask about: the agent's role, what tools it needs, what model to use (haiku/sonnet/opus), its personality/system prompt, which channel it should operate in, and its security tier.\n` +
      `Help the user think about what makes a good agent: clear role, specific tools, focused personality. Keep it conversational — one question at a time.\n` +
      `When the user says "save" or approves, output the final artifact block.]\n\n`;
  }

  if (type === 'workflow') {
    return `[BUILDER MODE: You are helping the user DRAFT a "trick" — a (possibly multi-step) thing Clementine can do on a schedule or on demand. You are NOT executing the trick. You are not running anything in the background. You are only authoring a spec the user will save, then run later from the dashboard.\n` +
      `\n` +
      `Hard rules:\n` +
      `  - NEVER say "on it", "running in the background", "I'll follow up", "working on it now", or anything else that implies you're executing the user's request. You are drafting a spec.\n` +
      `  - Stay strictly conversational. One short question per turn. Update the artifact block on every turn.\n` +
      `  - If the user describes "real work" (multi-step actions, scrapers, enrichments, reports), still just draft it — don't dispatch.\n` +
      `\n` +
      `As you develop the trick, output the current state as a JSON block:\n` +
      '```json-artifact\n{"type":"workflow","name":"...","description":"...","schedule":"","model":"","steps":"step1:\\n  prompt: ...\\nstep2:\\n  prompt: ...\\n  dependsOn: step1"}\n```\n' +
      `Ask about (in roughly this order, one at a time):\n` +
      `  1. The goal (one sentence is fine — confirm it back).\n` +
      `  2. When it should run — natural language is fine ("every weekday at 9"); convert to a cron expression in the schedule field. Empty schedule = manual.\n` +
      `  3. Which tools, projects, or channels she'll need (MCP servers, local CLIs like sf/gh/gcloud, Slack/Discord targets).\n` +
      `  4. Which model — ${MODELS.opus} (most capable), ${MODELS.sonnet} (balanced), or ${MODELS.haiku} (fastest). Leave model empty if the user doesn't care.\n` +
      `Most tricks need only one prompt step. Add steps only when the user explicitly wants a multi-step pipeline.\n` +
      `If a user message starts with "[STEP ADDED]", they just clicked a Quick Add button to seed a step structure. Focus your reply on writing the prompt field for THAT step — ask one specific clarifying question, then update the artifact. Do NOT restructure the workflow or re-ask about goal/schedule/model.\n` +
      `When the user says "save" or approves, output the final artifact block — don't try to save it yourself, the dashboard handles persistence.]\n\n`;
  }

  return `[BUILDER MODE: You are helping configure an artifact. Output structured JSON blocks as you build.]\n\n`;
}

/**
 * Compose the message that gets sent to gateway.handleMessage. The
 * shape is: optional system prefix (first turn only), then file
 * context, then linked-tools context, then current artifact state,
 * then the user's literal message.
 */
export function buildBuilderEnrichedMessage(opts: BuildBuilderMessageOptions): string {
  const type = opts.artifactType || 'skill';
  const fileContext = buildFileContext(opts.attachments);
  const toolContext = buildToolContext(opts.linkedTools);
  const artifactContext = buildArtifactContext(opts.currentArtifact);
  const prefix = opts.isFirstMessage ? buildSystemPrefix(type, opts.agentSlug) : '';
  return prefix + fileContext + toolContext + artifactContext + opts.message;
}

/**
 * Stable session-key for a builder conversation. Same key across
 * /api/builder/chat and /api/builder/chat/stream so they share state.
 */
export function builderSessionKey(artifactType: string | undefined, agentSlug: string | undefined): string {
  const type = artifactType || 'skill';
  return `dashboard:builder:${type}:${agentSlug || 'clementine'}`;
}
