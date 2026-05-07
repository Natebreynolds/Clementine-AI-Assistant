import type { BuilderWorkflowSummary } from '../types.js';

export interface BuildUsageTask {
  taskKey: string;
  label?: string;
  kind?: string;
  targetTab?: string;
  controllable?: boolean;
  agentSlug?: string | null;
  totalInput?: number;
  totalOutput?: number;
  totalTokens?: number;
  costCents?: number;
  queries?: number;
  lastAt?: string;
}

export interface BuildUsageSummary {
  totalTokens?: number;
  totalInput?: number;
  totalOutput?: number;
  totalCostCents?: number;
  taskTotals?: {
    totalTokens?: number;
    totalInput?: number;
    totalOutput?: number;
    costCents?: number;
    queries?: number;
  };
}

export interface BrokenJobSummary {
  jobName: string;
  agentSlug?: string;
  errorCount48h: number;
  totalRuns48h: number;
  lastErrorAt: string | null;
  lastErrors: string[];
  circuitBreakerEngagedAt: string | null;
  lastAdvisorOpinion: string | null;
  diagnosis?: Record<string, unknown>;
}

export interface BuildOperationsInput {
  cronJobs: Array<Record<string, unknown>>;
  workflowSummaries: BuilderWorkflowSummary[];
  brokenJobs: BrokenJobSummary[];
  unleashedTasks: Array<Record<string, unknown>>;
  backgroundTasks: Array<Record<string, unknown>>;
  usageTasks?: BuildUsageTask[];
  usageSummary?: BuildUsageSummary;
  now?: number;
}

export interface UsageSnapshot {
  totalInput: number;
  totalOutput: number;
  totalTokens: number;
  costCents: number;
  queries: number;
  lastAt: string;
}

export interface BuildActionSet {
  toggle?: boolean;
  runNow?: boolean;
  edit?: boolean;
  delete?: boolean;
  viewTrace?: boolean;
  applyFix?: boolean;
  dismissDiagnosis?: boolean;
  cancel?: boolean;
  cleanup?: boolean;
  open?: boolean;
}

export interface ScheduledTaskCard {
  type: 'scheduled_task';
  id: string;
  name: string;
  displayName: string;
  owner: string;
  ownerLabel: string;
  schedule: string;
  enabled: boolean;
  prompt: string;
  mode?: string;
  after?: string;
  maxRetries?: number;
  lastRun?: Record<string, unknown> | null;
  health: 'healthy' | 'never_run' | 'running' | 'failed' | 'broken' | 'disabled';
  healthLabel: string;
  broken?: BrokenJobSummary;
  usage?: UsageSnapshot;
  actions: BuildActionSet;
  definition: Record<string, unknown>;
  // ── Trick capabilities (surfaced for the capability-first card) ─
  /** Pinned skill slugs from the trick definition (raw — not resolved). */
  skills?: string[];
  /** Per-trick tool whitelist (raw — not yet intersected with the agent profile). */
  allowedTools?: string[];
  /** Per-trick MCP server whitelist. */
  allowedMcpServers?: string[];
  /** Free-form tags for grouping/filtering. */
  tags?: string[];
  /** Optional category bucket. */
  category?: string;
  /** Predictable (contract) mode — true means runner skips MEMORY.md /
   *  team comms / auto-matched skills. The visibility-on-card flag for
   *  "this trick will run with only what you see here." */
  predictable?: boolean;
}

export interface ScheduledWorkflowCard {
  type: 'scheduled_workflow';
  id: string;
  name: string;
  displayName: string;
  owner: string;
  ownerLabel: string;
  schedule: string;
  enabled: boolean;
  description: string;
  stepCount: number;
  sourceFile?: string;
  usage?: UsageSnapshot;
  limitations: string[];
  actions: BuildActionSet;
  definition: BuilderWorkflowSummary;
}

export interface AttentionItem {
  id: string;
  type: 'broken_scheduled_task' | 'orphaned_broken_job' | 'failed_runtime';
  source: 'scheduled_task' | 'runtime';
  title: string;
  owner: string;
  ownerLabel: string;
  severity: 'warning' | 'critical';
  status: string;
  lastAt: string | null;
  reason: string;
  detail?: string;
  brokenJob?: BrokenJobSummary;
  runtime?: Record<string, unknown>;
  usage?: UsageSnapshot;
  actions: BuildActionSet;
}

export interface RunningItem {
  id: string;
  type: 'background' | 'unleashed';
  title: string;
  owner: string;
  ownerLabel: string;
  status: string;
  startedAt?: string;
  updatedAt?: string;
  maxMinutes?: number;
  maxHours?: number;
  promptPreview?: string;
  usage?: UsageSnapshot;
  actions: BuildActionSet;
  runtime: Record<string, unknown>;
}

export interface BuildOperationsSnapshot {
  summary: {
    scheduledTasks: number;
    scheduledWorkflows: number;
    enabledScheduledTasks: number;
    enabledScheduledWorkflows: number;
    needsAttention: number;
    brokenScheduledTasks: number;
    failedRuntime: number;
    runningNow: number;
    totalTokens: number;
    automationTokens: number;
    costCents: number;
  };
  scheduledTasks: ScheduledTaskCard[];
  scheduledWorkflows: ScheduledWorkflowCard[];
  needsAttention: AttentionItem[];
  runningNow: RunningItem[];
  usageTasks: BuildUsageTask[];
}

const GLOBAL_OWNER = '';

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value == null ? fallback : String(value);
}

function asNumber(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map(v => typeof v === 'string' ? v.trim() : '')
    .filter(Boolean);
  return out.length > 0 ? out : undefined;
}

function ownerLabel(owner: string): string {
  if (!owner) return 'Clementine';
  return owner.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function ownerFromName(name: string): string {
  const idx = name.indexOf(':');
  return idx > 0 ? name.slice(0, idx) : GLOBAL_OWNER;
}

function bareName(name: string, owner: string): string {
  const prefix = owner ? `${owner}:` : '';
  return prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function taskKeyVariants(name: string, owner: string): string[] {
  const bare = bareName(name, owner);
  const variants = new Set<string>([name, bare]);
  if (owner) variants.add(`${owner}:${bare}`);
  return [...variants].filter(Boolean);
}

function usageKey(taskKey: string, owner: string): string {
  return `${owner || ''}:${taskKey}`;
}

function buildUsageMap(tasks: BuildUsageTask[] = []): Map<string, UsageSnapshot> {
  const map = new Map<string, UsageSnapshot>();
  for (const task of tasks) {
    const rawKey = task.taskKey || task.label;
    if (!rawKey) continue;
    const owner = task.agentSlug || '';
    const keys = new Set([usageKey(rawKey, owner), rawKey]);
    for (const key of keys) {
      const existing = map.get(key) ?? {
        totalInput: 0,
        totalOutput: 0,
        totalTokens: 0,
        costCents: 0,
        queries: 0,
        lastAt: '',
      };
      existing.totalInput += task.totalInput || 0;
      existing.totalOutput += task.totalOutput || 0;
      existing.totalTokens += task.totalTokens || 0;
      existing.costCents += task.costCents || 0;
      existing.queries += task.queries || 0;
      if ((task.lastAt || '') > existing.lastAt) existing.lastAt = task.lastAt || '';
      map.set(key, existing);
    }
  }
  return map;
}

function findUsage(usage: Map<string, UsageSnapshot>, names: string[], owner: string): UsageSnapshot | undefined {
  for (const name of names) {
    const scoped = usage.get(usageKey(name, owner));
    if (scoped?.totalTokens) return scoped;
    const direct = usage.get(name);
    if (direct?.totalTokens) return direct;
  }
  return undefined;
}

function brokenKey(jobName: string, owner?: string): string {
  if (owner && !jobName.startsWith(`${owner}:`)) return `${owner}:${jobName}`;
  return jobName;
}

function buildBrokenMap(jobs: BrokenJobSummary[]): Map<string, BrokenJobSummary> {
  const map = new Map<string, BrokenJobSummary>();
  for (const job of jobs) {
    const owner = job.agentSlug || ownerFromName(job.jobName);
    const keys = taskKeyVariants(job.jobName, owner);
    keys.push(brokenKey(job.jobName, owner));
    for (const key of keys) map.set(key, job);
  }
  return map;
}

function classifyBrokenReason(job: BrokenJobSummary): string {
  const text = [
    job.lastErrors?.join('\n') || '',
    asString(job.diagnosis?.rootCause),
    asString((job.diagnosis?.proposedFix as Record<string, unknown> | undefined)?.details),
  ].join('\n').toLowerCase();
  if (/\b(monthly usage limit|usage limit|credit|quota|rate limit|overloaded)\b/.test(text)) return 'usage or provider limit';
  if (/\b(auth|unauthorized|permission|api key|login)\b/.test(text)) return 'authentication or permission';
  if (/\b(context|token|too large|prompt too large|maximum context)\b/.test(text)) return 'context or prompt size';
  if (job.circuitBreakerEngagedAt) return 'circuit breaker engaged';
  return 'repeated execution failure';
}

function latestRun(job: Record<string, unknown>): Record<string, unknown> | null {
  const runs = Array.isArray(job.recentRuns) ? job.recentRuns : [];
  return (runs[0] as Record<string, unknown> | undefined) ?? null;
}

function healthForTask(job: Record<string, unknown>, broken?: BrokenJobSummary): ScheduledTaskCard['health'] {
  if (job.enabled === false) return 'disabled';
  if (broken) return 'broken';
  const run = latestRun(job);
  if (!run) return 'never_run';
  if (run.startedAt && !run.finishedAt) return 'running';
  const status = asString(run.status);
  if (status === 'error' || status === 'failed' || status === 'timeout') return 'failed';
  return 'healthy';
}

function healthLabel(health: ScheduledTaskCard['health']): string {
  switch (health) {
    case 'disabled': return 'Disabled';
    case 'broken': return 'Needs attention';
    case 'failed': return 'Last run failed';
    case 'running': return 'Running';
    case 'never_run': return 'Never run';
    case 'healthy': return 'Healthy';
  }
}

function runtimeOwner(task: Record<string, unknown>): string {
  const direct = asString(task.agentSlug || task.fromAgent);
  if (direct && direct !== 'clementine') return direct;
  return ownerFromName(asString(task.jobName || task.name || ''));
}

function runtimeUpdatedAt(task: Record<string, unknown>): string | undefined {
  return asString(task.updatedAt || task.completedAt || task.finishedAt || task.startedAt || task.createdAt) || undefined;
}

function isActiveUnleashed(task: Record<string, unknown>): boolean {
  const jobName = asString(task.jobName);
  if (jobName.startsWith('bg:')) return false;
  return task.live === true || task.runtimeState === 'active';
}

function isAttentionUnleashed(task: Record<string, unknown>): boolean {
  const jobName = asString(task.jobName);
  if (jobName.startsWith('bg:')) return false;
  const status = asString(task.status);
  return task.stale === true || task.runtimeState === 'stale' || status === 'error' || status === 'failed' || status === 'timeout';
}

function isActiveBackground(task: Record<string, unknown>): boolean {
  const status = asString(task.status);
  return status === 'pending' || status === 'running';
}

function isAttentionBackground(task: Record<string, unknown>): boolean {
  const status = asString(task.status);
  return status === 'failed' || status === 'aborted';
}

export function buildOperationsSnapshot(input: BuildOperationsInput): BuildOperationsSnapshot {
  const usageMap = buildUsageMap(input.usageTasks || []);
  const brokenMap = buildBrokenMap(input.brokenJobs || []);
  const matchedBroken = new Set<BrokenJobSummary>();

  const scheduledTasks = input.cronJobs.map((job): ScheduledTaskCard => {
    const name = asString(job.name);
    const owner = asString(job.agent) || ownerFromName(name);
    const keys = taskKeyVariants(name, owner);
    const broken = keys.map(key => brokenMap.get(key)).find(Boolean);
    if (broken) matchedBroken.add(broken);
    const health = healthForTask(job, broken);
    return {
      type: 'scheduled_task',
      id: name,
      name,
      displayName: bareName(name, owner),
      owner,
      ownerLabel: ownerLabel(owner),
      schedule: asString(job.schedule),
      enabled: job.enabled !== false,
      prompt: asString(job.prompt),
      mode: asString(job.mode) || undefined,
      after: asString(job.after) || undefined,
      maxRetries: asNumber(job.max_retries ?? job.maxRetries),
      lastRun: latestRun(job),
      health,
      healthLabel: healthLabel(health),
      broken,
      usage: findUsage(usageMap, keys, owner),
      actions: {
        toggle: true,
        runNow: true,
        edit: true,
        delete: true,
        viewTrace: true,
        applyFix: !!(broken?.diagnosis?.proposedFix as Record<string, unknown> | undefined)?.autoApply
          && broken?.diagnosis?.riskLevel === 'low',
        dismissDiagnosis: !!broken?.diagnosis,
      },
      definition: job,
      // ── Trick capabilities — read snake_case (YAML source) and camelCase (API source) ─
      skills: asStringArray(job.skills),
      allowedTools: asStringArray(job.allowed_tools ?? job.allowedTools),
      allowedMcpServers: asStringArray(job.allowed_mcp_servers ?? job.allowedMcpServers),
      tags: asStringArray(job.tags),
      category: typeof job.category === 'string' && job.category.trim() ? job.category.trim() : undefined,
      predictable: typeof job.predictable === 'boolean' ? job.predictable : undefined,
    };
  }).sort((a, b) => a.owner.localeCompare(b.owner) || a.displayName.localeCompare(b.displayName));

  const scheduledWorkflows = input.workflowSummaries
    .filter(w => w.origin === 'workflow' && !!w.schedule)
    .map((wf): ScheduledWorkflowCard => {
      const owner = wf.agentSlug || '';
      const keys = taskKeyVariants(wf.name, owner);
      return {
        type: 'scheduled_workflow',
        id: wf.id,
        name: wf.name,
        displayName: bareName(wf.name, owner),
        owner,
        ownerLabel: ownerLabel(owner),
        schedule: wf.schedule || '',
        enabled: wf.enabled !== false,
        description: wf.description || '',
        stepCount: wf.stepCount || 0,
        sourceFile: wf.sourceFile,
        usage: findUsage(usageMap, keys, owner),
        limitations: ['Canvas mock tests stub prompt steps; Run Now uses the real workflow engine with approval for side effects.'],
        actions: { toggle: true, runNow: true, open: true, delete: true },
        definition: wf,
      };
    })
    .sort((a, b) => a.owner.localeCompare(b.owner) || a.displayName.localeCompare(b.displayName));

  const needsAttention: AttentionItem[] = [];
  for (const task of scheduledTasks) {
    if (!task.broken) continue;
    needsAttention.push({
      id: `broken:${task.name}`,
      type: 'broken_scheduled_task',
      source: 'scheduled_task',
      title: task.displayName,
      owner: task.owner,
      ownerLabel: task.ownerLabel,
      severity: task.broken.circuitBreakerEngagedAt ? 'critical' : 'warning',
      status: classifyBrokenReason(task.broken),
      lastAt: task.broken.lastErrorAt,
      reason: classifyBrokenReason(task.broken),
      detail: task.broken.lastErrors?.[0],
      brokenJob: task.broken,
      usage: task.usage,
      actions: task.actions,
    });
  }

  for (const broken of input.brokenJobs || []) {
    if (matchedBroken.has(broken)) continue;
    const owner = broken.agentSlug || ownerFromName(broken.jobName);
    needsAttention.push({
      id: `orphaned-broken:${broken.jobName}`,
      type: 'orphaned_broken_job',
      source: 'scheduled_task',
      title: bareName(broken.jobName, owner),
      owner,
      ownerLabel: ownerLabel(owner),
      severity: broken.circuitBreakerEngagedAt ? 'critical' : 'warning',
      status: 'orphaned failure history',
      lastAt: broken.lastErrorAt,
      reason: classifyBrokenReason(broken),
      detail: broken.lastErrors?.[0],
      brokenJob: broken,
      usage: findUsage(usageMap, taskKeyVariants(broken.jobName, owner), owner),
      actions: {
        viewTrace: true,
        applyFix: !!(broken.diagnosis?.proposedFix as Record<string, unknown> | undefined)?.autoApply
          && broken.diagnosis?.riskLevel === 'low',
        dismissDiagnosis: !!broken.diagnosis,
      },
    });
  }

  const runningNow: RunningItem[] = [];
  for (const task of input.backgroundTasks || []) {
    if (!isActiveBackground(task)) continue;
    const id = asString(task.id);
    const owner = runtimeOwner(task);
    runningNow.push({
      id: `background:${id}`,
      type: 'background',
      title: `Deep task ${id}`,
      owner,
      ownerLabel: ownerLabel(owner),
      status: asString(task.status, 'running'),
      startedAt: asString(task.startedAt || task.createdAt) || undefined,
      updatedAt: runtimeUpdatedAt(task),
      maxMinutes: asNumber(task.maxMinutes),
      promptPreview: asString(task.prompt).slice(0, 240),
      usage: findUsage(usageMap, [`bg:${id}`, id], owner),
      actions: { cancel: true },
      runtime: task,
    });
  }

  for (const task of input.unleashedTasks || []) {
    if (!isActiveUnleashed(task)) continue;
    const runtimeName = asString(task.runtimeName || task.name || task.jobName);
    const jobName = asString(task.jobName || runtimeName);
    const owner = runtimeOwner(task);
    runningNow.push({
      id: `unleashed:${runtimeName}`,
      type: 'unleashed',
      title: jobName || 'Unleashed task',
      owner,
      ownerLabel: ownerLabel(owner),
      status: asString(task.effectiveStatus || task.status, 'running'),
      startedAt: asString(task.startedAt) || undefined,
      updatedAt: runtimeUpdatedAt(task),
      maxHours: asNumber(task.maxHours),
      promptPreview: asString(task.lastPhaseOutputPreview || task.error).slice(0, 240),
      usage: findUsage(usageMap, taskKeyVariants(jobName, owner), owner),
      actions: { cancel: true },
      runtime: task,
    });
  }

  for (const task of input.backgroundTasks || []) {
    if (!isAttentionBackground(task)) continue;
    const id = asString(task.id);
    const owner = runtimeOwner(task);
    needsAttention.push({
      id: `background-failed:${id}`,
      type: 'failed_runtime',
      source: 'runtime',
      title: `Deep task ${id}`,
      owner,
      ownerLabel: ownerLabel(owner),
      severity: 'warning',
      status: asString(task.status, 'failed'),
      lastAt: runtimeUpdatedAt(task) || null,
      reason: 'background task stopped before completing',
      detail: asString(task.error || task.result).slice(0, 400),
      runtime: task,
      usage: findUsage(usageMap, [`bg:${id}`, id], owner),
      actions: { cleanup: true },
    });
  }

  for (const task of input.unleashedTasks || []) {
    if (!isAttentionUnleashed(task)) continue;
    const runtimeName = asString(task.runtimeName || task.name || task.jobName);
    const jobName = asString(task.jobName || runtimeName);
    const owner = runtimeOwner(task);
    needsAttention.push({
      id: `unleashed-failed:${runtimeName}`,
      type: 'failed_runtime',
      source: 'runtime',
      title: jobName || 'Unleashed task',
      owner,
      ownerLabel: ownerLabel(owner),
      severity: task.stale === true || task.runtimeState === 'stale' ? 'warning' : 'critical',
      status: asString(task.effectiveStatus || task.status, 'failed'),
      lastAt: runtimeUpdatedAt(task) || null,
      reason: task.stale === true || task.runtimeState === 'stale' ? 'runtime record is stale' : 'runtime failed',
      detail: asString(task.lastPhaseOutputPreview || task.error).slice(0, 400),
      runtime: task,
      usage: findUsage(usageMap, taskKeyVariants(jobName, owner), owner),
      actions: { cancel: true, cleanup: true },
    });
  }

  needsAttention.sort((a, b) => {
    const sev = (b.severity === 'critical' ? 1 : 0) - (a.severity === 'critical' ? 1 : 0);
    if (sev !== 0) return sev;
    return (b.lastAt || '').localeCompare(a.lastAt || '');
  });
  runningNow.sort((a, b) => (b.updatedAt || b.startedAt || '').localeCompare(a.updatedAt || a.startedAt || ''));

  const failedRuntime = needsAttention.filter(item => item.type === 'failed_runtime').length;
  const brokenScheduledTasks = needsAttention.filter(item => item.source === 'scheduled_task').length;

  return {
    summary: {
      scheduledTasks: scheduledTasks.length,
      scheduledWorkflows: scheduledWorkflows.length,
      enabledScheduledTasks: scheduledTasks.filter(t => t.enabled).length,
      enabledScheduledWorkflows: scheduledWorkflows.filter(w => w.enabled).length,
      needsAttention: needsAttention.length,
      brokenScheduledTasks,
      failedRuntime,
      runningNow: runningNow.length,
      totalTokens: input.usageSummary?.totalTokens || 0,
      automationTokens: input.usageSummary?.taskTotals?.totalTokens || 0,
      costCents: input.usageSummary?.totalCostCents || input.usageSummary?.taskTotals?.costCents || 0,
    },
    scheduledTasks,
    scheduledWorkflows,
    needsAttention,
    runningNow,
    usageTasks: input.usageTasks || [],
  };
}
