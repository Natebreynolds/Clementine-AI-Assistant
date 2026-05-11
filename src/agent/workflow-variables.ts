/**
 * Clementine TypeScript — Workflow template variable resolution.
 *
 * Pure functions for resolving {{...}} placeholders in workflow step prompts.
 */

import { OWNER_NAME, ASSISTANT_NAME, currentTimeZone } from '../config.js';
import { dateKeyInTimeZone, formatTime24InTimeZone } from '../lib/time.js';

/**
 * Resolve static variables (available before any step executes).
 * Handles: {{input.*}}, {{env.*}}, {{date}}, {{time}}, {{workflow.*}}
 */
export function resolveStaticVariables(
  template: string,
  inputs: Record<string, string>,
  workflowName: string,
): string {
  const now = new Date();
  const timezone = currentTimeZone();
  const dateStr = dateKeyInTimeZone(now, timezone);
  const timeStr = formatTime24InTimeZone(now, timezone);

  return template.replace(/\{\{([^}]+)\}\}/g, (match, key: string) => {
    const trimmed = key.trim();

    // {{input.topic}} → inputs['topic']
    if (trimmed.startsWith('input.')) {
      const inputKey = trimmed.slice(6);
      return inputs[inputKey] ?? match;
    }

    // {{env.OWNER_NAME}} → config values
    if (trimmed.startsWith('env.')) {
      const envKey = trimmed.slice(4);
      if (envKey === 'OWNER_NAME') return OWNER_NAME || match;
      if (envKey === 'ASSISTANT_NAME') return ASSISTANT_NAME || match;
      return match;
    }

    // {{workflow.name}} → workflow name
    if (trimmed.startsWith('workflow.')) {
      const field = trimmed.slice(9);
      if (field === 'name') return workflowName;
      return match;
    }

    // {{date}}, {{time}}
    if (trimmed === 'date') return dateStr;
    if (trimmed === 'time') return timeStr;

    // Leave unresolved (might be a step output reference)
    return match;
  });
}

/**
 * Resolve step output references after dependencies complete.
 * Handles: {{steps.research.output}}
 */
export function resolveStepOutputs(
  template: string,
  stepResults: Map<string, string>,
  truncateChars = 4000,
): string {
  return template.replace(/\{\{steps\.([^.]+)\.output\}\}/g, (_match, stepId: string) => {
    const output = stepResults.get(stepId);
    if (output === undefined) return `[step "${stepId}" has no output]`;
    if (output.length > truncateChars) {
      return output.slice(0, truncateChars) + '\n...[truncated]';
    }
    return output;
  });
}
