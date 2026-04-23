/**
 * Post-turn contradiction validator.
 *
 * After a chat turn's SDK stream completes, compares the assistant's outgoing
 * reply against the actual tool_use/tool_result pairs from that turn. If a
 * claude_ai_* connector succeeded (or returned an argument error — a fixable
 * per-call failure) but the reply claims the connector is broken, missing from
 * the schema, or otherwise generalizes a single failure into connector-level
 * "deadness," we flag it.
 *
 * This is deterministic: it does NOT rely on the model obeying prompt rules.
 * It's the load-bearing guardrail that replaces the forbidden-phrase list we
 * used to patch into the system prompt.
 */

export type ToolResultClass = 'success' | 'arg_error' | 'auth_error' | 'other_error';

export interface ToolCallRecord {
  /** Tool name, e.g. mcp__claude_ai_Google_Drive__search_files */
  name: string;
  /** tool_use_id from the assistant's request */
  id: string;
  /** Classification of the paired tool_result */
  resultClass: ToolResultClass;
  /** First ~200 chars of the literal result content (or error text) */
  resultPreview: string;
}

const ARG_ERROR_RE = /\b(invalid|unknown field|required|missing parameter|schema|unrecognized|unexpected property)\b/i;
const AUTH_ERROR_RE = /\b(unauthori[sz]ed|401|not authenticated|token expired|token has expired|invalid[_ ]?token|access denied)\b/i;

/** Regex matching reply phrasings that claim a connector-wide failure. */
export const CONTRADICTION_RE =
  /(dead\s*end|doesn'?t exist|not in (the |my )?schema|schema[- ]level|not available|isn'?t loaded|tools array is empty|MCP server still connecting|connector is (a )?dead|no such tool available|tool doesn't exist)/i;

export function classifyResult(content: string, isError: boolean): ToolResultClass {
  if (!isError) return 'success';
  if (ARG_ERROR_RE.test(content)) return 'arg_error';
  if (AUTH_ERROR_RE.test(content)) return 'auth_error';
  return 'other_error';
}

/** Extract string content from a tool_result block (which can be string or array of content blocks). */
function stringifyResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (typeof b === 'string' ? b : (b?.text ?? b?.content ?? JSON.stringify(b))))
      .join('\n');
  }
  if (content == null) return '';
  try { return JSON.stringify(content); } catch { return String(content); }
}

/**
 * Walk collected SDK messages (assistant + user) and pair every tool_use with
 * its tool_result. Returns one record per tool_use; unpaired ones (still
 * running at end of stream) are skipped.
 */
export function collectToolCalls(messages: Array<{ type: string; message?: any }>): ToolCallRecord[] {
  const toolUses = new Map<string, { name: string; id: string }>();
  const results = new Map<string, { content: string; isError: boolean }>();

  for (const msg of messages) {
    if (msg.type === 'assistant' && msg.message?.content) {
      const blocks = Array.isArray(msg.message.content) ? msg.message.content : [];
      for (const b of blocks) {
        if (b?.type === 'tool_use' && b.id && b.name) {
          toolUses.set(b.id, { name: b.name, id: b.id });
        }
      }
    } else if (msg.type === 'user' && msg.message?.content) {
      const blocks = Array.isArray(msg.message.content) ? msg.message.content : [];
      for (const b of blocks) {
        if (b?.type === 'tool_result' && b.tool_use_id) {
          results.set(b.tool_use_id, {
            content: stringifyResultContent(b.content),
            isError: !!b.is_error,
          });
        }
      }
    }
  }

  const records: ToolCallRecord[] = [];
  for (const [id, tu] of toolUses) {
    const r = results.get(id);
    if (!r) continue;
    records.push({
      name: tu.name,
      id,
      resultClass: classifyResult(r.content, r.isError),
      resultPreview: r.content.slice(0, 200),
    });
  }
  return records;
}

export interface ContradictionFinding {
  /** The tool call whose result contradicts the reply */
  tool: ToolCallRecord;
  /** The exact phrase from the reply that triggered detection */
  matchedPhrase: string;
}

/**
 * Check a reply against a set of tool-call records. Returns the first
 * contradiction found, or null if the reply is consistent with tool results.
 *
 * Contradiction = reply contains a CONTRADICTION_RE phrase AND at least one
 * mcp__claude_ai_* tool in this turn classified `success` or `arg_error`.
 * `auth_error` and `other_error` are legitimate failures that can support
 * those reply phrasings.
 */
export function detectContradiction(
  reply: string,
  calls: ToolCallRecord[],
): ContradictionFinding | null {
  if (!reply) return null;
  const match = reply.match(CONTRADICTION_RE);
  if (!match) return null;

  const connectorCalls = calls.filter(c => c.name.startsWith('mcp__claude_ai_'));
  const recoverable = connectorCalls.find(
    c => c.resultClass === 'success' || c.resultClass === 'arg_error',
  );
  if (!recoverable) return null;

  return { tool: recoverable, matchedPhrase: match[0] };
}

/**
 * Build the system-follow-up message we inject when a contradiction fires.
 * The SDK will run one more turn with this as a user-role message (using
 * `canUseTool` or similar hook), and the model's next reply replaces the
 * bad one.
 */
export function buildCorrectionPrompt(finding: ContradictionFinding): string {
  const { tool, matchedPhrase } = finding;
  const classLabel =
    tool.resultClass === 'success' ? 'returned successful content' :
    tool.resultClass === 'arg_error' ? 'returned an argument error (fixable by correcting the args — the connector itself works)' :
    tool.resultClass;

  return (
    `Your previous reply contained "${matchedPhrase}" but ${tool.name} ${classLabel}.\n\n` +
    `Literal tool result (first 200 chars):\n${tool.resultPreview}\n\n` +
    `Rewrite your reply using the actual tool result. ` +
    (tool.resultClass === 'arg_error'
      ? `This was an argument error for one call — the connector is NOT broken. Re-read the tool's schema (the rejected argument names are in the error above), retry the call with correct args, and report what comes back.`
      : `Do not generalize this to "the connector is broken" or "the tool doesn't exist" — those claims contradict the tool's actual return value.`)
  );
}
