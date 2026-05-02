/**
 * Clementine TypeScript — StallGuard.
 *
 * Per-query stall detection and enforcement. Combines tool loop detection,
 * metacognitive monitoring, and read-blocking into a single query-scoped
 * instance. No global mutable state — concurrent queries get their own guard.
 *
 * Lifecycle:
 *   1. Created before each SDK query
 *   2. Passed to buildOptions() → canUseTool checks shouldBlockTool()
 *   3. recordToolCall() called for each tool_use block in the stream
 *   4. After query: detectPromiseWithoutAction() + getSummary() for cross-query nudges
 */

import { ToolLoopDetector } from './tool-loop-detector.js';
import {
  MetacognitiveMonitor,
  type MetacognitiveMode,
  type MetacognitiveSignal,
  type MetacognitiveSummary,
} from './metacognition.js';
import pino from 'pino';

export type StallGuardMode = MetacognitiveMode;

const logger = pino({ name: 'clementine.stall-guard' });

// Only block SDK read tools — MCP tools (memory_read, etc.) are intentionally
// left unblocked to give the agent some information access while forced to act.
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']);
const EXACT_DUPLICATE_BLOCK_AFTER = 3;
const IDEMPOTENT_TOOL_RE = /^(Read|Glob|Grep|WebSearch|WebFetch|mcp__.*__(?:.*(?:search|list|get|read|inbox|calendar|query|overview|ranked_keywords|batch_get|screenshot|fetch|stats|timeline|connections).*))$/i;

// ── Types ───────────────────────────────────────────────────────────

export interface StallSummary {
  metacognition: MetacognitiveSummary;
  breakerActivated: boolean;
  breakerReason: string;
  toolCalls: string[];
}

// ── StallGuard ──────────────────────────────────────────────────────

export class StallGuard {
  private loopDetector = new ToolLoopDetector();
  private readonly metacog: MetacognitiveMonitor;
  private breakerActive = false;
  private breakerReason = '';
  private toolCallLog: string[] = [];
  private exactCallCounts = new Map<string, number>();

  /**
   * @param mode 'chat' (default) keeps full output-text-driven heuristics.
   *             'cron' / 'unleashed' disable the high_effort_low_output check
   *             since side effects, not chat text, are the deliverable for
   *             those execution contexts.
   */
  constructor(mode: StallGuardMode = 'chat') {
    this.metacog = new MetacognitiveMonitor(mode);
  }

  /**
   * Check if a tool should be blocked. Called from canUseTool.
   * When the breaker is active, denies read-only tools to force the agent
   * to either act (Write/Edit/Bash) or respond to the user.
   */
  shouldBlockTool(toolName: string, input?: Record<string, unknown>): { block: boolean; message?: string } {
    if (this.breakerActive && READ_ONLY_TOOLS.has(toolName)) {
      return {
        block: true,
        message:
          `STALL BREAKER: You have been reading without acting for too long. ${this.breakerReason} ` +
          `STOP reading. Either perform a write/action tool call (Write, Edit, Bash, etc.) to complete the task, ` +
          `or respond to the user explaining what is blocking you. Do NOT call another read-only tool.`,
      };
    }
    if (input && IDEMPOTENT_TOOL_RE.test(toolName)) {
      const key = this.callKey(toolName, input);
      const seen = this.exactCallCounts.get(key) ?? 0;
      if (seen >= EXACT_DUPLICATE_BLOCK_AFTER) {
        return {
          block: true,
          message:
            `Duplicate tool call blocked: ${toolName} has already been called ${seen} times with identical input in this turn. ` +
            `Use the result you already have, change the query/input, or explain what remains uncertain.`,
        };
      }
    }
    return { block: false };
  }

  /** True when the stall breaker has been engaged during this query. */
  isBreakerActive(): boolean { return this.breakerActive; }

  /** Reason string set when the breaker engaged (empty if not active). */
  getBreakerReason(): string { return this.breakerReason; }

  /**
   * Record a tool call. Runs loop detection and metacognition.
   * Activates the breaker if either detector fires.
   *
   * If the breaker is already active and this is a read-only tool, it was
   * denied by shouldBlockTool. Skip metacognition tracking for denied tools
   * to prevent a feedback loop where denials inflate the consecutive-read
   * counter (logs showed counter spiraling from 5 → 15 in milliseconds).
   */
  recordToolCall(toolName: string, input: Record<string, unknown>): void {
    const wasDenied = this.breakerActive && READ_ONLY_TOOLS.has(toolName);
    const key = this.callKey(toolName, input);
    this.exactCallCounts.set(key, (this.exactCallCounts.get(key) ?? 0) + 1);

    // Tool loop detector
    const loopCheck = this.loopDetector.recordCall(toolName, input);
    if (loopCheck.verdict === 'block') {
      logger.warn({ tool: toolName, ...loopCheck }, 'Tool loop — activating stall breaker');
      this.activate(loopCheck.detail ?? 'Repetitive tool calls detected.');
    }

    // Metacognitive monitor — only hard-block on 'intervene'.
    // 'warn' logs and drops confidence but doesn't activate the breaker,
    // so the agent can still read during legitimate multi-file research.
    if (!wasDenied) {
      const mcSignal = this.metacog.recordToolCall(toolName, input);
      if (mcSignal.type === 'intervene') {
        logger.warn({ reason: mcSignal.reason }, `Metacognition intervene: ${mcSignal.guidance?.slice(0, 80)}`);
        this.activate(mcSignal.guidance ?? 'Agent appears stuck.');
      } else if (mcSignal.type === 'warn') {
        logger.info({ reason: mcSignal.reason }, `Metacognition warn: ${mcSignal.guidance?.slice(0, 80)}`);
      }
    }

    // Audit trail
    this.toolCallLog.push(`${wasDenied ? '✗' : ''}${toolName}(${JSON.stringify(input).slice(0, 200)})`);
  }

  /**
   * Record a tool result for the loop detector's poll-no-progress check.
   */
  recordToolResult(resultText: string): void {
    this.loopDetector.recordResult(resultText);
  }

  /**
   * Post-query: check if the response promises action without delivery.
   */
  detectPromiseWithoutAction(responseText: string): MetacognitiveSignal {
    return this.metacog.detectPromiseWithoutAction(responseText, this.toolCallLog.length);
  }

  /**
   * Get summary for logging and cross-query stall nudge decisions.
   */
  getSummary(): StallSummary {
    return {
      metacognition: this.metacog.getSummary(),
      breakerActivated: this.breakerActive,
      breakerReason: this.breakerReason,
      toolCalls: [...this.toolCallLog],
    };
  }

  /** Get tool call log for transcript auditing. */
  getToolCalls(): string[] {
    return [...this.toolCallLog];
  }

  private activate(reason: string): void {
    this.breakerActive = true;
    this.breakerReason = reason;
  }

  private callKey(toolName: string, input: Record<string, unknown>): string {
    return `${toolName}:${JSON.stringify(input)}`;
  }
}
