export type ToolsetName =
  | 'auto'
  | 'safe'
  | 'diagnostic'
  | 'communications'
  | 'memory'
  | 'full';

export interface ToolsetPreset {
  name: ToolsetName;
  label: string;
  description: string;
  directive: string;
}

export const TOOLSET_PRESETS: readonly ToolsetPreset[] = [
  {
    name: 'auto',
    label: 'Auto',
    description: 'Route to the smallest inferred tool surface for each turn.',
    directive: '',
  },
  {
    name: 'safe',
    label: 'Safe',
    description: 'Memory and read-only local context; no external sends or local writes.',
    directive: 'Toolset safe: use memory and read-only local context. Do not send messages, email, delete data, deploy, or modify files unless the user switches toolsets.',
  },
  {
    name: 'diagnostic',
    label: 'Diagnostic',
    description: 'Bounded logs, local reads, memory, and diagnostics; no external sends.',
    directive: 'Toolset diagnostic: diagnose with bounded reads and capped command output. Prefer targeted log slices, summaries, and transcript_search. Do not send external messages or make product changes.',
  },
  {
    name: 'communications',
    label: 'Communications',
    description: 'Email/message workflows plus memory; avoid code and deployment tools.',
    directive: 'Toolset communications: focus on email, calendar, messaging, approvals, and memory continuity. Do not edit code, deploy, or run unrelated local commands.',
  },
  {
    name: 'memory',
    label: 'Memory',
    description: 'Memory, transcript, and relationship tools only unless explicitly changed.',
    directive: 'Toolset memory: use memory_read, memory_search, memory_recall, transcript_search, working_memory, and user_model. Avoid external integrations and local shell/file writes.',
  },
  {
    name: 'full',
    label: 'Full',
    description: 'Explicit operator mode for broad integrations and admin work.',
    directive: 'Toolset full: the user explicitly enabled the broad operator surface for this chat. Still keep tool output bounded and ask before destructive or irreversible actions.',
  },
] as const;

const TOOLSET_BY_NAME = new Map<ToolsetName, ToolsetPreset>(
  TOOLSET_PRESETS.map((preset) => [preset.name, preset]),
);

export function normalizeToolsetName(input: string | undefined | null): ToolsetName | null {
  const value = String(input ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '-');
  if (!value) return null;
  if (value === 'diagnostics' || value === 'debug') return 'diagnostic';
  if (value === 'comm' || value === 'comms' || value === 'communication') return 'communications';
  if (value === 'mem') return 'memory';
  if (value === 'all' || value === 'operator') return 'full';
  return TOOLSET_BY_NAME.has(value as ToolsetName) ? value as ToolsetName : null;
}

export function getToolsetPreset(name: ToolsetName): ToolsetPreset {
  return TOOLSET_BY_NAME.get(name) ?? TOOLSET_BY_NAME.get('auto')!;
}

export function formatToolsetChoices(): string {
  return TOOLSET_PRESETS
    .map((preset) => `- ${preset.name}: ${preset.description}`)
    .join('\n');
}

export function isRestrictedToolset(name: ToolsetName): boolean {
  return name === 'safe' || name === 'diagnostic' || name === 'memory';
}

export function toolsetAllowsLocalWrites(name: ToolsetName): boolean {
  return name === 'auto' || name === 'full';
}
