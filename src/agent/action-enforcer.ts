import { looksLikeApprovalPrompt } from './local-turn.js';

export type ActionExpectationSource = 'approval_followup' | 'user_request' | 'diagnostic_request' | 'none';

export interface ActionExpectation {
  expected: boolean;
  source: ActionExpectationSource;
  reason: string;
}

export interface ActionResponseAssessment {
  violation: boolean;
  reason: string;
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

const ACTION_REQUEST_RE = /\b(can you|could you|would you|please|pls|i need you to|i want you to|let'?s|go ahead and|do it|handle this|take care of)\b[\s\S]{0,160}\b(send|email|message|post|publish|delete|change|update|run|execute|check|look(?:\s+into)?|diagnose|investigate|figure(?:\s+it)?\s*out|find|search|read|write|create|fix|schedule|reschedule|pull|fetch|review|tag|save|upload|download)\b/i;
const DIRECT_ACTION_RE = /^(send|email|message|post|publish|delete|change|update|run|execute|check|look(?:\s+into)?|diagnose|investigate|find|search|read|write|create|fix|schedule|reschedule|pull|fetch|review|tag|save|upload|download)\b/i;
const DIAGNOSTIC_RE = /\b(log|logs|crash|crashing|error|failing|failure|broken|diagnose|debug|investigate|look into|figure it out|what'?s causing|why is|why did)\b/i;

const DONE_CLAIM_RE = /\b(done|sent|emailed|queued|accepted|completed|finished|fixed|updated|changed|deleted|posted|published|scheduled|rescheduled|created|saved|uploaded|downloaded|tagged|checked|reviewed|found|read|ran|executed)\b/i;
const PROMISE_RE = /\b(i'?ll|i will|i am going to|i'?m going to|let me|i'?m checking|i'?m sending|i'?m running|i'?m looking|working on it|on it)\b[\s\S]{0,120}\b(send|email|message|post|publish|delete|change|update|run|execute|check|look|diagnose|investigate|find|search|read|write|create|fix|schedule|reschedule|pull|fetch|review|tag|save|upload|download|now)\b/i;
const VACUOUS_ACK_RE = /^(got it|okay|ok|sure|perfect|sounds good|on it|will do|yep|yeah)[.! ]*$/i;
const BLOCKED_OR_ASKING_RE = /\b(i can'?t|i cannot|unable to|blocked|need you to|need a|need the|please provide|please send|can you send|can you share|which|what should|who should|before i|confirm|approve|good to go|okay to)\b/i;
const DIAGNOSTIC_DEFLECTION_RE = /\b(what are you seeing|what do you see|send (me )?the logs|share (the )?logs|provide (the )?logs|can you paste|can you send me)\b/i;

export function detectActionExpectation(
  userText: string,
  opts: { approvalFollowup?: boolean } = {},
): ActionExpectation {
  if (opts.approvalFollowup) {
    return {
      expected: true,
      source: 'approval_followup',
      reason: 'user approved the previous action prompt',
    };
  }

  const text = userText.trim();
  if (!text) return { expected: false, source: 'none', reason: 'empty message' };

  if (ACTION_REQUEST_RE.test(text) || DIRECT_ACTION_RE.test(text)) {
    const diagnostic = DIAGNOSTIC_RE.test(text);
    return {
      expected: true,
      source: diagnostic ? 'diagnostic_request' : 'user_request',
      reason: diagnostic ? 'user asked for local/tool-backed diagnosis' : 'user asked Clementine to take an action',
    };
  }

  if (DIAGNOSTIC_RE.test(text) && /\b(can you|could you|please|figure|diagnose|debug|look)\b/i.test(text)) {
    return {
      expected: true,
      source: 'diagnostic_request',
      reason: 'user asked for local/tool-backed diagnosis',
    };
  }

  return { expected: false, source: 'none', reason: 'no concrete action requested' };
}

export function buildApprovalFollowupPrompt(reply: string): string {
  return [
    `[Approval reply: "${reply.trim().slice(0, 120)}"]`,
    'The user approved the action you proposed in your previous message.',
    'Continue from that previous approval prompt and perform the approved action now using the appropriate tool.',
    'Do not treat this as casual feedback. Do not say it is done unless a tool call verifies it. If you are blocked, say exactly what is blocking you.',
  ].join('\n');
}

export function assessActionResponse(input: {
  actionExpectation: ActionExpectation;
  userText: string;
  response: string;
  toolActivityCount: number;
  backgroundStarted?: boolean;
  delegated?: boolean;
}): ActionResponseAssessment {
  const { actionExpectation, userText, response, toolActivityCount } = input;
  if (!actionExpectation.expected) return { violation: false, reason: 'no action expected' };
  if (input.backgroundStarted) return { violation: false, reason: 'action was queued in background' };
  if (input.delegated) return { violation: false, reason: 'action was delegated' };
  if (toolActivityCount > 0) return { violation: false, reason: 'tool activity observed' };

  const trimmed = response.trim();
  if (!trimmed) return { violation: true, reason: 'empty response to action request' };
  if (looksLikeApprovalPrompt(trimmed)) {
    if (actionExpectation.source === 'approval_followup') {
      return { violation: true, reason: 'asked for approval again after the user already approved' };
    }
    return { violation: false, reason: 'assistant requested approval before acting' };
  }

  const lower = normalize(trimmed);
  if (actionExpectation.source === 'diagnostic_request' && DIAGNOSTIC_DEFLECTION_RE.test(lower)) {
    return { violation: true, reason: 'asked user for logs instead of using available local tools' };
  }

  if (VACUOUS_ACK_RE.test(trimmed)) {
    return { violation: true, reason: 'acknowledged action request without acting' };
  }

  if (DONE_CLAIM_RE.test(trimmed)) {
    return { violation: true, reason: 'claimed completion without tool activity' };
  }

  if (PROMISE_RE.test(trimmed)) {
    return { violation: true, reason: 'promised future action without same-turn tool activity' };
  }

  if (BLOCKED_OR_ASKING_RE.test(lower) || trimmed.endsWith('?')) {
    return { violation: false, reason: 'assistant asked for needed input or reported a block' };
  }

  // Diagnostic requests should usually use local tools. A generic answer with
  // no tool activity is allowed only if it clearly does not claim inspection.
  if (actionExpectation.source === 'diagnostic_request' && /\b(i think|likely|probably|sounds like)\b/i.test(trimmed)) {
    return { violation: false, reason: 'assistant gave hypothesis without claiming inspection' };
  }

  // For action-shaped requests, a generic short answer is usually a stall.
  if (trimmed.length < 80 && /\b(send|email|message|run|fix|check|diagnose|figure|look)\b/i.test(userText)) {
    return { violation: true, reason: 'short action response without tool activity' };
  }

  return { violation: false, reason: 'no unsupported action claim detected' };
}
