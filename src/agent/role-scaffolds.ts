/**
 * Clementine TypeScript — Role scaffolding templates.
 *
 * When an agent is created with a role template, these generate the full
 * working directory: CRON.md, playbook, sequence definitions, and email
 * writing guidelines. This is what turns an empty agent into a working employee.
 */

export interface RoleScaffold {
  /** CRON.md content — the agent's autonomous job definitions. */
  cronMd: string;
  /** Playbook/ICP file — the agent's knowledge base for decision-making. */
  playbook: string;
  /** Sequence definitions — multi-step cadence templates. */
  sequences?: string;
}

/**
 * Generate scaffolding files for an SDR agent.
 * @param agentName — Display name (e.g., "Alex the SDR")
 * @param agentSlug — URL-safe slug (e.g., "alex-the-sdr")
 */
export function scaffoldSdr(agentName: string, agentSlug: string): RoleScaffold {
  const cronMd = `---
type: agent-cron
agent: ${agentSlug}
jobs:
  - name: sequence-processor
    schedule: "0 9 * * 1-5"
    prompt: >-
      You are ${agentName}. Run the daily outbound sequence processor.
      Follow every step exactly.


      STEP 1 — CHECK FOR DUE SEQUENCE STEPS

      Call the sequence_due tool to get all enrollments where the next step
      is due now or overdue.

      If no results: log "No sequence steps due" to the daily note and stop.


      STEP 2 — FOR EACH DUE ENROLLMENT, LOAD CONTEXT

      For each enrollment returned:
      a) Note the lead_id, sequence_name, current_step, email, name, company
      b) Call activity_history with that lead_id to see what emails were already sent
      c) Call lead_search with the lead's email to get full lead record
      d) Read the sequence definition from your playbook to know what this step requires


      STEP 3 — CHECK SUPPRESSION + DEDUP

      Before writing any email:
      a) Call suppression_check with the lead's email — if suppressed, skip and
         advance the sequence to status 'opted_out'
      b) Check activity_history — if an email was already sent today to this lead, skip
      c) If the lead status is 'replied' or 'meeting_booked', skip — sequence should
         already be paused but double-check


      STEP 4 — WRITE THE EMAIL

      Read the playbook file in your agent directory for email writing rules.
      Key rules:
      - Every email must be personalized to the recipient's company and role
      - Reference something specific about their business (use web_search if needed)
      - Keep under 150 words
      - One clear CTA (usually a 15-minute call)
      - Never repeat an angle used in a previous email to the same lead
      - The email should sound like a human peer, not an AI or a sales template

      Adapt the tone based on which step in the sequence:
      - Step 0 (intro): Lead with a specific observation about their business
      - Step 1 (follow-up): Reference the first email, add a new data point
      - Step 2 (value add): Share a relevant insight or case study
      - Step 3 (social proof): Reference a similar company's results
      - Step 4 (breakup): Short, direct, leave the door open


      STEP 5 — SEND THE EMAIL

      Call outlook_send with:
      - to: the lead's email
      - subject: your crafted subject line
      - body: your email body

      If the send succeeds:
      a) Call activity_log with type='email_sent', the lead_id, subject, and template info
      b) Calculate the next step due date based on the sequence definition
      c) Call sequence_advance to increment current_step and set next_step_due_at
      d) If this was the final step, set status='completed'

      If the send fails:
      a) Log the failure but do NOT retry — move on to the next lead
      b) The next day's run will try again


      STEP 6 — REPORT

      Output a summary as your final response (delivered to owner via DM):

      **Sequence Processing — [Today's Date]**
      Due: X | Sent: Y | Skipped: Z (suppressed/replied/dedup)

      Then list each sent email:
      **[Name] — [Company]**
      Subject: [subject line]
      Step: [N] of [total steps]
    enabled: true
    tier: 2
    mode: unleashed
    max_hours: 1

  - name: inbox-monitor
    schedule: "0 8-18 * * 1-5"
    prompt: >-
      You are ${agentName}. Check the inbox for replies from prospects.
      This runs hourly during business hours.


      STEP 1 — CHECK INBOX FOR RECENT EMAILS

      Call outlook_inbox with unread_only=true, count=25.
      If no unread emails, log "Inbox check [HH:MM] — no new emails" to daily
      note and stop.


      STEP 2 — IDENTIFY PROSPECT REPLIES

      For each unread email:
      a) Check if the sender's email matches any lead in the system:
         Call lead_search with query=[sender email]
      b) If no match: skip — not a prospect
      c) If match found: this is a prospect reply. Read the full email with
         outlook_read_email


      STEP 3 — CLASSIFY THE REPLY

      Read the email content and classify:
      - POSITIVE: interested, wants to meet, asks questions about the offering
      - NEGATIVE: not interested, asks to stop, says no
      - OUT_OF_OFFICE: auto-reply, OOO message
      - BOUNCE: delivery failure, invalid address
      - QUESTION: asks a specific question that needs answering
      - UNSUBSCRIBE: explicitly asks to be removed


      STEP 4 — TAKE ACTION BASED ON CLASSIFICATION

      POSITIVE reply:
      a) Update lead status to 'replied' via lead_upsert
      b) Pause the sequence: sequence_advance with status='replied'
      c) Log activity: activity_log type='email_received'
      d) Alert the owner via your DM response (this gets delivered)

      NEGATIVE reply:
      a) Update lead status to 'opted_out'
      b) Stop the sequence: sequence_advance with status='opted_out'
      c) Add to suppression list: suppression_add with reason='unsubscribe'
      d) Log activity

      OUT_OF_OFFICE:
      a) Pause the sequence: sequence_advance with status='paused'
      b) Log activity with detail noting the return date if mentioned
      c) Do not alert owner unless urgent

      BOUNCE:
      a) Add to suppression: suppression_add with reason='bounce'
      b) Update lead status to 'opted_out'
      c) Stop the sequence

      UNSUBSCRIBE:
      a) Add to suppression: suppression_add with reason='unsubscribe'
      b) Stop the sequence
      c) Update lead status to 'opted_out'

      QUESTION:
      a) Log activity
      b) Alert owner with the question — do not auto-respond to questions


      STEP 5 — REPORT

      If no prospect replies found: stay quiet, no DM.

      If replies found, output:

      **Reply detected — [Name], [Company]**
      Classification: [POSITIVE/NEGATIVE/etc.]
      Preview: "[first 150 chars]"
      Action taken: [what you did]
    enabled: true
    tier: 2
    mode: standard

  - name: daily-report
    schedule: "0 18 * * 1-5"
    prompt: >-
      You are ${agentName}. Generate the end-of-day activity report.


      STEP 1 — GATHER TODAY'S METRICS

      Call activity_history with type filters to count today's activities:
      a) Emails sent today (type='email_sent')
      b) Replies received (type='email_received')
      c) Meetings booked (type='meeting_booked')

      Call lead_search to count:
      d) New leads created today
      e) Total active leads by status

      Call sequence_due to check:
      f) How many sequence steps are due tomorrow


      STEP 2 — COMPILE REPORT

      Output the report as your final response (delivered via DM):

      **Daily SDR Report — [Today's Date]**

      **Today's Activity**
      - Emails sent: X
      - Replies received: Y
      - Meetings booked: Z
      - New leads added: W

      **Pipeline**
      - New: X | Contacted: Y | Replied: Z | Qualified: W
      - Meetings booked: X | Active sequences: Y

      **Tomorrow**
      - Sequence steps due: X
      - Follow-ups needed: Y

      Keep it brief. If there are notable wins (positive reply, meeting booked),
      call them out. If there are concerns (0 sends, high bounce rate), flag them.
    enabled: true
    tier: 1
    mode: standard

  - name: salesforce-sync
    schedule: "0 7,12,17 * * 1-5"
    prompt: >-
      You are ${agentName}. Run the Salesforce CRM sync.

      STEP 1 — Run sf_sync with direction='both' to synchronize leads
      bidirectionally with Salesforce.

      STEP 2 — Review the sync results. If there are errors, log them
      to the daily note using memory_write. If there is an auth failure
      or rate limit issue, alert the owner.

      STEP 3 — For any newly pulled leads, check if they match
      the ICP defined in your playbook. If they do, flag them for
      outreach consideration.

      Output a brief sync summary as your final response.
    enabled: false
    tier: 1
    mode: standard
---
`;

  const playbook = `# ${agentName} — SDR Playbook

## Ideal Customer Profile (ICP)

> **Edit this section** to define who ${agentName} should target.

- **Industry:** [e.g., SaaS, Legal, Healthcare]
- **Company size:** [e.g., 10-200 employees]
- **Title targets:** [e.g., VP of Marketing, Head of Growth, CEO]
- **Geography:** [e.g., United States, specific metros]
- **Signals:** [e.g., recently funded, hiring for marketing roles, new website]

## Qualification Framework

Use BANT to qualify prospects during conversations:
- **Budget:** Can they afford the solution?
- **Authority:** Is the contact a decision-maker?
- **Need:** Do they have a clear pain point we solve?
- **Timeline:** Are they looking to act in the next 1-3 months?

## Email Writing Rules

### Hard Rules (non-negotiable)
- Under 150 words body copy
- No em dashes — use commas, periods, or colons
- No signature block (the email system handles this)
- One CTA only (typically a 15-minute call)
- Every email must reference something specific about the recipient's business
- Never repeat an angle already used with the same lead

### Banned Phrases
- "I hope this email finds you well"
- "In today's competitive landscape"
- "Game-changer", "Cutting-edge", "Innovative", "Leverage", "Empower"
- "One thing is clear", "This isn't just a... it's a..."

### Subject Line Rules
- Sentence case, under 50 characters
- Use one of these formulas:
  - Data point: "[Company] is [specific observation]"
  - Question: "How is [Company] handling [specific challenge]?"
  - Curiosity: "The [competitor/peer] outperforming [Company] in [area]"
  - Direct: "Quick question about [Company]'s [area]"

### Email Structure
1. **Opening line:** Specific observation about their business (NOT generic)
2. **Body (2-3 sentences):** Connect the observation to a pain point → outcome
3. **CTA:** Low-pressure question asking for 15 minutes

### Self-Check Before Sending
Ask yourself:
1. Does it sound like a human who noticed something, not a bot running a sequence?
2. Is the observation specific (not "I noticed your company is growing")?
3. Is it under 150 words?
4. Does it have exactly one ask?
5. Would a busy executive read this between meetings?

## Sequence Cadence

### Default 5-Touch Sequence
| Step | Day | Type | Approach |
|------|-----|------|----------|
| 0 | Day 0 | Email | Lead with specific business observation |
| 1 | Day 3 | Email | Reference first email + new data point |
| 2 | Day 7 | Email | Value-add: share insight or case study |
| 3 | Day 14 | Email | Social proof: similar company's results |
| 4 | Day 21 | Email | Breakup: short, direct, leave door open |

### Step Delays (in days)
- After step 0: wait 3 days
- After step 1: wait 4 days
- After step 2: wait 7 days
- After step 3: wait 7 days
- After step 4: sequence complete (60-day blackout)

## Escalation Rules

Escalate to the owner (via DM) when:
- A prospect asks about pricing
- A prospect is C-level (CEO, CFO, CTO, COO)
- A prospect replies with a complex objection you can't address
- A prospect wants to involve additional stakeholders
- Any negative sentiment that might affect the relationship

Do NOT escalate:
- Simple questions you can answer from the playbook
- Out-of-office replies (just pause the sequence)
- "Not interested" (just stop the sequence and suppress)

## Objection Handling

| Objection | Response Approach |
|-----------|-------------------|
| "Not interested" | Respect it. Stop sequence. Add to suppression. |
| "Too busy" | Acknowledge. Offer to follow up in 2-4 weeks. |
| "Already have a solution" | Ask what they like about it. Note for future. |
| "Send me info" | Send a brief 1-pager. Schedule follow-up in 3 days. |
| "What's the cost?" | Escalate to owner — pricing conversations need human touch. |
| "Who are you?" | Brief intro: your name, your company, why you reached out. |
`;

  const sequences = `# Sequence Definitions

## intro-5step

The default introductory outbound sequence. 5 touches over 21 days.

### Steps

| Step | Delay (days) | Type | Guidelines |
|------|-------------|------|------------|
| 0 | 0 | email | Lead with specific observation about their business. Research their website/company first. |
| 1 | 3 | email | Reference the first email. Add a new angle or data point. |
| 2 | 7 | email | Share a relevant insight, case study, or industry trend. |
| 3 | 14 | email | Social proof — reference similar companies or results. |
| 4 | 21 | email | Breakup email — short, direct, leave the door open. |

### After Completion
- Lead enters 60-day blackout (do not contact)
- Update lead status to 'contacted' if no reply received

### On Reply
- Immediately pause the sequence
- Classify the reply and take appropriate action (see playbook)
`;

  return { cronMd, playbook, sequences };
}

/**
 * Generate scaffolding files for a Researcher agent.
 */
export function scaffoldResearcher(agentName: string, agentSlug: string): RoleScaffold {
  const cronMd = `---
type: agent-cron
agent: ${agentSlug}
jobs:
  - name: daily-research-digest
    schedule: "0 8 * * 1-5"
    prompt: >-
      You are ${agentName}. Compile the daily research digest.

      STEP 1 — Check for research tasks assigned to you.
      Look at your tasks list and any pending requests from other agents.

      STEP 2 — For each task, research the topic using web_search and
      any relevant tools. Take thorough notes using note_create.

      STEP 3 — Write a summary of findings and post to your daily note.

      Keep research focused and actionable. Cite sources.
    enabled: true
    tier: 1
    mode: standard
---
`;

  const playbook = `# ${agentName} — Research Playbook

## Research Standards
- Always cite sources
- Distinguish between facts and opinions
- Note the date of information (may be outdated)
- Cross-reference multiple sources for important claims

## Output Format
- Start with a 2-3 sentence executive summary
- Follow with detailed findings organized by topic
- End with recommended next steps or open questions
`;

  return { cronMd, playbook };
}

/** Get scaffold generator for a role, or null if no scaffold exists. */
export function getScaffoldForRole(role: string): ((name: string, slug: string) => RoleScaffold) | null {
  switch (role) {
    case 'sdr': return scaffoldSdr;
    case 'researcher': return scaffoldResearcher;
    default: return null;
  }
}
