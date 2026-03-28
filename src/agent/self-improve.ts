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
import matter from 'gray-matter';
import path from 'node:path';
import pino from 'pino';

import {
  BASE_DIR,
  SELF_IMPROVE_DIR,
  SOUL_FILE,
  AGENTS_FILE,
  CRON_FILE,
  WORKFLOWS_DIR,
  VAULT_DIR,
  MEMORY_DB_PATH,
  AGENTS_DIR,
  PKG_DIR,
  CRON_REFLECTIONS_DIR,
  GOALS_DIR,
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
  areas: ['soul', 'cron', 'workflow', 'memory', 'agent', 'source', 'communication'],
  autoApply: true,
};

// ── Paths ────────────────────────────────────────────────────────────

const EXPERIMENT_LOG = path.join(SELF_IMPROVE_DIR, 'experiment-log.jsonl');
const STATE_FILE = path.join(SELF_IMPROVE_DIR, 'state.json');
const PENDING_DIR = path.join(SELF_IMPROVE_DIR, 'pending-changes');
const APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const IMPACT_CHECKS_FILE = path.join(SELF_IMPROVE_DIR, 'impact-checks.jsonl');

// ── Risk classification ──────────────────────────────────────────────

/** Risk tiers for self-improvement proposals. */
type RiskTier = 'low' | 'medium' | 'high';

/** Classify the risk level of a proposed change.
 * - low: agent prompts, individual cron job prompts — auto-apply safe
 * - medium: SOUL.md, AGENTS.md, MEMORY.md — needs owner approval
 * - high: source code — stays blocked
 */
function classifyRisk(area: string): RiskTier {
  switch (area) {
    case 'agent':     return 'low';    // Agent-scoped, easily reversible
    case 'cron':      return 'low';    // Cron prompt tweaks, low blast radius
    case 'workflow':  return 'low';    // Workflow definitions, scoped
    case 'soul':      return 'medium'; // Core personality — needs approval
    case 'communication': return 'medium'; // Global operating instructions
    case 'memory':    return 'medium'; // Memory config
    case 'source':    return 'high';   // Code changes — always blocked in auto mode
    default:          return 'high';
  }
}

// ── Internal types ───────────────────────────────────────────────────

interface CronReflectionEntry {
  jobName: string;
  agentSlug?: string;
  timestamp: string;
  existence?: boolean;
  substance?: boolean;
  actionable?: boolean;
  communication?: boolean;
  criteriaMet?: boolean | null;
  quality: number;
  gap?: string;
  commNote?: string;
}

interface GoalHealthEntry {
  id: string;
  title: string;
  status: string;
  owner: string;
  priority: string;
  daysSinceUpdate: number;
  reviewFrequency: string;
  isStale: boolean;
  linkedCronJobs: string[];
  progressCount: number;
}

interface PerformanceSnapshot {
  feedbackStats: { positive: number; negative: number; mixed: number; total: number };
  negativeFeedback: Feedback[];
  cronErrors: CronRunEntry[];
  cronSuccessRate: number;
  cronReflections: CronReflectionEntry[];
  goalHealth: GoalHealthEntry[];
  advisorInsights: string[];
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
    this.reconcileState();
    this.expireStaleProposals();
    await this.checkAppliedImpact();
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

      // Synthesize feedback patterns before experiment loop
      await this.synthesizeFeedbackPatterns();

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

          // Diversity safety net: skip if hypothesis targets an over-represented area:target
          const proposalKey = `${proposal.area}:${proposal.target}`;
          const proposalCount = history.filter(e => `${e.area}:${e.target}` === proposalKey).length
            + this.getPendingChanges().filter(p => `${p.area}:${p.target}` === proposalKey).length;
          if (proposalCount >= 3) {
            logger.warn({ area: proposal.area, target: proposal.target, count: proposalCount },
              'Hypothesis over-targeted — skipping');
            consecutiveLow++;
            continue;
          }

          const validation = this.validateProposal(proposal.area, proposal.target, proposal.proposedChange);
          if (!validation.valid) {
            logger.warn({ area: proposal.area, target: proposal.target, error: validation.error },
              'Proposed change failed validation — skipping');
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

          const priorScores = history
            .filter(e => e.area === proposal.area && e.target === proposal.target && e.score > 0)
            .map(e => e.score);
          const baselineScore = priorScores.length > 0
            ? priorScores.reduce((a, b) => a + b, 0) / priorScores.length
            : 0.5;

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
            baselineScore,
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

          // Step 6: Gate — save pending change + notify (tiered by risk)
          if (accepted) {
            const risk = classifyRisk(proposal.area);

            if (this.config.autoApply && risk === 'low') {
              // Low-risk + auto-apply enabled: apply immediately without approval
              const targetPath = this.resolveTargetPath(proposal.area, proposal.target);
              if (targetPath) {
                // Validate before auto-applying
                const autoValidation = this.validateProposal(proposal.area, proposal.target, proposal.proposedChange);
                if (autoValidation.valid) {
                  writeFileSync(targetPath, proposal.proposedChange);
                  experiment.approvalStatus = 'approved';
                  this.updateExperimentStatus(id, 'approved');
                  // Schedule impact check
                  try {
                    appendFileSync(IMPACT_CHECKS_FILE, JSON.stringify({
                      experimentId: id,
                      area: proposal.area,
                      target: proposal.target,
                      appliedAt: new Date().toISOString(),
                      checkAfterMs: 24 * 60 * 60 * 1000,
                    }) + '\n');
                  } catch { /* non-fatal */ }
                  logger.info({ id, area: proposal.area, target: proposal.target, risk },
                    'Auto-applied low-risk change');
                } else {
                  logger.warn({ id, error: autoValidation.error }, 'Auto-apply blocked by validation');
                  await this.savePendingChange(experiment, before);
                  state.pendingApprovals++;
                }
              } else {
                await this.savePendingChange(experiment, before);
                state.pendingApprovals++;
              }
            } else if (this.config.autoApply && risk === 'high') {
              // High-risk: skip entirely in auto mode (don't even save as pending)
              logger.info({ id, area: proposal.area, risk }, 'Skipped high-risk proposal in auto mode');
              experiment.approvalStatus = 'denied';
              experiment.reason = 'High-risk area blocked in autonomous mode';
            } else {
              // Medium-risk or manual mode: save as pending for approval
              await this.savePendingChange(experiment, before);
              state.pendingApprovals++;
              if (onProposal) {
                await onProposal(experiment);
              }
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

      // Update avgResponseQuality from this run's scores
      const runScores = history.filter(e => e.iteration >= 1 && e.score > 0).map(e => e.score);
      if (runScores.length > 0) {
        state.baselineMetrics.avgResponseQuality = runScores.reduce((a, b) => a + b, 0) / runScores.length;
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

  // ── Per-agent focused cycle ────────────────────────────────────────

  /** Run a focused self-improvement cycle for a specific agent. */
  async runForAgent(
    agentSlug: string,
    onProposal?: (experiment: SelfImproveExperiment) => Promise<void>,
  ): Promise<SelfImproveState> {
    // Override config for agent-focused run
    this.config = {
      ...this.config,
      maxIterations: 5,              // Fewer iterations for focused run
      maxDurationMs: 600_000,        // 10 min max
      areas: ['agent', 'cron'],      // Only agent-scoped areas
      autoApply: true,               // Auto-apply for agent changes
      agentSlug,
    };
    return this.run(onProposal);
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

    // Gather cron reflections (quality ratings from post-cron reflection passes)
    const cronReflections: CronReflectionEntry[] = [];
    try {
      if (existsSync(CRON_REFLECTIONS_DIR)) {
        const reflFiles = readdirSync(CRON_REFLECTIONS_DIR).filter(f => f.endsWith('.jsonl'));
        for (const file of reflFiles) {
          const lines = readFileSync(path.join(CRON_REFLECTIONS_DIR, file), 'utf-8').trim().split('\n');
          // Take the most recent 5 reflections per job
          for (const line of lines.slice(-5)) {
            try { cronReflections.push(JSON.parse(line)); } catch { /* skip malformed */ }
          }
        }
      }
    } catch { /* non-fatal */ }

    // Gather goal health data
    const goalHealth: GoalHealthEntry[] = [];
    try {
      if (existsSync(GOALS_DIR)) {
        const goalFiles = readdirSync(GOALS_DIR).filter(f => f.endsWith('.json'));
        const now = Date.now();
        const DAY_MS = 86_400_000;
        for (const file of goalFiles) {
          try {
            const goal = JSON.parse(readFileSync(path.join(GOALS_DIR, file), 'utf-8'));
            const lastUpdate = goal.updatedAt ? new Date(goal.updatedAt).getTime() : 0;
            const daysSinceUpdate = Math.floor((now - lastUpdate) / DAY_MS);
            const staleThreshold = goal.reviewFrequency === 'daily' ? 1 : goal.reviewFrequency === 'weekly' ? 7 : 30;
            goalHealth.push({
              id: goal.id,
              title: goal.title,
              status: goal.status,
              owner: goal.owner,
              priority: goal.priority,
              daysSinceUpdate,
              reviewFrequency: goal.reviewFrequency,
              isStale: goal.status === 'active' && daysSinceUpdate > staleThreshold,
              linkedCronJobs: goal.linkedCronJobs || [],
              progressCount: goal.progressNotes?.length ?? 0,
            });
          } catch { /* skip malformed */ }
        }
      }
    } catch { /* non-fatal */ }

    // Gather execution advisor insights (if available)
    const advisorInsights: string[] = [];
    try {
      const advisorLog = path.join(BASE_DIR, 'cron', 'advisor-decisions.jsonl');
      if (existsSync(advisorLog)) {
        const advisorLines = readFileSync(advisorLog, 'utf-8').trim().split('\n').filter(Boolean);
        const outcomes = advisorLines.slice(-100)
          .map(l => { try { return JSON.parse(l); } catch { return null; } })
          .filter((d): d is any => d?.type === 'outcome');

        // Summarize per-job intervention effectiveness
        const byJob = new Map<string, { interventions: Map<string, { ok: number; total: number }> }>();
        for (const o of outcomes) {
          if (!byJob.has(o.jobName)) byJob.set(o.jobName, { interventions: new Map() });
          const jm = byJob.get(o.jobName)!;
          for (const [key, val] of Object.entries(o.interventions ?? {})) {
            if (!val) continue;
            if (!jm.interventions.has(key)) jm.interventions.set(key, { ok: 0, total: 0 });
            const stats = jm.interventions.get(key)!;
            stats.total++;
            if (o.outcome === 'ok') stats.ok++;
          }
        }

        for (const [job, data] of byJob) {
          for (const [intervention, stats] of data.interventions) {
            if (stats.total >= 2) {
              advisorInsights.push(`${job}: ${intervention} — ${((stats.ok / stats.total) * 100).toFixed(0)}% success (n=${stats.total})`);
            }
          }
        }
      }
    } catch { /* non-fatal */ }

    // Filter to target agent if running per-agent cycle
    let filteredReflections = cronReflections;
    let filteredErrors = cronErrors;
    if (this.config.agentSlug) {
      filteredReflections = cronReflections.filter(r => r.agentSlug === this.config.agentSlug);
      filteredErrors = cronErrors.filter(e => (e as any).agentSlug === this.config.agentSlug);
    }

    return {
      feedbackStats,
      negativeFeedback,
      cronErrors: filteredErrors.slice(0, 10),
      cronSuccessRate: cronTotal > 0 ? cronOk / cronTotal : 1,
      cronReflections: filteredReflections.slice(-20),
      goalHealth,
      advisorInsights,
    };
  }

  // ── Steps 2-3: Diagnose + Hypothesize ────────────────────────────

  private async hypothesize(
    metrics: PerformanceSnapshot,
    history: SelfImproveExperiment[],
  ): Promise<{ area: SelfImproveExperiment['area']; target: string; hypothesis: string; proposedChange: string } | null> {
    // Read targeted triggers (written by cron scheduler when jobs fail repeatedly)
    let targetedTriggers = '';
    const triggersDir = path.join(SELF_IMPROVE_DIR, 'triggers');
    if (existsSync(triggersDir)) {
      const triggerFiles = readdirSync(triggersDir).filter(f => f.endsWith('.json'));
      if (triggerFiles.length > 0) {
        const triggers = triggerFiles.slice(0, 3).map(f => {
          try {
            const t = JSON.parse(readFileSync(path.join(triggersDir, f), 'utf-8'));
            // Clean up trigger after reading
            unlinkSync(path.join(triggersDir, f));
            return t;
          } catch { return null; }
        }).filter(Boolean);
        if (triggers.length > 0) {
          targetedTriggers = `\n\n## PRIORITY: Failing Jobs Needing Attention\n` +
            `These jobs have been failing repeatedly and need prompt/config fixes:\n` +
            triggers.map((t: any) => `- **${t.jobName}**: ${t.consecutiveErrors} consecutive errors. Recent: ${(t.recentErrors ?? []).join('; ')}`).join('\n') +
            `\n\nFocus your improvement hypothesis on fixing these jobs first.\n`;
        }
      }
    }

    // Read current configuration files
    const soulContent = existsSync(SOUL_FILE) ? readFileSync(SOUL_FILE, 'utf-8').slice(0, 3000) : '(not found)';
    const agentsContent = existsSync(AGENTS_FILE) ? readFileSync(AGENTS_FILE, 'utf-8').slice(0, 2000) : '(not found)';
    const cronContent = existsSync(CRON_FILE) ? readFileSync(CRON_FILE, 'utf-8').slice(0, 2000) : '(not found)';

    let workflowSummaries = '(none)';
    if (existsSync(WORKFLOWS_DIR)) {
      const wfFiles = readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith('.md'));
      workflowSummaries = wfFiles.map(f => {
        const content = readFileSync(path.join(WORKFLOWS_DIR, f), 'utf-8');
        return `- ${f}: ${content.slice(0, 200)}...`;
      }).join('\n') || '(none)';
    }

    // Gather agent configs
    let agentSummaries = '(none)';
    if (existsSync(AGENTS_DIR)) {
      try {
        const slugs = readdirSync(AGENTS_DIR, { withFileTypes: true } as any)
          .filter((d: any) => d.isDirectory?.() ?? true)
          .map((d: any) => typeof d === 'string' ? d : d.name);
        agentSummaries = slugs.map((slug: string) => {
          const agentFile = path.join(AGENTS_DIR, slug, 'agent.md');
          if (!existsSync(agentFile)) return null;
          const content = readFileSync(agentFile, 'utf-8');
          return `- ${slug}/agent.md: ${content.slice(0, 400)}`;
        }).filter(Boolean).join('\n') || '(none)';
      } catch { agentSummaries = '(none)'; }
    }

    // Format experiment history for the prompt
    const historyText = history.slice(-20).map(e =>
      `#${e.iteration} | ${e.area} | "${e.hypothesis.slice(0, 60)}" | ${(e.score * 10).toFixed(1)}/10 ${e.accepted ? '✅' : '❌'}`
    ).join('\n') || '(no prior experiments)';

    // Enforce diversity: count recent proposals per area:target
    const recentTargets = new Map<string, number>();
    for (const e of history.slice(-15)) {
      const key = `${e.area}:${e.target}`;
      recentTargets.set(key, (recentTargets.get(key) ?? 0) + 1);
    }
    for (const p of this.getPendingChanges()) {
      const key = `${p.area}:${p.target}`;
      recentTargets.set(key, (recentTargets.get(key) ?? 0) + 1);
    }
    const overTargeted = [...recentTargets.entries()]
      .filter(([, count]) => count >= 2)
      .map(([key]) => key);

    const diversityConstraint = overTargeted.length > 0
      ? `\n\n## DIVERSITY CONSTRAINT\nThese targets have been proposed recently and MUST NOT be targeted again:\n` +
        overTargeted.map(t => `- ${t}`).join('\n') +
        `\nChoose a DIFFERENT area/target. If no other improvement is needed, output { "area": null }.\n`
      : '';

    const patternAnalysis = this.analyzeExperimentPatterns(history);

    // Format negative feedback
    const negativeFeedbackText = metrics.negativeFeedback.slice(0, 5).map(f =>
      `- Rating: ${f.rating} | Message: "${(f.messageSnippet ?? '').slice(0, 100)}" | Response: "${(f.responseSnippet ?? '').slice(0, 100)}"${f.comment ? ` | Comment: "${f.comment}"` : ''}`
    ).join('\n') || '(no negative feedback)';

    // Format cron errors
    const cronErrorsText = metrics.cronErrors.slice(0, 5).map(e =>
      `- Job: ${e.jobName} | Error: ${(e.error ?? 'unknown').slice(0, 200)} | At: ${e.startedAt}`
    ).join('\n') || '(no cron errors)';

    // Format cron reflections (quality ratings from automated reflection passes)
    const cronReflectionsText = metrics.cronReflections.slice(-10).map(r =>
      `- Job: ${r.jobName}${r.agentSlug ? ` (${r.agentSlug})` : ''} | Quality: ${r.quality}/5 | ` +
      `Exist: ${r.existence ?? '?'} Substance: ${r.substance ?? '?'} Actionable: ${r.actionable ?? '?'} ` +
      `Comm: ${r.communication ?? '?'} | ` +
      `Gap: "${r.gap?.slice(0, 80) ?? ''}"${r.commNote ? ` | CommNote: "${r.commNote.slice(0, 80)}"` : ''} | At: ${r.timestamp}`
    ).join('\n') || '(no cron reflections yet)';

    // Compute per-agent metrics from reflections
    const agentMetrics = new Map<string, { total: number; qualitySum: number; emptyCount: number; gaps: string[] }>();
    for (const r of metrics.cronReflections) {
      const slug = r.agentSlug || 'clementine';
      if (!agentMetrics.has(slug)) {
        agentMetrics.set(slug, { total: 0, qualitySum: 0, emptyCount: 0, gaps: [] });
      }
      const m = agentMetrics.get(slug)!;
      m.total++;
      m.qualitySum += r.quality ?? 0;
      if (r.existence === false || r.substance === false) m.emptyCount++;
      if (r.gap && r.gap !== 'none') m.gaps.push(r.gap);
    }

    const perAgentText = agentMetrics.size > 0
      ? Array.from(agentMetrics.entries()).map(([slug, m]) => {
          const avgQ = (m.qualitySum / m.total).toFixed(1);
          const emptyPct = ((m.emptyCount / m.total) * 100).toFixed(0);
          const topGaps = m.gaps.slice(-3).map(g => g.slice(0, 60)).join('; ') || 'none';
          return `- ${slug}: avg quality ${avgQ}/5, ${emptyPct}% empty outputs, common gaps: "${topGaps}"`;
        }).join('\n')
      : '(no per-agent data yet)';

    // Format goal health data
    const goalHealthText = metrics.goalHealth.length > 0
      ? metrics.goalHealth.map(g => {
          const staleTag = g.isStale ? ' ⚠ STALE' : '';
          const linkedTag = g.linkedCronJobs.length > 0 ? ` | Linked crons: ${g.linkedCronJobs.join(', ')}` : ' | No linked crons';
          return `- [${g.status.toUpperCase()}] ${g.title} (${g.priority}) — owner: ${g.owner} | ${g.daysSinceUpdate}d since update | ${g.progressCount} progress notes${linkedTag}${staleTag}`;
        }).join('\n')
      : '(no goals defined)';

    const advisorText = metrics.advisorInsights.length > 0
      ? metrics.advisorInsights.map(a => `- ${a}`).join('\n')
      : '(no advisor data yet)';

    const areas = this.config.areas.map(a => `'${a}'`).join(', ');

    const agentFocusText = this.config.agentSlug
      ? `\n\n## AGENT FOCUS: ${this.config.agentSlug}\nThis is a focused improvement cycle for agent "${this.config.agentSlug}" ONLY.\n` +
        `- You MUST target area "agent" with target "${this.config.agentSlug}", OR area "cron" targeting a cron job that this agent runs.\n` +
        `- Do NOT propose changes to SOUL.md, AGENTS.md, source code, or other agents.\n` +
        `- Focus on improving this agent's personality, instructions, and task execution quality.\n`
      : '';

    const prompt =
      `You are Clementine's self-improvement strategist. Analyze performance data and propose ONE specific improvement.\n\n` +
      `## Recent Performance Data (last 7 days)\n` +
      `- Feedback: ${metrics.feedbackStats.positive} positive, ${metrics.feedbackStats.negative} negative, ${metrics.feedbackStats.mixed} mixed (${metrics.feedbackStats.total} total)\n` +
      `- Cron success rate: ${(metrics.cronSuccessRate * 100).toFixed(1)}%\n\n` +
      `### Negative feedback examples:\n${negativeFeedbackText}\n\n` +
      `### Cron job quality reflections (automated self-evaluation):\n${cronReflectionsText}\n\n` +
      `### Per-agent cron performance:\n${perAgentText}\n\n` +
      `### Communication signals in feedback:\n` +
      `- "silent", "no update", "how's it going" → agent didn't report progress\n` +
      `- "too verbose", "just do it" → over-communication\n` +
      `- "confused", "what happened" → unclear status\n\n` +
      `### Goal health:\n${goalHealthText}\n\n` +
      `### Goal health signals:\n` +
      `- STALE goals → cron prompts aren't making progress, or goals aren't linked to crons\n` +
      `- Goals with 0 progress notes → agents never started working on them\n` +
      `- Goals with no linked crons → no automated work loop driving progress\n\n` +
      `### Execution advisor intervention outcomes:\n${advisorText}\n` +
      `(If an intervention has low success, the job may need a prompt rewrite rather than parameter tuning.)\n\n` +
      `### Cron job errors:\n${cronErrorsText}\n\n` +
      targetedTriggers +
      `## Current Configuration\n` +
      `### SOUL.md (personality/behavior):\n${soulContent}\n\n` +
      `### AGENTS.md (operating instructions):\n${agentsContent}\n\n` +
      `### CRON.md (scheduled jobs):\n${cronContent}\n\n` +
      `### Workflows:\n${workflowSummaries}\n\n` +
      `### Agent configs (team members with their own personality/tools):\n${agentSummaries}\n\n` +
      `## Experiment History (avoid repeating failed approaches):\n${historyText}\n\n` +
      (patternAnalysis ? `\n\n${patternAnalysis}\n` : '') +
      diversityConstraint +
      agentFocusText +
      `## Instructions\n` +
      `- Focus on areas: ${areas}\n` +
      `- Identify the SINGLE highest-impact improvement area\n` +
      `- When an agent's average quality is below 3.0 or empty output rate exceeds 10%, prioritize improving their agent.md system prompt or cron job prompts (area: "agent", target: the agent slug)\n` +
      `- Cross-reference per-agent performance with advisor intervention data: if an agent's jobs have low intervention success AND low quality, the agent's instructions likely need rewriting\n` +
      `- For agents with high empty output rates, check if their cron prompts are too vague or success criteria are missing\n` +
      `- Propose a SPECIFIC, MINIMAL change (not a full rewrite)\n` +
      `- Explain WHY this change should improve the metric\n` +
      `- IMPORTANT: "proposedChange" must be the COMPLETE updated file content (not just the diff or changed section), because it will replace the entire file\n` +
      `- If there's no clear improvement needed, output: { "area": null }\n\n` +
      `Output ONLY a JSON object with this structure (no markdown, no explanation):\n` +
      `{ "area": "soul"|"cron"|"workflow"|"memory"|"agent"|"communication", "target": "file name or section (for agent, use the slug; for communication, use 'AGENTS.md')", "hypothesis": "what will improve and why", "proposedChange": "the complete updated file content with your minimal change applied" }`;

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
      case 'agent': {
        const agentFile = path.join(AGENTS_DIR, target, 'agent.md');
        return existsSync(agentFile) ? readFileSync(agentFile, 'utf-8') : '';
      }
      case 'source': {
        const srcFile = path.join(PKG_DIR, 'src', target);
        return existsSync(srcFile) ? readFileSync(srcFile, 'utf-8') : '';
      }
      case 'communication':
        return existsSync(AGENTS_FILE) ? readFileSync(AGENTS_FILE, 'utf-8') : '';
      case 'memory': {
        const memoryFile = path.join(VAULT_DIR, '00-System', 'MEMORY.md');
        return existsSync(memoryFile) ? readFileSync(memoryFile, 'utf-8') : '';
      }
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
      createdAt: new Date().toISOString(),
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

    // Route source changes through the safe pipeline
    if (pending.area === 'source') {
      const { safeSourceEdit } = await import('./safe-restart.js');
      const result = await safeSourceEdit(PKG_DIR, [
        { relativePath: `src/${pending.target}`, content: pending.proposedChange },
      ], { experimentId, reason: `self-improve: ${pending.hypothesis.slice(0, 60)}`, description: pending.hypothesis });

      if (!result.success) {
        return `Source edit failed: ${result.error}${result.preflightErrors ? '\n' + result.preflightErrors.join('\n') : ''}`;
      }

      // Update experiment log — mark as approved
      this.updateExperimentStatus(experimentId, 'approved');
      try { unlinkSync(pendingFile); } catch { /* ignore */ }
      const state = this.loadState();
      state.pendingApprovals = Math.max(0, state.pendingApprovals - 1);
      this.saveState(state);
      // Schedule impact measurement for 24h later
      try {
        appendFileSync(IMPACT_CHECKS_FILE, JSON.stringify({
          experimentId,
          area: pending.area,
          target: pending.target,
          appliedAt: new Date().toISOString(),
          checkAfterMs: 24 * 60 * 60 * 1000,
        }) + '\n');
      } catch (err) {
        logger.warn({ err }, 'Failed to schedule impact check');
      }
      return `Applied source change to ${pending.target} — restart triggered.`;
    }

    // Final validation before writing
    const validation = this.validateProposal(pending.area, pending.target, pending.proposedChange);
    if (!validation.valid) {
      return `Cannot apply change — validation failed: ${validation.error}`;
    }

    // Write the change (non-source areas)
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

    // Schedule impact measurement for 24h later
    try {
      appendFileSync(IMPACT_CHECKS_FILE, JSON.stringify({
        experimentId,
        area: pending.area,
        target: pending.target,
        appliedAt: new Date().toISOString(),
        checkAfterMs: 24 * 60 * 60 * 1000,
      }) + '\n');
    } catch (err) {
      logger.warn({ err }, 'Failed to schedule impact check');
    }

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

  // ── Feedback synthesis ───────────────────────────────────────────

  private async synthesizeFeedbackPatterns(): Promise<void> {
    try {
      const { MemoryStore } = await import('../memory/store.js');
      const store = new MemoryStore(MEMORY_DB_PATH, VAULT_DIR);
      store.initialize();

      const recentFeedback = store.getRecentFeedback(50);
      store.close();

      if (recentFeedback.length < 3) {
        logger.info({ count: recentFeedback.length }, 'Not enough feedback to synthesize (need 3+)');
        return;
      }

      // Group by rating for the synthesis prompt
      const grouped: Record<string, typeof recentFeedback> = {};
      for (const f of recentFeedback) {
        (grouped[f.rating] ??= []).push(f);
      }

      const feedbackLines: string[] = [];
      for (const [rating, items] of Object.entries(grouped)) {
        feedbackLines.push(`### ${rating.toUpperCase()} (${items.length})`);
        for (const f of items.slice(0, 15)) {
          const snippet = f.messageSnippet ? ` | Message: "${f.messageSnippet.slice(0, 100)}"` : '';
          const resp = f.responseSnippet ? ` | Response: "${f.responseSnippet.slice(0, 100)}"` : '';
          const comment = f.comment ? ` | Comment: "${f.comment}"` : '';
          feedbackLines.push(`- ${f.channel}${snippet}${resp}${comment}`);
        }
      }

      const prompt =
        `Analyze this user feedback about an AI assistant's communication and distill 3-8 concise ` +
        `communication preference bullets. Focus on HOW the user wants to be communicated with — ` +
        `tone, format, length, proactivity, what to avoid.\n\n` +
        `## Feedback Data (${recentFeedback.length} entries)\n${feedbackLines.join('\n')}\n\n` +
        `Output ONLY a YAML-style bulleted list (each line starts with "- "). No preamble, no explanation.\n` +
        `Example format:\n- Prefers concise answers unless elaboration is requested\n- Appreciates proactive blocker identification`;

      const result = await this.assistant.runPlanStep('si-feedback-synthesis', prompt, {
        tier: 2,
        maxTurns: 1,
        disableTools: true,
      });

      // Extract bullet lines from response
      const bullets = result
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('- '));

      if (bullets.length === 0) {
        logger.warn('Feedback synthesis returned no bullets');
        return;
      }

      const patternsSummary = bullets.join('\n');
      const feedbackDir = path.join(VAULT_DIR, '00-System');
      if (!existsSync(feedbackDir)) mkdirSync(feedbackDir, { recursive: true });

      const feedbackFile = path.join(feedbackDir, 'FEEDBACK.md');
      const content = matter.stringify('', {
        patterns_summary: patternsSummary,
        last_synthesized: new Date().toISOString(),
        feedback_count: recentFeedback.length,
      });
      writeFileSync(feedbackFile, content);

      logger.info({ bullets: bullets.length, feedbackCount: recentFeedback.length }, 'Feedback patterns synthesized to FEEDBACK.md');
    } catch (err) {
      logger.error({ err }, 'Feedback synthesis failed');
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

  /** Reconcile pendingApprovals counter with actual pending-changes/ directory. */
  reconcileState(): SelfImproveState {
    const state = this.loadState();
    const actualPending = this.getPendingChanges().length;
    if (state.pendingApprovals !== actualPending) {
      logger.warn(
        { stored: state.pendingApprovals, actual: actualPending },
        'Pending approvals counter drift — reconciling',
      );
      state.pendingApprovals = actualPending;
      this.saveState(state);
    }
    return state;
  }

  /** Expire pending proposals older than APPROVAL_TTL_MS. */
  expireStaleProposals(): number {
    const pending = this.getPendingChanges();
    let expired = 0;
    const now = Date.now();
    for (const p of pending) {
      const createdAt = (p as any).createdAt
        ? new Date((p as any).createdAt).getTime()
        : new Date(p.finishedAt).getTime();
      if (now - createdAt > APPROVAL_TTL_MS) {
        this.updateExperimentStatus(p.id, 'expired');
        try { unlinkSync(path.join(PENDING_DIR, `${p.id}.json`)); } catch { /* ignore */ }
        expired++;
        logger.info({ id: p.id, area: p.area, target: p.target }, 'Expired stale proposal');
      }
    }
    if (expired > 0) {
      const state = this.loadState();
      state.pendingApprovals = Math.max(0, state.pendingApprovals - expired);
      this.saveState(state);
    }
    return expired;
  }

  /** Check impact of previously applied changes. Runs at start of each self-improve cycle. */
  private async checkAppliedImpact(): Promise<void> {
    if (!existsSync(IMPACT_CHECKS_FILE)) return;
    try {
      const lines = readFileSync(IMPACT_CHECKS_FILE, 'utf-8').trim().split('\n').filter(Boolean);
      const remaining: string[] = [];
      const now = Date.now();

      for (const line of lines) {
        try {
          const check = JSON.parse(line);
          const appliedAt = new Date(check.appliedAt).getTime();
          if (now - appliedAt < check.checkAfterMs) {
            remaining.push(line);
            continue;
          }

          // Measure current state for this area
          const metrics = await this.gatherMetrics();
          const impact = {
            type: 'impact',
            experimentId: check.experimentId,
            area: check.area,
            target: check.target,
            measuredAt: new Date().toISOString(),
            cronSuccessRate: metrics.cronSuccessRate,
            feedbackPositiveRatio: metrics.feedbackStats.total > 0
              ? metrics.feedbackStats.positive / metrics.feedbackStats.total : 1,
          };
          appendFileSync(EXPERIMENT_LOG, JSON.stringify(impact) + '\n');
          logger.info({ ...impact }, 'Impact measurement recorded');
        } catch {
          remaining.push(line);
        }
      }

      writeFileSync(IMPACT_CHECKS_FILE, remaining.length > 0 ? remaining.join('\n') + '\n' : '');
    } catch (err) {
      logger.warn({ err }, 'Impact check failed');
    }
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

  /** Analyze experiment history for success patterns and failed approaches. */
  private analyzeExperimentPatterns(history: SelfImproveExperiment[]): string {
    if (history.length < 3) return '';

    const byArea = new Map<string, { total: number; accepted: number; scoreSum: number }>();
    for (const e of history) {
      if ((e as any).type === 'impact') continue; // skip impact records
      const entry = byArea.get(e.area) ?? { total: 0, accepted: 0, scoreSum: 0 };
      entry.total++;
      if (e.accepted) entry.accepted++;
      entry.scoreSum += e.score;
      byArea.set(e.area, entry);
    }

    const lines: string[] = ['## Experiment Pattern Analysis'];
    for (const [area, stats] of byArea) {
      const avg = (stats.scoreSum / stats.total * 10).toFixed(1);
      const rate = ((stats.accepted / stats.total) * 100).toFixed(0);
      lines.push(`- ${area}: ${stats.total} experiments, ${rate}% acceptance, avg ${avg}/10`);
    }

    // Read impact records from experiment log
    try {
      if (existsSync(EXPERIMENT_LOG)) {
        const allLines = readFileSync(EXPERIMENT_LOG, 'utf-8').trim().split('\n').filter(Boolean);
        const impacts = allLines
          .map(l => { try { return JSON.parse(l); } catch { return null; } })
          .filter((r): r is any => r?.type === 'impact')
          .slice(-5);
        if (impacts.length > 0) {
          lines.push('\n### Measured Impact of Past Applied Changes');
          for (const ir of impacts) {
            lines.push(`- ${ir.area}/${ir.target}: cron ${(ir.cronSuccessRate * 100).toFixed(0)}%, feedback ${(ir.feedbackPositiveRatio * 100).toFixed(0)}% positive (measured ${ir.measuredAt})`);
          }
        }
      }
    } catch { /* non-fatal */ }

    // Identify consistently failed approaches
    const failedHypotheses = history
      .filter(e => !e.accepted && e.score < 0.3 && !(e as any).type)
      .map(e => e.hypothesis.slice(0, 80));
    if (failedHypotheses.length > 0) {
      lines.push('\n### Approaches That Scored Poorly (avoid these)');
      for (const h of [...new Set(failedHypotheses)].slice(0, 5)) {
        lines.push(`- "${h}"`);
      }
    }

    return lines.join('\n');
  }

  /** Validate that a proposed change has valid syntax for its target area. */
  private validateProposal(area: string, target: string, proposedChange: string): { valid: boolean; error?: string } {
    return validateProposal(area, target, proposedChange);
  }

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
      case 'agent': {
        return path.join(AGENTS_DIR, target, 'agent.md');
      }
      case 'source': {
        return path.join(PKG_DIR, 'src', target);
      }
      case 'communication':
        return AGENTS_FILE;
      case 'memory':
        return path.join(VAULT_DIR, '00-System', 'MEMORY.md');
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

/** Validate that a proposed change has valid syntax for its target area. */
export function validateProposal(area: string, _target: string, proposedChange: string): { valid: boolean; error?: string } {
  if (!proposedChange.trim()) {
    return { valid: false, error: 'Proposed change is empty' };
  }
  if (['soul', 'cron', 'workflow', 'agent', 'communication'].includes(area)) {
    try {
      matter(proposedChange);
    } catch (err) {
      return { valid: false, error: `YAML frontmatter parse error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  if (area === 'cron') {
    try {
      const parsed = matter(proposedChange);
      if (parsed.data?.jobs && !Array.isArray(parsed.data.jobs)) {
        return { valid: false, error: 'CRON.md jobs field must be an array' };
      }
      if (Array.isArray(parsed.data?.jobs)) {
        for (const job of parsed.data.jobs) {
          if (!job.name || !job.schedule || !job.prompt) {
            return { valid: false, error: `Cron job missing required fields (name/schedule/prompt): ${JSON.stringify(job).slice(0, 100)}` };
          }
        }
      }
    } catch (err) {
      return { valid: false, error: `CRON.md validation failed: ${err}` };
    }
  }
  return { valid: true };
}

function ensureDirs(): void {
  for (const dir of [SELF_IMPROVE_DIR, PENDING_DIR]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}
