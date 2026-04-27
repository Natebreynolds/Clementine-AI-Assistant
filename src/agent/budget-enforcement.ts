/**
 * Per-agent monthly budget enforcement.
 *
 * AgentProfile.budgetMonthlyCents is set in agent.md frontmatter (0 or
 * undefined = unlimited). This module checks the current month's spend
 * against the cap before letting an autonomous activity (cron, heartbeat,
 * delegated team task) start.
 *
 * Enforcement is intentionally narrow:
 *   - User-initiated chat is NEVER blocked. The owner needs to be able to
 *     talk to a paused agent to lift the pause (raise the cap, reset the
 *     period, etc.).
 *   - Cron + heartbeat + delegation flows ARE blocked. Those are the
 *     paths that can run away with cost.
 *
 * Surfacing: when the breaker fires, we write a circuit-breaker advisor
 * event the same shape the MCP and cron breakers use. insight-engine
 * picks that up and surfaces it in the next signal pull, so the owner
 * sees "Budget breaker tripped for agent <slug>" in their next insight.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';

import { BASE_DIR } from '../config.js';
import type { AgentProfile } from '../types.js';
import type { MemoryStore } from '../memory/store.js';

const logger = pino({ name: 'clementine.budget-enforcement' });

const ADVISOR_EVENTS_FILE = path.join(BASE_DIR, 'cron', 'advisor-events.jsonl');

/** Track per-agent "we already notified about this month" so we don't spam. */
const notifiedThisMonth = new Map<string, string>();
function monthKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface BudgetCheckResult {
  allowed: boolean;
  spentCents: number;
  limitCents: number;
  /** Human-readable explanation when blocked. */
  message?: string;
}

/**
 * Decide whether a profile's autonomous activity may proceed for the
 * current calendar month. Returns allowed=true if no budget is set,
 * if the agent is global Clementine (no profile), or if spend < limit.
 *
 * Side effect: when the breaker fires for the first time this month for
 * a given agent, emits an advisor event so insight-engine surfaces it.
 */
export function checkAgentBudget(
  profile: AgentProfile | null | undefined,
  memoryStore: MemoryStore | null | undefined,
): BudgetCheckResult {
  // No profile (Clementine herself) — global budget is governed elsewhere.
  if (!profile) return { allowed: true, spentCents: 0, limitCents: 0 };
  const limit = profile.budgetMonthlyCents ?? 0;
  // Unlimited.
  if (!limit || limit <= 0) return { allowed: true, spentCents: 0, limitCents: 0 };
  if (!memoryStore) return { allowed: true, spentCents: 0, limitCents: limit };

  let spent = 0;
  try {
    spent = memoryStore.getMonthlyCostCents(profile.slug);
  } catch (err) {
    logger.debug({ err, slug: profile.slug }, 'Budget query failed — allowing through');
    return { allowed: true, spentCents: 0, limitCents: limit };
  }

  if (spent < limit) {
    return { allowed: true, spentCents: spent, limitCents: limit };
  }

  const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const msg =
    `Agent "${profile.slug}" has hit its monthly budget (${usd(spent)} of ${usd(limit)}). ` +
    `Autonomous activity (cron, heartbeat, delegation) is paused for this agent. ` +
    `Lift by raising budgetMonthlyCents in agent.md or by resetting at month end.`;

  // Emit the breaker event once per month per agent so insight-engine
  // surfaces it but we don't spam the owner with the same message every
  // single tick after the breaker trips.
  const stamp = `${profile.slug}|${monthKey()}`;
  if (notifiedThisMonth.get(profile.slug) !== monthKey()) {
    notifiedThisMonth.set(profile.slug, monthKey());
    emitAdvisorEvent({
      type: 'circuit-breaker',
      jobName: `budget:${profile.slug}`,
      detail: msg,
    });
    logger.warn({ slug: profile.slug, spent, limit }, 'Agent monthly budget tripped');
  } else {
    logger.debug({ stamp, spent, limit }, 'Agent budget still tripped (already notified this month)');
  }

  return { allowed: false, spentCents: spent, limitCents: limit, message: msg };
}

/** Test seam — clear the "already notified this month" memo. */
export function _resetNotifiedForTesting(): void {
  notifiedThisMonth.clear();
}

function emitAdvisorEvent(evt: Record<string, unknown>): void {
  try {
    mkdirSync(path.dirname(ADVISOR_EVENTS_FILE), { recursive: true });
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...evt }) + '\n';
    appendFileSync(ADVISOR_EVENTS_FILE, line);
  } catch (err) {
    logger.debug({ err }, 'Failed to emit budget advisor event');
  }
}
