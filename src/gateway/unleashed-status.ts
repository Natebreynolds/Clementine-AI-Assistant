const UNLEASHED_STATUS_STALE_GRACE_MS = 15 * 60 * 1000;
const ACTIVE_UNLEASHED_STATES = new Set(['pending', 'running', 'active']);

export type UnleashedRuntimeState = 'active' | 'stale' | 'terminal';

export function classifyUnleashedRuntimeState(status: Record<string, unknown>, nowMs = Date.now()): UnleashedRuntimeState {
  const state = String(status.status ?? 'running');
  if (!ACTIVE_UNLEASHED_STATES.has(state)) return 'terminal';

  const maxHoursRaw = Number(status.maxHours);
  const maxHours = Number.isFinite(maxHoursRaw) && maxHoursRaw > 0 ? maxHoursRaw : null;
  const startedMs = typeof status.startedAt === 'string' ? Date.parse(status.startedAt) : NaN;
  if (maxHours !== null && Number.isFinite(startedMs)) {
    const deadlineMs = startedMs + maxHours * 60 * 60 * 1000 + UNLEASHED_STATUS_STALE_GRACE_MS;
    if (nowMs > deadlineMs) return 'stale';
  }

  const updatedMs = typeof status.updatedAt === 'string' ? Date.parse(status.updatedAt) : NaN;
  if (maxHours === null && Number.isFinite(updatedMs)) {
    const staleMs = 24 * 60 * 60 * 1000;
    if (nowMs - updatedMs > staleMs) return 'stale';
  }

  return 'active';
}

export function isLiveUnleashedStatus(status: Record<string, unknown>, nowMs = Date.now()): boolean {
  return classifyUnleashedRuntimeState(status, nowMs) === 'active';
}

export function annotateUnleashedStatus(
  status: Record<string, unknown>,
  runtimeName?: string,
  nowMs = Date.now(),
): Record<string, unknown> & {
  name: string;
  runtimeName: string;
  live: boolean;
  stale: boolean;
  runtimeState: UnleashedRuntimeState;
  effectiveStatus: string;
} {
  const runtimeState = classifyUnleashedRuntimeState(status, nowMs);
  const rawStatus = String(status.status ?? 'running');
  const name = String(status.name || runtimeName || status.jobName || '');
  return {
    ...status,
    name,
    runtimeName: String(runtimeName || name),
    live: runtimeState === 'active',
    stale: runtimeState === 'stale',
    runtimeState,
    effectiveStatus: runtimeState === 'stale' ? 'stale' : rawStatus,
  };
}
