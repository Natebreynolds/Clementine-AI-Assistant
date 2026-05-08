/**
 * Goal evaluation — PRD Phase 1.
 *
 * Two evaluators run at the END of a successful cron run, when the Task
 * defines `successSchema` (JSON Schema validated against the agent's output)
 * and/or `successCriteriaText` (free-text criterion graded by an evaluator
 * sub-agent). The verdicts merge into a single `goalCheck` object that
 * gets stamped on the run's CronRunEntry.
 *
 * Design constraints:
 * - Never block run completion. Any thrown error becomes status='error' on
 *   goalCheck and the rest of the run logs unchanged.
 * - Bounded budgets — schema validation is sub-millisecond; evaluator agent
 *   gets max_turns=1, ~30s wall clock, Haiku-class model.
 * - No new top-level deps — ajv is a transitive install; we import it lazily
 *   inside the function so test fixtures that don't need it never load it.
 */

import type { CronJobDefinition, CronRunEntry } from '../types.js';

type SchemaResult = { pass: boolean; errors: string[]; tried: boolean };
type EvaluatorResult = { pass: boolean; reason: string };

/**
 * Try to extract a JSON object from the agent's response. Looks first at the
 * whole text, then at fenced ```json blocks (the common Claude output shape),
 * then at any {...} substring as a last resort.
 */
function extractJson(responseText: string): unknown | null {
  if (!responseText || typeof responseText !== 'string') return null;
  // Whole-text parse first.
  try {
    return JSON.parse(responseText);
  } catch { /* fall through */ }
  // Fenced ```json ... ``` block.
  const fenced = responseText.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fenced && fenced[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch { /* fall through */ }
  }
  // First {...} substring (greedy through last brace).
  const first = responseText.indexOf('{');
  const last = responseText.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(responseText.slice(first, last + 1));
    } catch { /* fall through */ }
  }
  return null;
}

/**
 * Validate the agent's response against a JSON Schema. Returns:
 *  - tried=false if no JSON could be extracted from the response
 *  - tried=true with pass + errors otherwise
 * Schema-compile errors throw — caller catches.
 */
export async function validateAgainstSchema(
  responseText: string,
  schema: Record<string, unknown>,
): Promise<SchemaResult> {
  const candidate = extractJson(responseText);
  if (candidate === null) {
    return { tried: false, pass: false, errors: ['No JSON object found in agent response'] };
  }
  // Lazy import so this module costs nothing when no Task has a schema.
  const ajvMod = await import('ajv').catch(() => null);
  if (!ajvMod) {
    throw new Error('ajv not available — cannot validate success_schema');
  }
  // Handle CJS default-export interop (ajv@8 ships as CJS; the ESM bridge
  // sometimes lands the constructor on .default and sometimes at the top
  // level).
  const AjvCtor: unknown = (ajvMod as { default?: unknown }).default ?? ajvMod;
  type AjvErr = { instancePath?: string; message?: string };
  type ValidateFn = ((d: unknown) => boolean) & { errors?: AjvErr[] | null };
  type AjvInstance = { compile: (s: unknown) => ValidateFn; errors?: AjvErr[] | null };
  const ajv = new (AjvCtor as new (opts?: unknown) => AjvInstance)({ allErrors: true, strict: false });
  const validator = ajv.compile(schema);
  const ok = validator(candidate);
  if (ok) return { tried: true, pass: true, errors: [] };
  // ajv stamps errors on the compiled validator; the instance fallback covers
  // older versions that put them on the ajv instance instead.
  const rawErrors: AjvErr[] = validator.errors ?? ajv.errors ?? [];
  const errs = rawErrors.slice(0, 5).map((e) => {
    const path = e.instancePath || '';
    const msg = e.message || 'invalid';
    return path ? `${path} ${msg}` : msg;
  });
  return { tried: true, pass: false, errors: errs.length ? errs : ['validation failed'] };
}

/**
 * Ask a small evaluator sub-agent whether the run accomplished the
 * `successCriteriaText` criterion. Returns null if the evaluator failed
 * to produce a parseable verdict (caller treats null as goalCheck.status='error').
 *
 * The evaluator is intentionally minimal — Haiku, max_turns=1, focused
 * system prompt, ~30s budget. We're grading text, not running tools.
 */
export async function evaluateAgainstCriterion(
  responseText: string,
  criterion: string,
  opts: { model?: string; timeoutMs?: number } = {},
): Promise<EvaluatorResult | null> {
  const trimmedResponse = (responseText || '').slice(0, 8000);
  const trimmedCriterion = (criterion || '').slice(0, 2000);
  if (!trimmedCriterion) return null;

  const sdk = await import('@anthropic-ai/claude-agent-sdk').catch(() => null);
  if (!sdk || typeof (sdk as unknown as { query?: unknown }).query !== 'function') {
    return null;
  }

  const systemPrompt =
    'You are a strict evaluator. Grade whether a scheduled task accomplished its stated goal.\n' +
    'Reply with EXACTLY one line in this format:\n' +
    'PASS — <one-sentence reason> | FAIL — <one-sentence reason>\n' +
    'Be honest. If the run did not achieve the goal, say FAIL even if the agent claimed success.';

  const userPrompt =
    `GOAL:\n${trimmedCriterion}\n\nRUN OUTPUT:\n${trimmedResponse}\n\nVerdict:`;

  const timeoutMs = opts.timeoutMs ?? 30_000;
  const model = opts.model ?? 'claude-haiku-4-5-20251001';

  // Race the SDK query against a hard timeout so a hung evaluator never
  // blocks run logging.
  const queryPromise = (async () => {
    let collected = '';
    try {
      const queryFn = (sdk as unknown as { query: (input: { prompt: string; options?: unknown }) => AsyncIterable<unknown> }).query;
      const iter = queryFn({
        prompt: userPrompt,
        options: {
          systemPrompt,
          model,
          maxTurns: 1,
          permissionMode: 'default',
          allowedTools: [],
          settingSources: [],
          // No tools, no network beyond model — purely text-in / text-out.
        },
      });
      for await (const message of iter) {
        const m = message as { type?: string; content?: unknown[]; result?: string };
        if (m.type === 'assistant' && Array.isArray(m.content)) {
          for (const block of m.content) {
            const b = block as { type?: string; text?: string };
            if (b.type === 'text' && typeof b.text === 'string') collected += b.text;
          }
        } else if (m.type === 'result' && typeof m.result === 'string') {
          collected += m.result;
        }
      }
    } catch {
      return null;
    }
    return collected;
  })();

  const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
  const collected = await Promise.race([queryPromise, timeoutPromise]);
  if (!collected || typeof collected !== 'string') return null;

  // Parse the strict verdict line. Accept variants: "PASS — reason", "FAIL: reason",
  // "Verdict: PASS — reason", etc.
  const match = collected.match(/\b(PASS|FAIL)\b\s*[—\-:]?\s*(.+)/i);
  if (!match) return null;
  const verdict = match[1].toUpperCase() === 'PASS';
  const reason = (match[2] || '').replace(/[\r\n].*$/s, '').trim().slice(0, 280);
  return { pass: verdict, reason: reason || (verdict ? 'Pass' : 'Fail') };
}

/**
 * Orchestrator: runs whichever evaluators are configured on the Task and
 * merges their verdicts into a single goalCheck record. Returns undefined
 * when no goal is configured — the field then stays absent on the run entry.
 */
export async function runGoalCheck(
  responseText: string,
  job: CronJobDefinition,
): Promise<CronRunEntry['goalCheck']> {
  const hasSchema = !!(job.successSchema && Object.keys(job.successSchema).length > 0);
  const hasCriterion = !!(job.successCriteriaText && job.successCriteriaText.trim());
  if (!hasSchema && !hasCriterion) return undefined;

  let schemaResult: SchemaResult | null = null;
  let evaluatorResult: EvaluatorResult | null = null;
  let errored = false;
  let errorMessage = '';

  if (hasSchema) {
    try {
      schemaResult = await validateAgainstSchema(responseText, job.successSchema!);
    } catch (err) {
      errored = true;
      errorMessage = `schema validator threw: ${String(err).slice(0, 200)}`;
    }
  }

  if (hasCriterion) {
    try {
      evaluatorResult = await evaluateAgainstCriterion(responseText, job.successCriteriaText!);
      if (evaluatorResult === null && !errored) {
        // Treat unparseable evaluator output as 'error' rather than 'fail' — we
        // don't want a flaky evaluator to mark a healthy run as failed.
        errored = true;
        errorMessage = 'evaluator did not return a parseable PASS/FAIL verdict';
      }
    } catch (err) {
      errored = true;
      errorMessage = `evaluator threw: ${String(err).slice(0, 200)}`;
    }
  }

  // Decide overall status. Both passed = pass. Either failed = fail. Neither
  // ran cleanly but both were configured = error.
  const mode: 'schema' | 'evaluator' | 'both' = hasSchema && hasCriterion ? 'both' : hasSchema ? 'schema' : 'evaluator';
  let status: 'pass' | 'fail' | 'skipped' | 'error';
  if (errored && (!schemaResult || !evaluatorResult)) {
    status = 'error';
  } else {
    const schemaPassed = schemaResult?.pass !== false;        // true if not run, or true if run + passed
    const evaluatorPassed = evaluatorResult?.pass !== false;  // same
    const schemaFailed = schemaResult ? !schemaResult.pass || !schemaResult.tried : false;
    const evaluatorFailed = evaluatorResult ? !evaluatorResult.pass : false;
    if (schemaFailed || evaluatorFailed) status = 'fail';
    else if (schemaPassed && evaluatorPassed) status = 'pass';
    else status = 'error';
  }

  const out: NonNullable<CronRunEntry['goalCheck']> = { status, mode };
  if (schemaResult) {
    out.schemaPass = schemaResult.pass && schemaResult.tried;
    if (!schemaResult.pass || !schemaResult.tried) {
      out.schemaErrors = schemaResult.errors.slice(0, 5);
    }
  }
  if (evaluatorResult) {
    out.evaluatorPass = evaluatorResult.pass;
    out.evaluatorReason = evaluatorResult.reason;
  }
  if (errored && errorMessage) {
    // Stash the error in evaluatorReason if we don't already have one — the
    // dashboard surfaces this string in the tooltip.
    if (!out.evaluatorReason) out.evaluatorReason = errorMessage;
  }
  return out;
}
