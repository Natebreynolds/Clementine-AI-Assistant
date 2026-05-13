import type { RunSummary, SideEffectCall } from './run-summary.js';

export type PendingAgentDecisionKind = 'blocked_external_action';
export type BlockedActionCategory = 'deployment_target_missing';

export interface PendingAgentDecision {
  id: string;
  kind: PendingAgentDecisionKind;
  createdAt: number;
  expiresAt: number;
  runIds: string[];
  originalRequest: string;
  question: string;
  context: {
    category: BlockedActionCategory;
    classifierId: string;
    provider: string;
    providerLabel: string;
    blockerSummary: string;
    failedCommand: string;
    error: string;
    targetNoun: string;
    targetPlaceholder: string;
    createInstructions: string[];
    existingInstructions: string[];
    projectPath?: string;
    agentId?: string;
    completedSideEffects?: string[];
  };
}

export type AgentDecisionReply =
  | { kind: 'answer'; action: 'create_new_target' }
  | { kind: 'answer'; action: 'use_existing_target'; target: string }
  | { kind: 'cancel' }
  | { kind: 'unclear'; message: string };

export interface BlockedActionClassifier {
  id: string;
  category: BlockedActionCategory;
  provider: string;
  providerLabel: string;
  targetNoun: string;
  targetPlaceholder: string;
  defaultCommand: string;
  defaultError: string;
  blockerSummary: string;
  matches(call: SideEffectCall): boolean;
  createInstructions: string[];
  existingInstructions: string[];
}

const customClassifiers: BlockedActionClassifier[] = [];

/**
 * Extension point for install-specific tool/provider blockers. Core owns the
 * state machine; providers own only small classifiers and resume instructions.
 */
export function registerBlockedActionClassifier(classifier: BlockedActionClassifier): () => void {
  customClassifiers.unshift(classifier);
  return () => {
    const index = customClassifiers.indexOf(classifier);
    if (index >= 0) customClassifiers.splice(index, 1);
  };
}

// ─── Pre-call (canUseTool) classifiers ─────────────────────────────────
// The post-hoc BlockedActionClassifier above runs AFTER a tool call has
// already failed (the deploy fired, left state behind, returned an error
// we then parsed). The orchestrator-first north star prefers pre-emptive
// gates: intercept the tool call BEFORE it fires when preconditions are
// missing. The SDK exposes `canUseTool` for exactly this purpose.
//
// A PreconditionClassifier inspects (toolName, input, env) and either
// passes (returns null, tool proceeds) or matches (returns a
// PreconditionMatch that the gate converts to a PendingAgentDecision
// and asks the owner). Post-hoc and pre-call classifiers coexist —
// pre-call narrows the failure surface, post-hoc remains as the safety
// net for cases the pre-call rule didn't anticipate.

export interface PreconditionEnv {
  /** Working directory the agent will use for this tool call. */
  cwd: string;
  /** Active project path if the router resolved one. */
  activeProjectPath?: string;
  /** filesystem.existsSync injection point for testability. */
  existsSync?: (path: string) => boolean;
}

export interface PreconditionMatch {
  /** The command or tool action that would have run (for owner display). */
  attemptedCommand: string;
  /** The reason the precondition failed (for owner display). */
  reason: string;
  /** Optional project path inferred from the input (e.g. `cd /path && netlify deploy`). */
  projectPath?: string;
}

export interface PreconditionClassifier {
  id: string;
  category: BlockedActionCategory;
  provider: string;
  providerLabel: string;
  targetNoun: string;
  targetPlaceholder: string;
  blockerSummary: string;
  /** Tool names this classifier inspects. e.g. ['Bash'] or
   *  ['mcp__clementine-tools__project_deploy']. Wildcard `'*'` not supported —
   *  classifiers should be narrow on purpose. */
  toolNames: readonly string[];
  /** Returns a PreconditionMatch when the call should be blocked, or null
   *  to let it proceed. Errors thrown here are caught and treated as a pass
   *  (fail-open) — the post-hoc classifier still catches the failure. */
  matchesPreconditions(input: Record<string, unknown>, env: PreconditionEnv): PreconditionMatch | null;
  createInstructions: string[];
  existingInstructions: string[];
}

const customPreconditionClassifiers: PreconditionClassifier[] = [];

/** Extension point for pre-call classifiers. Mirrors registerBlockedActionClassifier. */
export function registerPreconditionClassifier(classifier: PreconditionClassifier): () => void {
  customPreconditionClassifiers.unshift(classifier);
  return () => {
    const index = customPreconditionClassifiers.indexOf(classifier);
    if (index >= 0) customPreconditionClassifiers.splice(index, 1);
  };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function extractBashCommand(call: SideEffectCall): string | undefined {
  return firstString(call.input.command);
}

function sideEffectErrorText(call: SideEffectCall): string {
  return [
    call.result?.error,
    typeof call.result?.raw === 'string' ? call.result.raw : '',
  ].filter(Boolean).join('\n');
}

function compactCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim().slice(0, 260);
}

function compactValue(value: string, max = 220): string {
  const compacted = value.replace(/\s+/g, ' ').trim();
  return compacted.length > max ? `${compacted.slice(0, max - 3)}...` : compacted;
}

function extractProjectPathFromCommand(command: string): string | undefined {
  return command.match(/\bcd\s+"([^"]+)"/)?.[1]
    ?? command.match(/\bcd\s+'([^']+)'/)?.[1]
    ?? command.match(/\bcd\s+([^&;|]+)/)?.[1]?.trim();
}

function extractFilePathFromCall(call: SideEffectCall): string | undefined {
  const fromInput = firstString(
    call.input.file_path,
    call.input.filePath,
    call.input.path,
    call.input.target_path,
    call.input.targetPath,
  );
  if (fromInput) return fromInput;
  const raw = call.result?.raw;
  if (typeof raw === 'string') {
    return raw.match(/\b(?:File (?:created|updated) successfully at|file state is current in your context):\s*([^\n(]+)/i)?.[1]?.trim();
  }
  return undefined;
}

function summarizeCompletedSideEffect(call: SideEffectCall): string {
  if (call.toolName === 'Bash') {
    const command = extractBashCommand(call);
    return command ? `Bash command completed: ${compactCommand(command)}` : 'Bash command completed';
  }
  const filePath = extractFilePathFromCall(call);
  if (filePath) return `${call.toolName} completed for file: ${filePath}`;
  return `${call.toolName} completed`;
}

function collectText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(collectText).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  const obj = value as Record<string, unknown>;
  return ['text', 'content', 'result', 'message']
    .map((key) => collectText(obj[key]))
    .filter(Boolean)
    .join('\n');
}

function extractAgentId(summary: RunSummary): string | undefined {
  for (const call of summary.successfulDelegations) {
    const text = call.result ? collectText(call.result.raw) : '';
    const match = text.match(/\bagentId:\s*([a-zA-Z0-9_-]+)/);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

const BUILTIN_CLASSIFIERS: BlockedActionClassifier[] = [
  {
    id: 'netlify_missing_deployment_target',
    category: 'deployment_target_missing',
    provider: 'netlify',
    providerLabel: 'Netlify',
    targetNoun: 'deployment target',
    targetPlaceholder: 'target-slug-or-id',
    defaultCommand: 'netlify deploy',
    defaultError: 'Deployment target is not linked',
    blockerSummary: 'The deployment provider reported that this project is not linked to a deployment target.',
    matches(call) {
      if (call.toolName !== 'Bash') return false;
      const command = extractBashCommand(call) ?? '';
      const error = sideEffectErrorText(call);
      return /\bnetlify\s+deploy\b/i.test(command)
        && /\bProject not found\. Please rerun "netlify link"|\bnetlify link\b/i.test(error);
    },
    createInstructions: [
      'Create or link a new deployment target for this project, then deploy and verify the live URL.',
      'Do not restart project discovery or reread full generated artifacts unless a small targeted read is necessary.',
      'If provider auth, browser login, or an interactive naming choice is required and cannot be completed safely, stop and ask one concrete question.',
      'If a Clementine deploy config is appropriate, write `.clementine/deploy.json` with the provider kind, target identifier, deploy directory, and verify URL.',
      'Prefer `project_deploy` once deploy config exists; otherwise run the equivalent provider deploy command and verify the live URL before claiming success.',
    ],
    existingInstructions: [
      'Use or link the existing deployment target: {target}',
      'Do not restart project discovery or reread full generated artifacts unless a small targeted read is necessary.',
      'Write or update `.clementine/deploy.json` for the existing target before deploying when that config is supported.',
      'Prefer `project_deploy` once deploy config exists; otherwise run the equivalent provider deploy command and verify the live URL before claiming success.',
      'If the provider rejects the target or auth is missing, stop and ask one concrete question with the exact CLI/API error.',
    ],
  },
];

function blockedActionClassifiers(): BlockedActionClassifier[] {
  return [...customClassifiers, ...BUILTIN_CLASSIFIERS];
}

function makeDecisionId(kind: PendingAgentDecisionKind): string {
  return `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatDecisionPrompt(decision: PendingAgentDecision): string {
  return [
    'I need one decision before I can continue this external action.',
    '',
    decision.context.blockerSummary,
    `- Provider: ${decision.context.providerLabel}`,
    `- Failed command: \`${decision.context.failedCommand}\``,
    `- Provider said: ${decision.context.error}`,
    ...(decision.context.projectPath ? [`- Project folder: \`${decision.context.projectPath}\``] : []),
    ...(decision.context.agentId ? [`- Discovery already completed: agentId \`${decision.context.agentId}\``] : []),
    '',
    'Reply with one of these:',
    `- \`create target\` to create/link a new ${decision.context.targetNoun}, deploy, and verify the result.`,
    `- \`use existing <${decision.context.targetPlaceholder}>\` to use a target you already have.`,
    '- `done` to stop here.',
  ].join('\n');
}

export function buildBlockedActionDecisionFromRunSummary(
  summary: RunSummary,
  originalRequest: string,
  nowMs = Date.now(),
): PendingAgentDecision | null {
  for (const failedCall of summary.failedSideEffects) {
    const classifier = blockedActionClassifiers().find(c => c.matches(failedCall));
    if (!classifier) continue;

    const rawCommand = extractBashCommand(failedCall) ?? classifier.defaultCommand;
    const failedCommand = compactCommand(rawCommand);
    const error = sideEffectErrorText(failedCall).trim() || classifier.defaultError;
    const projectPath = extractProjectPathFromCommand(rawCommand);
    const agentId = extractAgentId(summary);
    const completedSideEffects = summary.successfulSideEffects
      .map(summarizeCompletedSideEffect)
      .map((line) => compactValue(line))
      .slice(0, 5);

    const decision: PendingAgentDecision = {
      id: makeDecisionId('blocked_external_action'),
      kind: 'blocked_external_action',
      createdAt: nowMs,
      expiresAt: nowMs + 30 * 60_000,
      runIds: summary.runIds,
      originalRequest,
      question: '',
      context: {
        category: classifier.category,
        classifierId: classifier.id,
        provider: classifier.provider,
        providerLabel: classifier.providerLabel,
        blockerSummary: classifier.blockerSummary,
        failedCommand,
        error: compactValue(error, 500),
        targetNoun: classifier.targetNoun,
        targetPlaceholder: classifier.targetPlaceholder,
        createInstructions: classifier.createInstructions,
        existingInstructions: classifier.existingInstructions,
        ...(projectPath ? { projectPath } : {}),
        ...(agentId ? { agentId } : {}),
        ...(completedSideEffects.length > 0 ? { completedSideEffects } : {}),
      },
    };
    decision.question = formatDecisionPrompt(decision);
    return decision;
  }
  return null;
}

function unclearDecisionMessage(decision: PendingAgentDecision): string {
  return `I need a specific decision: reply \`create target\`, \`use existing <${decision.context.targetPlaceholder}>\`, or \`done\`.`;
}

export function parseAgentDecisionReply(
  decision: PendingAgentDecision,
  message: string,
): AgentDecisionReply {
  const text = message.trim();
  const lower = text.toLowerCase().replace(/[.!?]+$/g, '').replace(/\s+/g, ' ').trim();
  const intent = lower
    .replace(/^(?:please|yes|yep|yeah|sure|ok|okay|go ahead(?: and)?)\s+/, '')
    .replace(/\s+please$/, '')
    .trim();
  if (!lower) {
    return {
      kind: 'unclear',
      message: unclearDecisionMessage(decision),
    };
  }
  if (/^(?:done|stop|cancel|abort|no|nope|that's all|that is all|leave it)\b/.test(lower)) {
    return { kind: 'cancel' };
  }

  if (/^(?:create|make|new)(?:\s+(?:(?:a|the)\s+)?(?:new\s+)?(?:target|deployment target|site|project|one))?$/.test(intent)
    || /^(?:create|make)\s+(?:it|one)$/.test(intent)
    || /\b(?:create|make)\s+(?:(?:a|the)\s+)?(?:new\s+)?(?:deployment\s+)?(?:target|site|project)\b/.test(intent)
    || /\bnew\s+(?:deployment\s+)?(?:target|site|project)\b/.test(intent)) {
    return { kind: 'answer', action: 'create_new_target' };
  }

  const explicitTarget = text.match(/^\s*(?:use|link)\s+(?:to\s+)?(?:the\s+)?(?:existing\s+)?(?:deployment\s+)?(?:target|site|project)\s+(.+?)\s*$/i)
    ?? text.match(/^\s*(?:use|link)\s+(?:to\s+)?(?:existing\s+)?(.+?)\s*$/i)
    ?? text.match(/^\s*target\s*:\s*(.+?)\s*$/i);
  if (explicitTarget?.[1]) {
    const target = explicitTarget[1].trim().replace(/^["'`]|["'`]$/g, '');
    if (/[<>]/.test(target)) {
      return {
        kind: 'unclear',
        message: `Please replace \`<${decision.context.targetPlaceholder}>\` with the actual ${decision.context.targetNoun} identifier or URL.`,
      };
    }
    if (target) return { kind: 'answer', action: 'use_existing_target', target };
  }

  const url = text.match(/https?:\/\/\S+/i);
  if (url?.[0]) {
    return { kind: 'answer', action: 'use_existing_target', target: url[0].replace(/[),.]+$/g, '') };
  }

  return {
    kind: 'unclear',
    message: unclearDecisionMessage(decision),
  };
}

function renderInstructions(instructions: string[], target?: string): string[] {
  return instructions.map(line => target ? line.replace(/\{target\}/g, target) : line);
}

export function buildAgentDecisionContinuationPrompt(
  decision: PendingAgentDecision,
  reply: Extract<AgentDecisionReply, { kind: 'answer' }>,
): string {
  const lines: string[] = [
    '[Agentic repair loop - read this before taking any action]',
    'State transition: needs_user_decision -> executing',
    `Decision kind: ${decision.kind}`,
    `Blocker category: ${decision.context.category}`,
    `Provider: ${decision.context.providerLabel}`,
    `Previous run(s): ${decision.runIds.join(', ')}`,
    '',
    'Original owner request:',
    decision.originalRequest,
    '',
    'Blocked step:',
    `- Failed command: ${decision.context.failedCommand}`,
    `- Error: ${decision.context.error}`,
    ...(decision.context.projectPath ? [`- Project folder already identified: ${decision.context.projectPath}`] : []),
    ...(decision.context.agentId ? [`- Discovery already completed by agentId ${decision.context.agentId}`] : []),
    '',
  ];

  if (decision.context.completedSideEffects?.length) {
    lines.push(
      'Completed before the block. Do not repeat these unless verification proves they are stale:',
      ...decision.context.completedSideEffects.map((line) => `- ${line}`),
      '',
    );
  }

  if (reply.action === 'create_new_target') {
    lines.push(
      'Owner decision:',
      `- Create/link a new ${decision.context.targetNoun}, then deploy and verify.`,
      '',
      'Execution requirements:',
      ...renderInstructions(decision.context.createInstructions).map(line => `- ${line}`),
    );
  } else {
    lines.push(
      'Owner decision:',
      `- Use existing ${decision.context.targetNoun}: ${reply.target}`,
      '',
      'Execution requirements:',
      ...renderInstructions(decision.context.existingInstructions, reply.target).map(line => `- ${line}`),
    );
  }

  lines.push('[/Agentic repair loop]');
  return lines.join('\n');
}

// Backward-compatible alias for the router/tests while callers migrate to the
// provider-neutral name.
export const buildRepairDecisionFromRunSummary = buildBlockedActionDecisionFromRunSummary;

// ─── Pre-call decision construction ────────────────────────────────────

function preconditionClassifiers(): PreconditionClassifier[] {
  return [...customPreconditionClassifiers, ...BUILTIN_PRECONDITION_CLASSIFIERS];
}

/**
 * Run all registered precondition classifiers against an attempted tool
 * call. Returns the first PendingAgentDecision that matches, or null if
 * the call should proceed. Errors inside individual classifiers are
 * swallowed (fail-open) — the post-hoc classifier remains as the safety
 * net for any case the pre-call rule mishandles.
 */
export function evaluatePreconditionsForToolCall(
  toolName: string,
  input: Record<string, unknown>,
  env: PreconditionEnv,
  opts: { originalRequest?: string; runId?: string; nowMs?: number } = {},
): PendingAgentDecision | null {
  const nowMs = opts.nowMs ?? Date.now();
  for (const classifier of preconditionClassifiers()) {
    if (!classifier.toolNames.includes(toolName)) continue;
    let match: PreconditionMatch | null = null;
    try {
      match = classifier.matchesPreconditions(input, env);
    } catch {
      // Fail-open — the post-hoc classifier will catch a failure.
      continue;
    }
    if (!match) continue;

    const decision: PendingAgentDecision = {
      id: makeDecisionId('blocked_external_action'),
      kind: 'blocked_external_action',
      createdAt: nowMs,
      expiresAt: nowMs + 30 * 60_000,
      runIds: opts.runId ? [opts.runId] : [],
      originalRequest: opts.originalRequest ?? '',
      question: '',
      context: {
        category: classifier.category,
        classifierId: classifier.id,
        provider: classifier.provider,
        providerLabel: classifier.providerLabel,
        blockerSummary: classifier.blockerSummary,
        failedCommand: compactCommand(match.attemptedCommand),
        error: compactValue(match.reason, 500),
        targetNoun: classifier.targetNoun,
        targetPlaceholder: classifier.targetPlaceholder,
        createInstructions: classifier.createInstructions,
        existingInstructions: classifier.existingInstructions,
        ...(match.projectPath ? { projectPath: match.projectPath } : {}),
      },
    };
    decision.question = formatDecisionPrompt(decision);
    return decision;
  }
  return null;
}

// ─── Built-in precondition classifiers ─────────────────────────────────

import { existsSync as nodeExistsSync } from 'node:fs';
import { join as pathJoin } from 'node:path';

/**
 * Netlify deploy precondition: deny `netlify deploy` (or our project_deploy
 * tool when its provider is netlify) when the project has no record of a
 * linked site. Mirrors the post-hoc netlify_missing_deployment_target
 * classifier but fires BEFORE the tool runs.
 *
 * Detection signals (any one is sufficient to allow):
 *   - `.netlify/state.json` exists in the project dir (netlify CLI's own
 *     link record)
 *   - `.clementine/deploy.json` exists in the project dir (Clementine's
 *     deploy config)
 *
 * If neither exists AND the project dir is identifiable, we deny pre-call
 * and ask the owner. If the project dir is not identifiable (e.g. the
 * agent invoked `netlify deploy` without a `cd` prefix), we fail-open
 * and let the post-hoc classifier handle it.
 */
const netlifyMissingLinkPrecondition: PreconditionClassifier = {
  id: 'netlify_missing_deployment_target',
  category: 'deployment_target_missing',
  provider: 'netlify',
  providerLabel: 'Netlify',
  targetNoun: 'deployment target',
  targetPlaceholder: 'target-slug-or-id',
  blockerSummary: 'This project does not have a Netlify deployment target linked yet. Deploying will fail until one is configured.',
  toolNames: ['Bash'],
  matchesPreconditions(input, env) {
    const command = firstString(input.command);
    if (!command) return null;
    if (!/\bnetlify\s+deploy\b/i.test(command)) return null;

    const projectPath = extractProjectPathFromCommand(command) ?? env.activeProjectPath;
    if (!projectPath) return null; // can't check — fail open

    const exists = env.existsSync ?? nodeExistsSync;
    const netlifyLinked = exists(pathJoin(projectPath, '.netlify', 'state.json'));
    const clementineDeployConfig = exists(pathJoin(projectPath, '.clementine', 'deploy.json'));
    if (netlifyLinked || clementineDeployConfig) return null;

    return {
      attemptedCommand: compactCommand(command),
      reason: 'No `.netlify/state.json` or `.clementine/deploy.json` found in the project. Netlify CLI will fail with "Project not found. Please rerun \'netlify link\'".',
      projectPath,
    };
  },
  createInstructions: [
    'Create or link a new Netlify deployment target for this project, then deploy and verify the live URL.',
    'Do not restart project discovery or reread full generated artifacts unless a small targeted read is necessary.',
    'If provider auth, browser login, or an interactive naming choice is required and cannot be completed safely, stop and ask one concrete question.',
    'If a Clementine deploy config is appropriate, write `.clementine/deploy.json` with the provider kind, target identifier, deploy directory, and verify URL.',
    'Prefer `project_deploy` once deploy config exists; otherwise run the equivalent provider deploy command and verify the live URL before claiming success.',
  ],
  existingInstructions: [
    'Use or link the existing Netlify target: {target}',
    'Do not restart project discovery or reread full generated artifacts unless a small targeted read is necessary.',
    'Write or update `.clementine/deploy.json` for the existing target before deploying when that config is supported.',
    'Prefer `project_deploy` once deploy config exists; otherwise run the equivalent provider deploy command and verify the live URL before claiming success.',
    'If the provider rejects the target or auth is missing, stop and ask one concrete question with the exact CLI/API error.',
  ],
};

const BUILTIN_PRECONDITION_CLASSIFIERS: PreconditionClassifier[] = [
  netlifyMissingLinkPrecondition,
];
