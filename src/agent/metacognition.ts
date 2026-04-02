/**
 * Clementine TypeScript — Metacognitive Monitor.
 *
 * Tracks reasoning quality signals during query/cron/unleashed execution.
 * Detects stuck loops, circular reasoning, confidence drops, and strategy
 * mismatches. Injects guidance when the agent appears to need a nudge.
 *
 * This is the foundation layer — everything else (user model, self-improve,
 * skills) works better when the agent can evaluate its own thinking.
 */

import { createHash } from 'node:crypto';
// Logging available via the caller (assistant.ts) — this module is pure logic

// ── Types ───────────────────────────────────────────────────────────

export interface MetacognitiveSignal {
  type: 'ok' | 'warn' | 'intervene';
  reason?: string;
  guidance?: string;
}

export interface MetacognitiveAssessment {
  confidence: 'high' | 'medium' | 'low';
  efficiency: number;              // useful output / total turns (0-1)
  signals: string[];               // active warning signals
  guidance?: string;               // text to inject if intervention needed
}

export interface MetacognitiveSummary {
  efficiency: number;
  toolCallCount: number;
  uniqueTools: number;
  stuckDetected: boolean;
  interventionCount: number;
  confidenceFinal: 'high' | 'medium' | 'low';
  signals: string[];
}

// ── Tool categories ─────────────────────────────────────────────────

const READ_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'memory_read', 'memory_search', 'memory_recall',
  'transcript_search', 'vault_stats', 'task_list', 'goal_list', 'goal_get',
  'workspace_list', 'workspace_info', 'cron_list', 'team_list',
  'outlook_inbox', 'outlook_search', 'outlook_calendar', 'github_prs',
  'rss_fetch', 'WebSearch', 'WebFetch',
]);

const ACTION_TOOLS = new Set([
  'Write', 'Edit', 'Bash', 'Agent', 'Task', 'delegate_task',
  'memory_write', 'note_create', 'note_take',
  'task_add', 'task_update', 'goal_create', 'goal_update', 'goal_work',
  'add_cron_job', 'create_agent', 'update_agent', 'delete_agent',
  'team_message', 'discord_channel_send', 'outlook_draft', 'outlook_send',
  'set_timer', 'self_restart', 'feedback_log', 'teach_skill', 'create_tool',
]);

// ── MetacognitiveMonitor ────────────────────────────────────────────

export class MetacognitiveMonitor {
  private toolCalls: Array<{ name: string; inputHash: string; timestamp: number }> = [];
  private uniqueTools = new Set<string>();
  private consecutiveReads = 0;
  private turnCount = 0;
  private outputCharCount = 0;
  private interventionCount = 0;
  private signals: string[] = [];
  private confidence: 'high' | 'medium' | 'low' = 'high';

  /**
   * Record a tool call. Returns a signal if the pattern is concerning.
   */
  recordToolCall(name: string, input: Record<string, unknown>): MetacognitiveSignal {
    const inputHash = createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 12);
    this.toolCalls.push({ name, inputHash, timestamp: Date.now() });
    this.uniqueTools.add(name);

    // Normalize MCP tool names: "mcp__clementine-tools__memory_write" → "memory_write"
    const normalizedName = name.replace(/^mcp__[^_]+__/, '');

    // Track read/action balance (check both raw and normalized names)
    if (READ_TOOLS.has(name) || READ_TOOLS.has(normalizedName)) {
      this.consecutiveReads++;
    } else if (ACTION_TOOLS.has(name) || ACTION_TOOLS.has(normalizedName)) {
      this.consecutiveReads = 0;
    }

    // Signal: too many consecutive reads without action
    // Fires on every read past the threshold (not just once) so the stall breaker stays active
    if (this.consecutiveReads >= 12) {
      this.confidence = 'low';
      if (!this.signals.includes('research_without_action')) this.signals.push('research_without_action');
      this.interventionCount++;
      return {
        type: 'intervene',
        reason: 'research_without_action',
        guidance: `You've done ${this.consecutiveReads} consecutive reads without acting. STOP reading and either act on what you have or tell the user what's blocking you.`,
      };
    }
    if (this.consecutiveReads >= 8) {
      this.confidence = 'medium';
      if (!this.signals.includes('research_without_action')) this.signals.push('research_without_action');
      return {
        type: 'warn',
        reason: 'research_without_action',
        guidance: `You've done ${this.consecutiveReads} consecutive reads without acting. Pick a strategy: ` +
          `(1) Delegate — spawn sub-agents via the Agent tool for parallel work. ` +
          `(2) Plan — respond with [PLAN_NEEDED: description] for complex tasks. ` +
          `(3) Act on partial info — start editing with what you know. ` +
          `(4) Ask the user a specific question if scope is unclear.`,
      };
    }

    // Signal: same tool + similar input called 3+ times
    const recentSame = this.toolCalls
      .slice(-10)
      .filter(t => t.name === name && t.inputHash === inputHash);
    if (recentSame.length >= 3) {
      this.confidence = 'low';
      const signal: MetacognitiveSignal = {
        type: 'intervene',
        reason: 'circular_reasoning',
        guidance: `You've called ${name} with the same input ${recentSame.length} times. Try a different approach or tool.`,
      };
      if (!this.signals.includes('circular_reasoning')) this.signals.push('circular_reasoning');
      this.interventionCount++;
      return signal;
    }

    // Signal: excessive tool calls (>20 in a single execution)
    if (this.toolCalls.length > 20 && this.outputCharCount < 200) {
      this.confidence = 'low';
      if (!this.signals.includes('high_effort_low_output')) {
        this.signals.push('high_effort_low_output');
        return {
          type: 'warn',
          reason: 'high_effort_low_output',
          guidance: 'You\'ve made 20+ tool calls with minimal output. Step back and simplify your approach.',
        };
      }
    }

    return { type: 'ok' };
  }

  /**
   * Assess the quality of the current turn after the assistant responds.
   */
  assessTurn(responseText: string, toolCallsThisTurn: number): MetacognitiveAssessment {
    this.turnCount++;
    this.outputCharCount += responseText.length;

    // Reset consecutive reads if the agent produced substantial output
    if (responseText.length > 100 && toolCallsThisTurn === 0) {
      this.consecutiveReads = 0;
    }

    const efficiency = this.turnCount > 0
      ? Math.min(1, this.outputCharCount / (this.turnCount * 500))
      : 0;

    // Detect turns with no progress
    if (responseText.length < 20 && toolCallsThisTurn === 0) {
      if (!this.signals.includes('empty_turn')) this.signals.push('empty_turn');
    }

    // Build guidance if confidence is low
    let guidance: string | undefined;
    if (this.confidence === 'low' && this.interventionCount < 3) {
      guidance = this.buildGuidance();
      if (guidance) this.interventionCount++;
    }

    return {
      confidence: this.confidence,
      efficiency,
      signals: [...this.signals],
      guidance,
    };
  }

  /**
   * Get the final metacognitive summary for this execution.
   */
  getSummary(): MetacognitiveSummary {
    const efficiency = this.turnCount > 0
      ? Math.min(1, this.outputCharCount / (this.turnCount * 500))
      : 0;

    return {
      efficiency: Math.round(efficiency * 100) / 100,
      toolCallCount: this.toolCalls.length,
      uniqueTools: this.uniqueTools.size,
      stuckDetected: this.signals.includes('circular_reasoning') || this.signals.includes('research_without_action'),
      interventionCount: this.interventionCount,
      confidenceFinal: this.confidence,
      signals: [...this.signals],
    };
  }

  /**
   * Build contextual guidance based on current signals.
   */
  private buildGuidance(): string | undefined {
    if (this.signals.includes('circular_reasoning')) {
      return '[SELF-CHECK: You appear to be going in circles. Try a completely different approach to this problem.]';
    }
    if (this.signals.includes('research_without_action')) {
      return '[SELF-CHECK: You\'ve been researching extensively. Time to act on what you\'ve gathered — deliver a result with what you know.]';
    }
    if (this.signals.includes('high_effort_low_output')) {
      return '[SELF-CHECK: High effort, low output. Can you accomplish this more directly? Simplify your approach.]';
    }
    return undefined;
  }

  /**
   * Detect when the agent's text promises action but no tools were called.
   * Call this after the query completes with the full response text.
   *
   * @returns A signal if the response looks like a stall (promised action, didn't deliver).
   */
  detectPromiseWithoutAction(responseText: string, toolCallCount: number): MetacognitiveSignal {
    if (toolCallCount > 2) return { type: 'ok' };

    const lower = responseText.toLowerCase();
    const ACTION_PROMISES = [
      /\blet me (?:read|grab|check|pull|get|look at|open|find|fetch|load)\b/,
      /\bi'?ll (?:read|grab|check|pull|get|look at|open|find|fetch|start|work on)\b/,
      /\bstarting (?:with|on|now)\b/,
      /\bstill (?:on it|working|reading|looking)\b/,
      /\bgive me (?:a moment|a sec|one moment)\b/,
      /\bworking on (?:it|that|this)\b/,
      /\blet me (?:take|have) a look\b/,
    ];

    const promisedAction = ACTION_PROMISES.some((rx) => rx.test(lower));
    if (!promisedAction) return { type: 'ok' };

    // The agent said it would do something but made 0-2 tool calls — likely stalled
    if (!this.signals.includes('promise_without_action')) {
      this.signals.push('promise_without_action');
    }
    this.confidence = 'low';
    this.interventionCount++;

    return {
      type: 'intervene',
      reason: 'promise_without_action',
      guidance:
        'You said you would take action but did not follow through. ' +
        'Do not promise to read/grab/check something without actually doing it in the same turn.',
    };
  }

  /** Reset for a new execution (e.g., new phase in unleashed). */
  reset(): void {
    this.toolCalls = [];
    this.uniqueTools.clear();
    this.consecutiveReads = 0;
    this.turnCount = 0;
    this.outputCharCount = 0;
    this.signals = [];
    // Keep interventionCount and confidence across phases for learning
  }
}
