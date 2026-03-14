/**
 * Clementine TypeScript — Self-Improvement Loop Engine.
 *
 * Implements Karpathy's autoresearch iterative loop for autonomous self-improvement:
 * hypothesize → execute → evaluate → keep/revert → repeat.
 *
 * Evaluates Clementine's own outputs (transcripts, feedback, cron logs) and proposes
 * improvements to system prompts, cron job prompts, workflows, and memory settings.
 * All proposed changes require Discord approval before being applied.
 */

import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import pino from 'pino';

import {
  BASE_DIR,
  SELF_IMPROVE_DIR,
  SOUL_FILE,
  CRON_FILE,
  WORKFLOWS_DIR,
  VAULT_DIR,
  MEMORY_DB_PATH,
} from '../config.js';
import type {
  CronRunEntry,
  Feedback,
  SelfImproveConfig,
  SelfImproveExperiment,
  SelfImproveState,
} from '../types.js';
import type { PersonalAssistant } from './assistant.js';

const logger = pino({ name: 'clementine.self-improve' });

// ── Defaults ─────────────────────────────────────────────────────────

const DEFAULT_CONFIG: SelfImproveConfig = {
  maxIterations: 10,
  iterationBudgetMs: 300_000,       // 5 min
  maxDurationMs: 3_600_000,         // 1 hour
  acceptThreshold: 0.6,
  plateauLimit: 3,
  areas: ['soul', 'cron', 'workflow', 'memory'],
};

// ── Paths ────────────────────────────────────────────────────────────

const EXPERIMENT_LOG = path.join(SELF_IMPROVE_DIR, 'experiment-log.jsonl');
const STATE_FILE = path.join(SELF_IMPROVE_DIR, 'state.json');
const PENDING_DIR = path.join(SELF_IMPROVE_DIR, 'pending-changes');

// ── Internal types ───────────────────────────────────────────────────

interface PerformanceSnapshot {
  feedbackStats: { positive: number; negative: number; mixed: number; total: number };
  negativeFeedback: Feedback[];
  cronErrors: CronRunEntry[];
  cronSuccessRate: number;
}

// ── SelfImproveLoop ──────────────────────────────────────────────────

export class SelfImproveLoop {
  private config: SelfImproveConfig;
  private assistant: PersonalAssistant;

  constructor(
    assistant: PersonalAssistant,
    config?: Partial<SelfImproveConfig>,
  ) {
    this.assistant = assistant;
    this.config = { ...DEFAULT_CONFIG, ...config };
    ensureDirs();
  }

  // ── Main entry point ──────────────────────────────────────────────

  async run(
    onProposal?: (experiment: SelfImproveExperiment) => Promise<void>,
  ): Promise<SelfImproveState> {
    const state = this.loadState();
    state.status = 'running';
    state.lastRunAt = new Date().toISOString();
    state.currentIteration = 0;
    this.saveState(state);

    const loopStart = Date.now();
    const history = this.loadExperimentLog();
    let consecutiveLow = 0;

    try {
      // Step 1: Gather baseline metrics
      const metrics = await this.gatherMetrics();
      state.baselineMetrics = {
        feedbackPositiveRatio: metrics.feedbackStats.total > 0
          ? metrics.feedbackStats.positive / metrics.feedbackStats.total
          : 1,
        cronSuccessRate: metrics.cronSuccessRate,
        avgResponseQuality: 0, // Updated as we evaluate
      };

      for (let i = 1; i <= this.config.maxIterations; i++) {
        // Check time budget
        if (Date.now() - loopStart > this.config.maxDurationMs) {
          logger.info('Self-improve loop hit time limit — stopping');
          break;
        }

        // Check plateau
        if (consecutiveLow >= this.config.plateauLimit) {
          logger.info({ consecutiveLow }, 'Plateau detected — stopping');
          break;
        }

        state.currentIteration = i;
        this.saveState(state);

        const iterStart = Date.now();
        const id = randomBytes(4).toString('hex');

        try {
          // Step 2-3: Diagnose + hypothesize
          const proposal = await this.withTimeout(
            this.hypothesize(metrics, history),
            this.config.iterationBudgetMs,
          );

          if (!proposal) {
            logger.info({ iteration: i }, 'No hypothesis generated — skipping');
            consecutiveLow++;
            continue;
          }

          // Step 4: Read current state
          const before = await this.readCurrentState(proposal.area, proposal.target);

          // Step 5: Evaluate
          const evaluation = await this.withTimeout(
            this.evaluate(before, proposal.proposedChange, proposal.hypothesis),
            60_000, // 1 min for evaluation
          );

          const score = evaluation?.score ?? 0;
          const normalizedScore = score / 10; // Convert 0-10 to 0-1
          const accepted = normalizedScore >= this.config.acceptThreshold;

          const experiment: SelfImproveExperiment = {
            id,
            iteration: i,
            startedAt: new Date(iterStart).toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: Date.now() - iterStart,
            area: proposal.area,
            target: proposal.target,
            hypothesis: proposal.hypothesis,
            proposedChange: proposal.proposedChange,
            baselineScore: normalizedScore,
            score: normalizedScore,
            accepted,
            approvalStatus: accepted ? 'pending' : 'denied',
            reason: accepted
              ? `Score ${score}/10 exceeds threshold — pending approval`
              : `Score ${score}/10 below threshold (${this.config.acceptThreshold * 10}/10)`,
          };

          // Step 7: Log
          this.appendExperimentLog(experiment);
          history.push(experiment);
          state.totalExperiments++;

          // Step 6: Gate — save pending change + notify
          if (accepted) {
            await this.savePendingChange(experiment, before);
            state.pendingApprovals++;
            if (onProposal) {
              await onProposal(experiment);
            }
            consecutiveLow = 0;
          } else {
            consecutiveLow++;
          }

          logger.info({
            iteration: i,
            id,
            area: proposal.area,
            score,
            accepted,
          }, `Iteration ${i} complete`);
        } catch (err) {
          const experiment: SelfImproveExperiment = {
            id,
            iteration: i,
            startedAt: new Date(iterStart).toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: Date.now() - iterStart,
            area: this.config.areas[0],
            target: 'unknown',
            hypothesis: 'Error during iteration',
            proposedChange: '',
            baselineScore: 0,
            score: 0,
            accepted: false,
            approvalStatus: 'denied',
            reason: 'Error during iteration',
            error: String(err),
          };
          this.appendExperimentLog(experiment);
          history.push(experiment);
          state.totalExperiments++;
          consecutiveLow++;

          logger.error({ err, iteration: i }, `Iteration ${i} failed`);
        }

        this.saveState(state);
      }

      state.status = 'completed';
    } catch (err) {
      state.status = 'failed';
      logger.error({ err }, 'Self-improve loop failed');
    }

    this.saveState(state);

    // Memory cleanup at end of nightly run
    await this.runMemoryCleanup();

    return state;
  }

  // ── Step 1: Gather performance data ──────────────────────────────

  private async gatherMetrics(): Promise<PerformanceSnapshot> {
    const { MemoryStore } = await import('../memory/store.js');
    const store = new MemoryStore(MEMORY_DB_PATH, VAULT_DIR);
    store.initialize();

    const feedbackStats = store.getFeedbackStats();
    const negativeFeedback = store.getRecentFeedback(20)
      .filter(f => f.rating === 'negative');

    store.close();

    // Gather cron errors from run logs
    const { CronRunLog } = await import('../gateway/heartbeat.js');
    const runLog = new CronRunLog();
    const cronErrors: CronRunEntry[] = [];
    let cronTotal = 0;
    let cronOk = 0;

    const runsDir = path.join(BASE_DIR, 'cron', 'runs');
    if (existsSync(runsDir)) {
      const files = readdirSync(runsDir).filter(f => f.endsWith('.jsonl'));
      for (const file of files) {
        // Filename is the sanitized job name — pass as-is to readRecent
        // (readRecent applies the same sanitization internally)
        const sanitizedName = file.replace('.jsonl', '');
        const entries = runLog.readRecent(sanitizedName, 20);
        for (const entry of entries) {
          cronTotal++;
          if (entry.status === 'ok') {
            cronOk++;
          } else {
            cronErrors.push(entry);
          }
        }
      }
    }

    return {
      feedbackStats,
      negativeFeedback,
      cronErrors: cronErrors.slice(0, 10),
      cronSuccessRate: cronTotal > 0 ? cronOk / cronTotal : 1,
    };
  }

  // ── Steps 2-3: Diagnose + Hypothesize ────────────────────────────

  private async hypothesize(
    metrics: PerformanceSnapshot,
    history: SelfImproveExperiment[],
  ): Promise<{ area: SelfImproveExperiment['area']; target: string; hypothesis: string; proposedChange: string } | null> {
    // Read current configuration files
    const soulContent = existsSync(SOUL_FILE) ? readFileSync(SOUL_FILE, 'utf-8').slice(0, 3000) : '(not found)';
    const cronContent = existsSync(CRON_FILE) ? readFileSync(CRON_FILE, 'utf-8').slice(0, 2000) : '(not found)';

    let workflowSummaries = '(none)';
    if (existsSync(WORKFLOWS_DIR)) {
      const wfFiles = readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith('.md'));
      workflowSummaries = wfFiles.map(f => {
        const content = readFileSync(path.join(WORKFLOWS_DIR, f), 'utf-8');
        return `- ${f}: ${content.slice(0, 200)}...`;
      }).join('\n') || '(none)';
    }

    // Format experiment history for the prompt
    const historyText = history.slice(-20).map(e =>
      `#${e.iteration} | ${e.area} | "${e.hypothesis.slice(0, 60)}" | ${(e.score * 10).toFixed(1)}/10 ${e.accepted ? '✅' : '❌'}`
    ).join('\n') || '(no prior experiments)';

    // Format negative feedback
    const negativeFeedbackText = metrics.negativeFeedback.slice(0, 5).map(f =>
      `- Rating: ${f.rating} | Message: "${(f.messageSnippet ?? '').slice(0, 100)}" | Response: "${(f.responseSnippet ?? '').slice(0, 100)}"${f.comment ? ` | Comment: "${f.comment}"` : ''}`
    ).join('\n') || '(no negative feedback)';

    // Format cron errors
    const cronErrorsText = metrics.cronErrors.slice(0, 5).map(e =>
      `- Job: ${e.jobName} | Error: ${(e.error ?? 'unknown').slice(0, 200)} | At: ${e.startedAt}`
    ).join('\n') || '(no cron errors)';

    const areas = this.config.areas.map(a => `'${a}'`).join(', ');

    const prompt =
      `You are Clementine's self-improvement strategist. Analyze performance data and propose ONE specific improvement.\n\n` +
      `## Recent Performance Data (last 7 days)\n` +
      `- Feedback: ${metrics.feedbackStats.positive} positive, ${metrics.feedbackStats.negative} negative, ${metrics.feedbackStats.mixed} mixed (${metrics.feedbackStats.total} total)\n` +
      `- Cron success rate: ${(metrics.cronSuccessRate * 100).toFixed(1)}%\n\n` +
      `### Negative feedback examples:\n${negativeFeedbackText}\n\n` +
      `### Cron job errors:\n${cronErrorsText}\n\n` +
      `## Current Configuration\n` +
      `### SOUL.md (personality/behavior):\n${soulContent}\n\n` +
      `### CRON.md (scheduled jobs):\n${cronContent}\n\n` +
      `### Workflows:\n${workflowSummaries}\n\n` +
      `## Experiment History (avoid repeating failed approaches):\n${historyText}\n\n` +
      `## Instructions\n` +
      `- Focus on areas: ${areas}\n` +
      `- Identify the SINGLE highest-impact improvement area\n` +
      `- Propose a SPECIFIC, MINIMAL change (not a full rewrite)\n` +
      `- Explain WHY this change should improve the metric\n` +
      `- IMPORTANT: "proposedChange" must be the COMPLETE updated file content (not just the diff or changed section), because it will replace the entire file\n` +
      `- If there's no clear improvement needed, output: { "area": null }\n\n` +
      `Output ONLY a JSON object with this structure (no markdown, no explanation):\n` +
      `{ "area": "soul"|"cron"|"workflow"|"memory", "target": "file name or section", "hypothesis": "what will improve and why", "proposedChange": "the complete updated file content with your minimal change applied" }`;

    const result = await this.assistant.runPlanStep('si-hypothesize', prompt, {
      tier: 2,
      maxTurns: 5,
      disableTools: true,
    });

    return this.parseJsonResponse<{
      area: SelfImproveExperiment['area'];
      target: string;
      hypothesis: string;
      proposedChange: string;
    }>(result);
  }

  // ── Step 4: Read current state ───────────────────────────────────

  private async readCurrentState(area: string, target: string): Promise<string> {
    switch (area) {
      case 'soul':
        return existsSync(SOUL_FILE) ? readFileSync(SOUL_FILE, 'utf-8') : '';
      case 'cron':
        return existsSync(CRON_FILE) ? readFileSync(CRON_FILE, 'utf-8') : '';
      case 'workflow': {
        const wfFile = path.join(WORKFLOWS_DIR, target.endsWith('.md') ? target : `${target}.md`);
        return existsSync(wfFile) ? readFileSync(wfFile, 'utf-8') : '';
      }
      case 'memory':
        return `(memory configuration — target: ${target})`;
      default:
        return '';
    }
  }

  // ── Step 5: LLM judge evaluation ─────────────────────────────────

  private async evaluate(
    before: string,
    after: string,
    hypothesis: string,
  ): Promise<{ score: number; reasoning: string } | null> {
    const prompt =
      `Score this proposed change to Clementine's configuration on a 0-10 scale.\n\n` +
      `## Current text (before):\n${before.slice(0, 3000)}\n\n` +
      `## Proposed change (after):\n${after.slice(0, 3000)}\n\n` +
      `## Hypothesis:\n${hypothesis}\n\n` +
      `## Criteria:\n` +
      `1. Clarity: Is the new text clearer and more specific?\n` +
      `2. Safety: Does it maintain appropriate guardrails?\n` +
      `3. Impact: Will it likely improve the identified weakness?\n` +
      `4. Risk: Could it cause regressions in other areas?\n` +
      `5. Minimality: Is it the smallest change that achieves the goal?\n\n` +
      `Output ONLY a JSON object (no markdown, no explanation):\n` +
      `{ "score": <0-10>, "reasoning": "brief explanation" }`;

    const result = await this.assistant.runPlanStep('si-evaluate', prompt, {
      tier: 2,
      maxTurns: 3,
      disableTools: true,
    });

    return this.parseJsonResponse<{ score: number; reasoning: string }>(result);
  }

  // ── Step 6: Save pending change ──────────────────────────────────

  private async savePendingChange(
    experiment: SelfImproveExperiment,
    before: string,
  ): Promise<void> {
    ensureDirs();
    const filePath = path.join(PENDING_DIR, `${experiment.id}.json`);
    const pending = {
      ...experiment,
      before,
    };
    writeFileSync(filePath, JSON.stringify(pending, null, 2));
    logger.info({ id: experiment.id, area: experiment.area }, 'Saved pending change');
  }

  // ── Apply approved change ────────────────────────────────────────

  async applyApprovedChange(experimentId: string): Promise<string> {
    const pendingFile = path.join(PENDING_DIR, `${experimentId}.json`);
    if (!existsSync(pendingFile)) {
      return `Pending change not found: ${experimentId}`;
    }

    const pending = JSON.parse(readFileSync(pendingFile, 'utf-8')) as SelfImproveExperiment & { before: string };
    const targetPath = this.resolveTargetPath(pending.area, pending.target);

    if (!targetPath) {
      return `Cannot resolve target path for area=${pending.area}, target=${pending.target}`;
    }

    // Write the change
    writeFileSync(targetPath, pending.proposedChange);
    logger.info({ id: experimentId, area: pending.area, target: pending.target }, 'Applied approved change');

    // Update experiment log — mark as approved
    this.updateExperimentStatus(experimentId, 'approved');

    // Remove pending file
    try {
      unlinkSync(pendingFile);
    } catch { /* ignore */ }

    // Update state
    const state = this.loadState();
    state.pendingApprovals = Math.max(0, state.pendingApprovals - 1);
    this.saveState(state);

    return `Applied change to ${pending.area}/${pending.target}`;
  }

  /** Deny a pending change without applying it. */
  denyChange(experimentId: string): string {
    const pendingFile = path.join(PENDING_DIR, `${experimentId}.json`);
    if (!existsSync(pendingFile)) {
      return `Pending change not found: ${experimentId}`;
    }

    this.updateExperimentStatus(experimentId, 'denied');

    try {
      unlinkSync(pendingFile);
    } catch { /* ignore */ }

    const state = this.loadState();
    state.pendingApprovals = Math.max(0, state.pendingApprovals - 1);
    this.saveState(state);

    return `Denied change: ${experimentId}`;
  }

  // ── Memory cleanup ───────────────────────────────────────────────

  private async runMemoryCleanup(): Promise<void> {
    try {
      const { MemoryStore } = await import('../memory/store.js');
      const store = new MemoryStore(MEMORY_DB_PATH, VAULT_DIR);
      store.initialize();

      store.decaySalience(30);
      store.pruneStaleData({
        maxAgeDays: 90,
        salienceThreshold: 0.01,
        accessLogRetentionDays: 60,
        transcriptRetentionDays: 90,
      });

      store.close();
      logger.info('Memory cleanup complete');
    } catch (err) {
      logger.error({ err }, 'Memory cleanup failed');
    }
  }

  // ── JSONL log management ─────────────────────────────────────────

  loadExperimentLog(): SelfImproveExperiment[] {
    if (!existsSync(EXPERIMENT_LOG)) return [];
    try {
      return readFileSync(EXPERIMENT_LOG, 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as SelfImproveExperiment);
    } catch {
      return [];
    }
  }

  private appendExperimentLog(entry: SelfImproveExperiment): void {
    ensureDirs();
    appendFileSync(EXPERIMENT_LOG, JSON.stringify(entry) + '\n');
  }

  private updateExperimentStatus(
    experimentId: string,
    status: SelfImproveExperiment['approvalStatus'],
  ): void {
    const experiments = this.loadExperimentLog();
    const updated = experiments.map(e =>
      e.id === experimentId ? { ...e, approvalStatus: status } : e,
    );
    writeFileSync(
      EXPERIMENT_LOG,
      updated.map(e => JSON.stringify(e)).join('\n') + '\n',
    );
  }

  // ── State management ─────────────────────────────────────────────

  loadState(): SelfImproveState {
    if (existsSync(STATE_FILE)) {
      try {
        return JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as SelfImproveState;
      } catch { /* fall through to default */ }
    }
    return {
      status: 'idle',
      lastRunAt: '',
      currentIteration: 0,
      totalExperiments: 0,
      baselineMetrics: {
        feedbackPositiveRatio: 0,
        cronSuccessRate: 0,
        avgResponseQuality: 0,
      },
      pendingApprovals: 0,
    };
  }

  private saveState(state: SelfImproveState): void {
    ensureDirs();
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }

  // ── Pending changes ──────────────────────────────────────────────

  getPendingChanges(): Array<SelfImproveExperiment & { before: string }> {
    ensureDirs();
    if (!existsSync(PENDING_DIR)) return [];
    return readdirSync(PENDING_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          return JSON.parse(readFileSync(path.join(PENDING_DIR, f), 'utf-8'));
        } catch {
          return null;
        }
      })
      .filter(Boolean) as Array<SelfImproveExperiment & { before: string }>;
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private resolveTargetPath(area: string, target: string): string | null {
    switch (area) {
      case 'soul':
        return SOUL_FILE;
      case 'cron':
        return CRON_FILE;
      case 'workflow': {
        const name = target.endsWith('.md') ? target : `${target}.md`;
        return path.join(WORKFLOWS_DIR, name);
      }
      default:
        return null;
    }
  }

  private parseJsonResponse<T>(text: string): T | null {
    // Try to extract JSON from the response (may be wrapped in markdown code blocks)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      // Check for "no improvement needed" signal
      if (parsed.area === null) return null;
      return parsed as T;
    } catch {
      logger.warn({ text: text.slice(0, 200) }, 'Failed to parse JSON response');
      return null;
    }
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    ms: number,
  ): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    });
    try {
      const result = await Promise.race([promise, timeout]);
      return result;
    } finally {
      clearTimeout(timer!);
    }
  }
}

// ── Utility ──────────────────────────────────────────────────────────

function ensureDirs(): void {
  for (const dir of [SELF_IMPROVE_DIR, PENDING_DIR]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}
