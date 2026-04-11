/**
 * Clementine TypeScript — External/Integration MCP tools.
 *
 * rss_fetch, web_search, github_prs, browser_screenshot,
 * outlook_inbox/search/calendar/create_event/find_availability/draft/send/read_email,
 * discord_channel_read/send/send_buttons/create,
 * SDR/CRM tools, Salesforce tools
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  ACTIVE_AGENT_SLUG, EXTERNAL_CONTENT_TAG, SYSTEM_DIR,
  env, externalResult, getStore, logger, textResult,
} from './shared.js';
import { getToolDescription } from './tool-meta.js';

export function registerExternalTools(server: McpServer): void {
// ── 13. rss_fetch ──────────────────────────────────────────────────────

server.tool(
  'rss_fetch',
  getToolDescription('rss_fetch') ?? 'Fetch and parse RSS feeds. Returns recent articles with titles, links, dates, and summaries.',
  {
    feed_url: z.string().optional().describe('Single RSS feed URL (optional — if omitted, reads from RSS-FEEDS.md)'),
  },
  async ({ feed_url }) => {
    const feedsToFetch: Array<{ name: string; url: string }> = [];

    if (feed_url) {
      feedsToFetch.push({ name: 'Custom Feed', url: feed_url });
    } else {
      // Read feeds from RSS-FEEDS.md
      const rssConfig = path.join(SYSTEM_DIR, 'RSS-FEEDS.md');
      if (!existsSync(rssConfig)) {
        return textResult('Error: vault/00-System/RSS-FEEDS.md not found.');
      }
      try {
        const matter = await import('gray-matter');
        const parsed = matter.default(readFileSync(rssConfig, 'utf-8'));
        const feeds = (parsed.data?.feeds ?? []) as Array<{ name?: string; url: string; enabled?: boolean }>;
        for (const feed of feeds) {
          if (feed.enabled !== false) {
            feedsToFetch.push({ name: feed.name ?? 'Unnamed', url: feed.url });
          }
        }
      } catch (err) {
        return textResult(`Error reading RSS-FEEDS.md: ${err}`);
      }
    }

    if (!feedsToFetch.length) {
      return textResult('No enabled feeds found in RSS-FEEDS.md.');
    }

    const allResults: string[] = [];

    for (const feedInfo of feedsToFetch) {
      try {
        const response = await fetch(feedInfo.url, {
          headers: { 'User-Agent': 'Clementine/1.0' },
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) {
          allResults.push(`**${feedInfo.name}** — Error: HTTP ${response.status}`);
          continue;
        }

        const xml = await response.text();

        // Simple XML parsing for RSS/Atom items
        const items = parseRssXml(xml);
        if (!items.length) {
          allResults.push(`**${feedInfo.name}** — No articles found`);
          continue;
        }

        const limited = items.slice(0, 10);
        const lines = [`**${feedInfo.name}** (${limited.length} articles):`];
        for (const item of limited) {
          let line = `- **${item.title}**`;
          if (item.pubDate) line += ` (${item.pubDate})`;
          if (item.link) line += `\n  Link: ${item.link}`;
          if (item.summary) line += `\n  ${item.summary.slice(0, 200)}`;
          lines.push(line);
        }
        allResults.push(lines.join('\n'));
      } catch (err) {
        allResults.push(`**${feedInfo.name}** — Error fetching feed: ${err}`);
      }
    }

    return externalResult(allResults.join('\n\n---\n\n'));
  },
);

/** Simple RSS/Atom XML parser (no external dependency). */
function parseRssXml(xml: string): Array<{ title: string; link: string; pubDate: string; summary: string }> {
  const items: Array<{ title: string; link: string; pubDate: string; summary: string }> = [];

  // Try RSS <item> first, then Atom <entry>
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  const entryRegex = /<entry[\s>]([\s\S]*?)<\/entry>/gi;

  const regex = xml.includes('<item') ? itemRegex : entryRegex;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTag(block, 'title');
    const link = extractTag(block, 'link') || extractAttr(block, 'link', 'href');
    const pubDate = extractTag(block, 'pubDate') || extractTag(block, 'published') || extractTag(block, 'updated');
    const summary = extractTag(block, 'description') || extractTag(block, 'summary') || '';

    // Strip HTML tags from summary
    const cleanSummary = summary.replace(/<[^>]+>/g, '').trim();

    items.push({ title, link, pubDate, summary: cleanSummary });
  }

  return items;
}

function extractTag(xml: string, tag: string): string {
  // Handle CDATA
  const cdataRe = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, 'i');
  const cdataMatch = cdataRe.exec(xml);
  if (cdataMatch) return cdataMatch[1].trim();

  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = re.exec(xml);
  return m ? m[1].trim() : '';
}

function extractAttr(xml: string, tag: string, attr: string): string {
  const re = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, 'i');
  const m = re.exec(xml);
  return m ? m[1] : '';
}


// ── 14. web_search ──────────────────────────────────────────────────────

server.tool(
  'web_search',
  getToolDescription('web_search') ?? 'Search the web via DuckDuckGo. Returns titles, URLs, and snippets. No API key required.',
  {
    query: z.string().describe('Search query'),
    max_results: z.number().optional().default(5).describe('Max results (1-10)'),
  },
  async ({ query, max_results }) => {
    const encoded = encodeURIComponent(query);
    const url = `https://html.duckduckgo.com/html/?q=${encoded}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Clementine/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    const html = await response.text();
    const results = parseDdgResults(html, Math.min(max_results ?? 5, 10));
    if (!results.length) return textResult(`No results found for: ${query}`);
    const formatted = results
      .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`)
      .join('\n\n');
    return externalResult(`Search results for "${query}":\n\n${formatted}`);
  },
);

/** Parse DuckDuckGo HTML search results. */
function parseDdgResults(
  html: string,
  max: number,
): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];

  // DDG wraps each result in a <div class="result ..."> with:
  //   <a class="result__a" href="...">Title</a>
  //   <a class="result__snippet" ...>Snippet text</a>
  const resultBlockRe = /<div[^>]*class="[^"]*result\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]*class="[^"]*result\b|$)/gi;
  const titleRe = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i;
  const snippetRe = /<(?:a|span)[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|span)>/i;

  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = resultBlockRe.exec(html)) !== null && results.length < max) {
    const block = blockMatch[1];
    const titleMatch = titleRe.exec(block);
    if (!titleMatch) continue;

    let href = titleMatch[1];
    // DDG proxies URLs through //duckduckgo.com/l/?uddg=<encoded_url>
    if (href.includes('uddg=')) {
      const uddg = new URL(href, 'https://duckduckgo.com').searchParams.get('uddg');
      if (uddg) href = uddg;
    }
    const title = titleMatch[2].replace(/<[^>]+>/g, '').trim();

    const snippetMatch = snippetRe.exec(block);
    const snippet = snippetMatch
      ? snippetMatch[1].replace(/<[^>]+>/g, '').trim()
      : '';

    if (title && href) {
      results.push({ title, url: href, snippet });
    }
  }

  return results;
}


// ── 15. github_prs ─────────────────────────────────────────────────────

server.tool(
  'github_prs',
  getToolDescription('github_prs') ?? 'Check GitHub PRs — review-requested and authored. Read-only.',
  { _empty: z.string().optional().describe('(no parameters needed)') },
  async () => {
    const parts: string[] = [];

    try {
      const reviewResult = execSync(
        'gh pr list --search "review-requested:@me"',
        { encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();
      parts.push(reviewResult
        ? `**PRs needing your review:**\n${reviewResult}`
        : '**PRs needing your review:** None');
    } catch (err) {
      parts.push(`**PRs needing review:** Error — ${err}`);
    }

    try {
      const authorResult = execSync(
        'gh pr list --author "@me"',
        { encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();
      parts.push(authorResult
        ? `**Your open PRs:**\n${authorResult}`
        : '**Your open PRs:** None');
    } catch (err) {
      parts.push(`**Your open PRs:** Error — ${err}`);
    }

    return textResult(parts.join('\n\n'));
  },
);


// ── 15. browser_screenshot ─────────────────────────────────────────────

server.tool(
  'browser_screenshot',
  'Take a screenshot of a URL using a Kernel cloud browser.',
  {
    url: z.string().describe('URL to screenshot'),
  },
  async ({ url }) => {
    try {
      // Verify kernel CLI is available
      execSync('which kernel', { stdio: 'pipe' });
    } catch {
      return textResult('kernel CLI not found. Install with: npm i -g @onkernel/cli');
    }

    let browserId: string | null = null;
    try {
      // Create browser
      const createOut = execSync(
        `kernel browsers create --timeout 60 --viewport "1920x1080@25" -o json`,
        { encoding: 'utf-8', timeout: 30000 },
      );
      const data = JSON.parse(createOut);
      browserId = data.id ?? data.session_id ?? null;

      if (!browserId) {
        return textResult(`No browser ID in response: ${createOut.slice(0, 200)}`);
      }

      // Navigate
      const navCode = `await page.goto("${url.replace(/"/g, '\\"')}", { waitUntil: "domcontentloaded" }); await page.waitForTimeout(3000);`;
      execSync(
        `kernel browsers playwright execute ${browserId} '${navCode.replace(/'/g, "\\'")}'`,
        { encoding: 'utf-8', timeout: 60000 },
      );

      // Screenshot
      const tmpPath = path.join(
        (process.env.TMPDIR ?? '/tmp'),
        `kernel_screenshot_${Date.now()}.png`,
      );
      execSync(
        `kernel browsers computer screenshot ${browserId} --to "${tmpPath}"`,
        { encoding: 'utf-8', timeout: 15000 },
      );

      return textResult(`Screenshot saved to: ${tmpPath}`);
    } catch (err) {
      return textResult(`Browser screenshot error: ${err}`);
    } finally {
      if (browserId) {
        try {
          execSync(`kernel browsers delete ${browserId}`, { timeout: 10000, stdio: 'pipe' });
        } catch {
          // ignore cleanup errors
        }
      }
    }
  },
);


// ── Microsoft Graph API ────────────────────────────────────────────────

let graphToken: { accessToken: string; expiresAt: number } | null = null;

async function getGraphToken(): Promise<string> {
  const tenantId = env['MS_TENANT_ID'] ?? '';
  const clientId = env['MS_CLIENT_ID'] ?? '';
  const clientSecret = env['MS_CLIENT_SECRET'] ?? '';

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error('Outlook not configured — set MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET in .env');
  }

  // Return cached token if still valid (with 5-min buffer)
  if (graphToken && Date.now() < graphToken.expiresAt - 300_000) {
    return graphToken.accessToken;
  }

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  const res = await fetch(tokenUrl, { method: 'POST', body });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph token request failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  graphToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return graphToken.accessToken;
}

async function graphGet(endpoint: string): Promise<any> {
  const token = await getGraphToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph API ${res.status}: ${text}`);
  }
  return res.json();
}

async function graphPost(endpoint: string, body: unknown): Promise<any> {
  const token = await getGraphToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph API ${res.status}: ${text}`);
  }
  // sendMail returns 202 with no body
  if (res.status === 202) return { success: true };
  return res.json();
}

// ── 17. outlook_inbox ───────────────────────────────────────────────────

server.tool(
  'outlook_inbox',
  getToolDescription('outlook_inbox') ?? 'Read recent emails from the Outlook inbox. Returns sender, subject, date, and preview.',
  {
    count: z.number().optional().default(10).describe('Number of emails to fetch (max 25)'),
    unread_only: z.boolean().optional().default(false).describe('Only return unread emails'),
  },
  async ({ count, unread_only }) => {
    const userEmail = env['MS_USER_EMAIL'] ?? '';
    const limit = Math.min(count, 25);
    const filter = unread_only ? '&$filter=isRead eq false' : '';
    const data = await graphGet(
      `/users/${userEmail}/mailFolders/inbox/messages?$top=${limit}&$select=from,subject,receivedDateTime,bodyPreview,isRead,hasAttachments&$orderby=receivedDateTime desc${filter}`
    );
    const emails = (data.value ?? []).map((m: any) => ({
      id: m.id,
      from: m.from?.emailAddress?.name ?? 'unknown',
      from_email: m.from?.emailAddress?.address ?? 'unknown',
      subject: m.subject ?? '(no subject)',
      date: m.receivedDateTime,
      preview: (m.bodyPreview ?? '').slice(0, 200),
      unread: !m.isRead,
      hasAttachments: m.hasAttachments ?? false,
    }));
    return externalResult(JSON.stringify(emails, null, 2));
  },
);

// ── 18. outlook_search ──────────────────────────────────────────────────

server.tool(
  'outlook_search',
  getToolDescription('outlook_search') ?? 'Search emails by keyword. Searches subject, body, and sender.',
  {
    query: z.string().describe('Search query (keywords, sender name, subject text)'),
    count: z.number().optional().default(10).describe('Max results (max 25)'),
  },
  async ({ query, count }) => {
    const userEmail = env['MS_USER_EMAIL'] ?? '';
    const limit = Math.min(count, 25);
    const data = await graphGet(
      `/users/${userEmail}/messages?$search="${encodeURIComponent(query)}"&$top=${limit}&$select=from,subject,receivedDateTime,bodyPreview,hasAttachments&$orderby=receivedDateTime desc`
    );
    const emails = (data.value ?? []).map((m: any) => ({
      id: m.id,
      from: m.from?.emailAddress?.name ?? 'unknown',
      from_email: m.from?.emailAddress?.address ?? 'unknown',
      subject: m.subject ?? '(no subject)',
      date: m.receivedDateTime,
      preview: (m.bodyPreview ?? '').slice(0, 200),
      hasAttachments: m.hasAttachments ?? false,
    }));
    return externalResult(JSON.stringify(emails, null, 2));
  },
);

// ── 19. outlook_calendar ────────────────────────────────────────────────

server.tool(
  'outlook_calendar',
  'View upcoming calendar events. Shows title, time, location, and attendees.',
  {
    days: z.number().optional().default(7).describe('Number of days ahead to look (max 30)'),
  },
  async ({ days }) => {
    const userEmail = env['MS_USER_EMAIL'] ?? '';
    const start = new Date().toISOString();
    const end = new Date(Date.now() + Math.min(days, 30) * 86400000).toISOString();
    const data = await graphGet(
      `/users/${userEmail}/calendarView?startDateTime=${start}&endDateTime=${end}&$select=subject,start,end,location,attendees,isAllDay&$orderby=start/dateTime&$top=50`
    );
    const events = (data.value ?? []).map((e: any) => ({
      title: e.subject ?? '(untitled)',
      start: e.start?.dateTime,
      end: e.end?.dateTime,
      allDay: e.isAllDay ?? false,
      location: e.location?.displayName || null,
      attendees: (e.attendees ?? []).map((a: any) => a.emailAddress?.name ?? a.emailAddress?.address).slice(0, 10),
    }));
    return externalResult(JSON.stringify(events, null, 2));
  },
);

// ── 19b. outlook_create_event ────────────────────────────────────────────

server.tool(
  'outlook_create_event',
  'Create a calendar event and send invitations to attendees. REQUIRES owner approval (Tier 3).',
  {
    subject: z.string().describe('Event title'),
    startDateTime: z.string().describe('Start time in ISO 8601 format (e.g., 2026-03-28T10:00:00)'),
    endDateTime: z.string().describe('End time in ISO 8601 format (e.g., 2026-03-28T10:30:00)'),
    attendees: z.array(z.string()).describe('List of attendee email addresses'),
    body: z.string().optional().describe('Event description/agenda (plain text)'),
    location: z.string().optional().describe('Event location (room name or address)'),
    isOnlineMeeting: z.boolean().optional().default(false).describe('If true, creates a Teams meeting link'),
    timeZone: z.string().optional().describe('IANA timezone for start/end times (default: account timezone)'),
  },
  async ({ subject, startDateTime, endDateTime, attendees, body, location, isOnlineMeeting, timeZone }) => {
    const userEmail = env['MS_USER_EMAIL'] ?? '';
    const tz = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const event: any = {
      subject,
      start: { dateTime: startDateTime, timeZone: tz },
      end: { dateTime: endDateTime, timeZone: tz },
      attendees: attendees.map((email: string) => ({
        emailAddress: { address: email },
        type: 'required',
      })),
      isOnlineMeeting: isOnlineMeeting ?? false,
    };
    if (body) {
      event.body = { contentType: 'Text', content: body };
    }
    if (location) {
      event.location = { displayName: location };
    }
    if (isOnlineMeeting) {
      event.onlineMeetingProvider = 'teamsForBusiness';
    }
    const created = await graphPost(`/users/${userEmail}/events`, event);
    const teamsLink = created.onlineMeeting?.joinUrl ?? null;
    return textResult(
      `Event created: "${subject}" on ${startDateTime} — ${endDateTime}\n` +
      `Attendees: ${attendees.join(', ')}\n` +
      (teamsLink ? `Teams link: ${teamsLink}\n` : '') +
      `Event ID: ${(created.id ?? '').slice(0, 20)}...`
    );
  },
);

// ── 19c. outlook_find_availability ──────────────────────────────────────

server.tool(
  'outlook_find_availability',
  'Check free/busy availability for the user\'s calendar. Useful for finding open slots to propose meeting times.',
  {
    startDateTime: z.string().describe('Start of availability window (ISO 8601)'),
    endDateTime: z.string().describe('End of availability window (ISO 8601)'),
    intervalMinutes: z.number().optional().default(30).describe('Slot duration in minutes (default: 30)'),
  },
  async ({ startDateTime, endDateTime, intervalMinutes }) => {
    const userEmail = env['MS_USER_EMAIL'] ?? '';
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const data = await graphPost(`/users/${userEmail}/calendar/getSchedule`, {
      schedules: [userEmail],
      startTime: { dateTime: startDateTime, timeZone: tz },
      endTime: { dateTime: endDateTime, timeZone: tz },
      availabilityViewInterval: intervalMinutes,
    });

    const schedule = data.value?.[0];
    if (!schedule) return textResult('Could not retrieve availability.');

    // Parse the availability view string: 0=free, 1=tentative, 2=busy, 3=oof, 4=working elsewhere
    const view = schedule.availabilityView ?? '';
    const slotStart = new Date(startDateTime);
    const slots: string[] = [];
    for (let i = 0; i < view.length; i++) {
      const status = view[i];
      const start = new Date(slotStart.getTime() + i * intervalMinutes * 60000);
      const end = new Date(start.getTime() + intervalMinutes * 60000);
      const label = status === '0' ? 'FREE' : status === '1' ? 'TENTATIVE' : status === '2' ? 'BUSY' : status === '3' ? 'OOF' : 'BUSY';
      if (label === 'FREE' || label === 'TENTATIVE') {
        slots.push(`${start.toISOString().slice(11, 16)}–${end.toISOString().slice(11, 16)} ${label}`);
      }
    }

    if (slots.length === 0) return textResult('No available slots in the requested window.');
    return textResult(`Available slots (${tz}):\n${slots.join('\n')}`);
  },
);

// ── 20. outlook_draft ───────────────────────────────────────────────────

server.tool(
  'outlook_draft',
  'Create a draft email in the Outlook Drafts folder (does NOT send). Use this for cron jobs that prepare emails for owner review.',
  {
    to: z.string().describe('Recipient email address'),
    subject: z.string().describe('Email subject line'),
    body: z.string().describe('Email body (plain text)'),
    cc: z.string().optional().describe('CC email address (optional)'),
    reply_to_message_id: z.string().optional().describe('Message ID to reply to. If provided, creates a threaded reply draft instead of a new email. The To and Subject are auto-filled from the original message.'),
  },
  async ({ to, subject, body, cc, reply_to_message_id }) => {
    // Suppression check — prevent drafting emails to opted-out recipients
    const store = await getStore();
    if ((store as any).isSuppressed(to)) {
      return textResult(`⛔ Cannot draft email to ${to} — address is on the suppression list.`);
    }

    const userEmail = env['MS_USER_EMAIL'] ?? '';

    if (reply_to_message_id) {
      // Create a reply draft — Graph auto-fills To, Subject, and conversation threading
      const replyDraft = await graphPost(
        `/users/${userEmail}/messages/${reply_to_message_id}/createReply`,
        { message: { body: { contentType: 'Text', content: body } } }
      );
      const replyTo = replyDraft.toRecipients?.[0]?.emailAddress?.address ?? to;
      const replySubject = replyDraft.subject ?? subject;
      return textResult(`Reply draft created: "${replySubject}" to ${replyTo} (ID: ${replyDraft.id?.slice(0, 20)}...)`);
    }

    // New draft (not a reply)
    const message: any = {
      subject,
      body: { contentType: 'Text', content: body },
      toRecipients: [{ emailAddress: { address: to } }],
    };
    if (cc) {
      message.ccRecipients = [{ emailAddress: { address: cc } }];
    }
    // POST to /messages (not /sendMail) creates a draft
    const draft = await graphPost(`/users/${userEmail}/messages`, message);
    return textResult(`Draft created: "${subject}" to ${to} (ID: ${draft.id?.slice(0, 20)}...)`);
  },
);

// ── 21. outlook_send ────────────────────────────────────────────────────

server.tool(
  'outlook_send',
  'Send an email from your Outlook account. REQUIRES owner approval (Tier 3).',
  {
    to: z.string().describe('Recipient email address'),
    subject: z.string().describe('Email subject line'),
    body: z.string().describe('Email body (plain text)'),
    cc: z.string().optional().describe('CC email address (optional)'),
  },
  async ({ to, subject, body, cc }) => {
    // Suppression check — prevent sending to opted-out recipients
    const store = await getStore();
    if ((store as any).isSuppressed(to)) {
      return textResult(`⛔ Cannot send email to ${to} — address is on the suppression list.`);
    }

    const userEmail = env['MS_USER_EMAIL'] ?? '';
    const message: any = {
      subject,
      body: { contentType: 'Text', content: body },
      toRecipients: [{ emailAddress: { address: to } }],
    };
    if (cc) {
      message.ccRecipients = [{ emailAddress: { address: cc } }];
    }
    await graphPost(`/users/${userEmail}/sendMail`, { message, saveToSentItems: true });

    // Log the send for daily cap tracking and audit
    const agentSlug = ACTIVE_AGENT_SLUG ?? 'clementine';
    (store as any).logSend({ agentSlug, recipient: to, subject });

    return textResult(`Email sent to ${to}: "${subject}"`);
  },
);

// ── 22. outlook_read_email ───────────────────────────────────────────────

server.tool(
  'outlook_read_email',
  'Read a full email by ID, including body and attachment list. Use this to inspect email attachments after finding emails with outlook_inbox or outlook_search.',
  {
    messageId: z.string().describe('The email message ID (from outlook_inbox or outlook_search)'),
  },
  async ({ messageId }) => {
    const userEmail = env['MS_USER_EMAIL'] ?? '';
    const data = await graphGet(
      `/users/${userEmail}/messages/${messageId}?$expand=attachments&$select=subject,from,body,receivedDateTime,hasAttachments`
    );

    // Format attachment info
    const attachments = (data.attachments ?? []).map((att: any) => ({
      name: att.name,
      contentType: att.contentType,
      size: att.size,
      isImage: att.contentType?.startsWith('image/') ?? false,
    }));

    // Strip HTML tags from body
    const bodyText = (data.body?.content ?? '(no body)').replace(/<[^>]*>/g, '');

    const result = {
      subject: data.subject ?? '(no subject)',
      from: data.from?.emailAddress?.address ?? 'unknown',
      receivedAt: data.receivedDateTime,
      body: bodyText.slice(0, 3000),
      attachments: attachments.length > 0
        ? attachments.map((a: any) =>
            `- ${a.name} (${a.contentType}, ${Math.round(a.size / 1024)}KB)${a.isImage ? ' [image — use analyze_image to view]' : ''}`
          ).join('\n')
        : '(none)',
    };

    return externalResult(JSON.stringify(result, null, 2));
  },
);


// ── Discord Channel Read ────────────────────────────────────────────────

server.tool(
  'discord_channel_read',
  'Read recent messages from a Discord text channel. Use to monitor agent output, review drafts, or audit channel activity.',
  {
    channel_id: z.string().describe('Discord channel ID to read from'),
    limit: z.number().min(1).max(100).optional().describe('Number of messages to fetch (default: 20, max: 100)'),
    before: z.string().optional().describe('Fetch messages before this message ID (for pagination)'),
  },
  async ({ channel_id, limit, before }) => {
    const token = env['DISCORD_TOKEN'] ?? '';
    if (!token) throw new Error('DISCORD_TOKEN not configured');
    if (!channel_id) throw new Error('channel_id is required');

    const params = new URLSearchParams();
    params.set('limit', String(limit ?? 20));
    if (before) params.set('before', before);

    const res = await fetch(
      `https://discord.com/api/v10/channels/${channel_id}/messages?${params}`,
      { headers: { Authorization: `Bot ${token}` } },
    );
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Discord API ${res.status}: ${errText}`);
    }

    const messages = (await res.json()) as Array<{
      id: string;
      author: { username: string; bot?: boolean };
      content: string;
      timestamp: string;
      embeds?: Array<{ title?: string; description?: string }>;
    }>;

    if (messages.length === 0) {
      return textResult('No messages found in this channel.');
    }

    // Format messages newest-first → reverse to chronological order
    const formatted = messages.reverse().map((m) => {
      const time = new Date(m.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      const tag = m.author.bot ? ` [BOT]` : '';
      let text = `[${time}] ${m.author.username}${tag}: ${m.content}`;
      // Include embed content (team messages, rich content)
      if (m.embeds?.length) {
        for (const embed of m.embeds) {
          if (embed.title) text += `\n  Embed: ${embed.title}`;
          if (embed.description) text += `\n  ${embed.description.slice(0, 500)}`;
        }
      }
      return text;
    });

    return textResult(
      `Channel messages (${messages.length}):\n\n${formatted.join('\n\n')}` +
      (messages.length === (limit ?? 20) ? `\n\n(Use before: "${messages[0].id}" to load older messages)` : ''),
    );
  },
);


// ── Discord Channel Send ────────────────────────────────────────────────

server.tool(
  'discord_channel_send',
  'Send a message to a Discord text channel by ID. For posting digests, summaries, or alerts to server channels.',
  {
    channel_id: z.string().describe('Discord channel ID to post to'),
    message: z.string().describe('Message content (Discord markdown, max 2000 chars per chunk)'),
  },
  async ({ channel_id, message }) => {
    const token = env['DISCORD_TOKEN'] ?? '';
    if (!token) throw new Error('DISCORD_TOKEN not configured');
    if (!channel_id) throw new Error('channel_id is required');

    const chunks: string[] = [];
    let remaining = message;
    while (remaining.length > 0) {
      if (remaining.length <= 1900) { chunks.push(remaining); break; }
      let splitAt = remaining.lastIndexOf('\n', 1900);
      if (splitAt === -1) splitAt = 1900;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).replace(/^\n+/, '');
    }

    for (const chunk of chunks) {
      const res = await fetch(`https://discord.com/api/v10/channels/${channel_id}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: chunk }),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Discord API ${res.status}: ${errText}`);
      }
    }
    return textResult(`Message posted to channel ${channel_id} (${chunks.length} chunk${chunks.length > 1 ? 's' : ''})`);
  },
);


// ── Discord Channel Send with Buttons ──────────────────────────────────

server.tool(
  'discord_channel_send_buttons',
  'Send a message to a Discord channel with approve/deny action buttons. Returns the message ID for tracking.',
  {
    channel_id: z.string().describe('Discord channel ID to post to'),
    message: z.string().describe('Message content (Discord markdown)'),
    approve_label: z.string().optional().describe('Label for approve button (default: Approve)'),
    deny_label: z.string().optional().describe('Label for deny button (default: Deny)'),
    custom_id_prefix: z.string().optional().describe('Prefix for button custom IDs (default: audit). Buttons will be {prefix}_approve and {prefix}_deny'),
  },
  async ({ channel_id, message, approve_label, deny_label, custom_id_prefix }) => {
    const token = env['DISCORD_TOKEN'] ?? '';
    if (!token) throw new Error('DISCORD_TOKEN not configured');
    if (!channel_id) throw new Error('channel_id is required');

    const prefix = custom_id_prefix ?? 'audit';

    const payload = {
      content: message.slice(0, 2000),
      components: [
        {
          type: 1, // ACTION_ROW
          components: [
            {
              type: 2, // BUTTON
              style: 3, // SUCCESS (green)
              label: approve_label ?? '✅ Approve',
              custom_id: `${prefix}_approve`,
            },
            {
              type: 2, // BUTTON
              style: 4, // DANGER (red)
              label: deny_label ?? '❌ Deny',
              custom_id: `${prefix}_deny`,
            },
          ],
        },
      ],
    };

    const res = await fetch(`https://discord.com/api/v10/channels/${channel_id}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Discord API ${res.status}: ${errText}`);
    }
    const msg = (await res.json()) as { id: string };
    return textResult(`Message with buttons posted to channel ${channel_id} (message ID: ${msg.id})`);
  },
);


// ── Discord Channel Create ─────────────────────────────────────────────

server.tool(
  'discord_channel_create',
  'Create a new Discord text channel in a guild/server. Requires Manage Channels permission.',
  {
    guild_id: z.string().describe('Discord guild/server ID'),
    channel_name: z.string().describe('Name for the new channel (lowercase, hyphens)'),
    topic: z.string().optional().describe('Optional channel topic/description'),
    category_id: z.string().optional().describe('Optional category ID to place the channel under'),
  },
  async ({ guild_id, channel_name, topic, category_id }) => {
    const token = env['DISCORD_TOKEN'] ?? '';
    if (!token) throw new Error('DISCORD_TOKEN not configured');

    const payload: Record<string, unknown> = {
      name: channel_name,
      type: 0, // GUILD_TEXT
    };
    if (topic) payload.topic = topic;
    if (category_id) payload.parent_id = category_id;

    const res = await fetch(`https://discord.com/api/v10/guilds/${guild_id}/channels`, {
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Discord API ${res.status}: ${errText}`);
    }
    const channel = (await res.json()) as { id: string; name: string };
    return textResult(`Created channel #${channel.name} (ID: ${channel.id}) in guild ${guild_id}`);
  },
);


// ── SDR Operational Tools ────────────────────────────────────────────────

server.tool(
  'lead_upsert',
  'Create or update a lead/prospect record. Updates existing if email matches.',
  {
    email: z.string().describe('Lead email address (unique identifier)'),
    name: z.string().describe('Lead full name'),
    company: z.string().optional().describe('Company name'),
    title: z.string().optional().describe('Job title'),
    status: z.enum(['new', 'contacted', 'replied', 'qualified', 'meeting_booked', 'won', 'lost', 'opted_out']).optional().describe('Lead status'),
    source: z.string().optional().describe('Lead source (e.g., inbound, outreach, referral)'),
    sfId: z.string().optional().describe('Salesforce lead/contact ID'),
    metadata: z.record(z.string(), z.unknown()).optional().describe('Additional metadata as key-value pairs'),
  },
  async ({ email, name, company, title, status, source, sfId, metadata }) => {
    const store = await getStore();
    const agentSlug = ACTIVE_AGENT_SLUG ?? 'clementine';
    const result = (store as any).upsertLead({
      agentSlug, email, name, company, title, status, source, sfId, metadata,
    });
    return textResult(result.created
      ? `Lead created: ${name} <${email}> (ID: ${result.id})`
      : `Lead updated: ${name} <${email}> (ID: ${result.id})`);
  },
);

server.tool(
  'lead_search',
  'Search leads/prospects by status, company, or keyword. Returns structured lead records.',
  {
    status: z.enum(['new', 'contacted', 'replied', 'qualified', 'meeting_booked', 'won', 'lost', 'opted_out']).optional().describe('Filter by lead status'),
    company: z.string().optional().describe('Filter by company name (partial match)'),
    query: z.string().optional().describe('Search across name, email, company'),
    limit: z.number().optional().default(20).describe('Max results (default 20)'),
  },
  async ({ status, company, query, limit }) => {
    const store = await getStore();
    const agentSlug = ACTIVE_AGENT_SLUG ?? undefined;
    const results = (store as any).searchLeads({ agentSlug, status, company, query, limit });
    if (results.length === 0) return textResult('No leads found matching criteria.');
    return textResult(JSON.stringify(results, null, 2));
  },
);

server.tool(
  'sequence_enroll',
  'Enroll a lead in an outbound email sequence/cadence.',
  {
    leadId: z.number().describe('Lead ID to enroll'),
    sequenceName: z.string().describe('Name of the sequence (e.g., "intro-5step")'),
    nextStepDueAt: z.string().optional().describe('ISO datetime for first step (default: now)'),
  },
  async ({ leadId, sequenceName, nextStepDueAt }) => {
    const store = await getStore();
    const lead = (store as any).getLeadById(leadId);
    if (!lead) return textResult(`Error: Lead ID ${leadId} not found.`);
    const id = (store as any).enrollSequence({ leadId, sequenceName, nextStepDueAt });
    return textResult(`Enrolled lead ${lead.name} (${lead.email}) in sequence "${sequenceName}" (enrollment ID: ${id})`);
  },
);

server.tool(
  'sequence_advance',
  'Advance a sequence enrollment to the next step or update its status.',
  {
    enrollmentId: z.number().describe('Sequence enrollment ID'),
    currentStep: z.number().optional().describe('Set current step number'),
    status: z.enum(['active', 'paused', 'replied', 'completed', 'opted_out']).optional().describe('Update enrollment status'),
    nextStepDueAt: z.string().optional().describe('ISO datetime for next step (null to clear)'),
  },
  async ({ enrollmentId, currentStep, status, nextStepDueAt }) => {
    const store = await getStore();
    (store as any).advanceSequence(enrollmentId, {
      currentStep, status, nextStepDueAt: nextStepDueAt ?? undefined,
    });
    const updates = [
      currentStep !== undefined ? `step → ${currentStep}` : null,
      status ? `status → ${status}` : null,
      nextStepDueAt ? `next due → ${nextStepDueAt}` : null,
    ].filter(Boolean).join(', ');
    return textResult(`Enrollment ${enrollmentId} updated: ${updates}`);
  },
);

server.tool(
  'sequence_due',
  'Get all sequence enrollments with steps due now (for cron processing).',
  { _empty: z.string().optional().describe('(no parameters needed)') },
  async () => {
    const store = await getStore();
    const agentSlug = ACTIVE_AGENT_SLUG ?? undefined;
    const due = (store as any).getDueSequences(agentSlug);
    if (due.length === 0) return textResult('No sequence steps due right now.');
    return textResult(`${due.length} due sequence step(s):\n` + JSON.stringify(due, null, 2));
  },
);

server.tool(
  'activity_log',
  'Record an SDR activity (email sent, meeting booked, call, note, etc.).',
  {
    type: z.enum(['email_sent', 'email_received', 'meeting_booked', 'call', 'note', 'status_change']).describe('Activity type'),
    leadId: z.number().optional().describe('Lead ID this activity relates to'),
    subject: z.string().optional().describe('Activity subject/title'),
    detail: z.string().optional().describe('Activity details or notes'),
    templateUsed: z.string().optional().describe('Email template used (if applicable)'),
  },
  async ({ type, leadId, subject, detail, templateUsed }) => {
    const store = await getStore();
    const agentSlug = ACTIVE_AGENT_SLUG ?? 'clementine';
    const id = (store as any).logActivity({ leadId, agentSlug, type, subject, detail, templateUsed });
    return textResult(`Activity logged: ${type}${subject ? ` — "${subject}"` : ''} (ID: ${id})`);
  },
);

server.tool(
  'activity_history',
  'Get activity history for a lead or agent.',
  {
    leadId: z.number().optional().describe('Filter by lead ID'),
    type: z.enum(['email_sent', 'email_received', 'meeting_booked', 'call', 'note', 'status_change']).optional().describe('Filter by activity type'),
    limit: z.number().optional().default(20).describe('Max results'),
  },
  async ({ leadId, type, limit }) => {
    const store = await getStore();
    const agentSlug = ACTIVE_AGENT_SLUG ?? undefined;
    const results = (store as any).getActivities({ leadId, agentSlug, type, limit });
    if (results.length === 0) return textResult('No activities found.');
    return textResult(JSON.stringify(results, null, 2));
  },
);

server.tool(
  'suppression_check',
  'Check if an email address is on the suppression (do-not-contact) list.',
  {
    email: z.string().describe('Email address to check'),
  },
  async ({ email }) => {
    const store = await getStore();
    const suppressed = (store as any).isSuppressed(email);
    return textResult(suppressed
      ? `⛔ ${email} is SUPPRESSED — do not contact.`
      : `✓ ${email} is not on the suppression list.`);
  },
);

server.tool(
  'suppression_add',
  'Add an email to the suppression (do-not-contact) list.',
  {
    email: z.string().describe('Email address to suppress'),
    reason: z.enum(['unsubscribe', 'bounce', 'manual', 'complaint']).describe('Reason for suppression'),
  },
  async ({ email, reason }) => {
    const store = await getStore();
    const agentSlug = ACTIVE_AGENT_SLUG ?? 'manual';
    (store as any).addSuppression(email, reason, agentSlug);
    return textResult(`Added ${email} to suppression list (reason: ${reason}).`);
  },
);

server.tool(
  'lead_import',
  'Bulk import leads from CSV-style data. Each line: name,email,company,title. Skips duplicates by email.',
  {
    data: z.string().describe('CSV data — one lead per line: name,email,company,title. First line can be a header (auto-detected).'),
    source: z.string().optional().default('import').describe('Lead source tag (e.g., "csv-import", "list-purchase")'),
    sequenceName: z.string().optional().describe('If provided, auto-enroll each imported lead in this sequence'),
  },
  async ({ data, source, sequenceName }) => {
    const store = await getStore();
    const agentSlug = ACTIVE_AGENT_SLUG ?? 'clementine';
    const lines = data.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return textResult('No data to import.');

    // Detect and skip header row
    const firstLine = lines[0].toLowerCase();
    const startIdx = (firstLine.includes('name') && firstLine.includes('email')) ? 1 : 0;

    let created = 0;
    let skipped = 0;
    let enrolled = 0;
    const errors: string[] = [];

    for (let i = startIdx; i < lines.length; i++) {
      const parts = lines[i].split(',').map(s => s.trim().replace(/^"|"$/g, ''));
      if (parts.length < 2) { errors.push(`Line ${i + 1}: not enough fields`); continue; }

      const [name, email, company, title] = parts;
      if (!name || !email || !email.includes('@')) { errors.push(`Line ${i + 1}: invalid name or email`); continue; }

      try {
        const result = (store as any).upsertLead({
          agentSlug, email, name, company: company || undefined, title: title || undefined,
          source, status: 'new',
        });

        if (result.created) {
          created++;
          // Auto-enroll in sequence if specified
          if (sequenceName) {
            const nextDue = new Date(Date.now() + 60000).toISOString(); // due in 1 min
            (store as any).enrollSequence({ leadId: result.id, sequenceName, nextStepDueAt: nextDue });
            enrolled++;
          }
        } else {
          skipped++;
        }
      } catch (e) {
        errors.push(`Line ${i + 1}: ${String(e)}`);
      }
    }

    let report = `Import complete: ${created} created, ${skipped} skipped (duplicate)`;
    if (enrolled > 0) report += `, ${enrolled} enrolled in "${sequenceName}"`;
    if (errors.length > 0) report += `\n\nErrors (${errors.length}):\n${errors.slice(0, 10).join('\n')}`;
    return textResult(report);
  },
);

server.tool(
  'approval_queue_add',
  'Queue an action for human approval via the dashboard. Use this when your send policy requires approval, or when you want a human to review before executing.',
  {
    actionType: z.enum(['email_send', 'sequence_start', 'escalation']).describe('Type of action being queued'),
    summary: z.string().describe('Brief description shown in the approval queue (e.g., "Send intro email to jane@acme.com")'),
    detail: z.record(z.string(), z.unknown()).optional().describe('Full action payload — for email_send: {to, subject, body, cc?, leadId?}'),
  },
  async ({ actionType, summary, detail }) => {
    const store = await getStore();
    const agentSlug = ACTIVE_AGENT_SLUG ?? 'clementine';
    const id = (store as any).addApproval({ agentSlug, actionType, summary, detail });
    return textResult(`Queued for approval (ID: ${id}): ${summary}\nA human can approve or reject this via the dashboard.`);
  },
);


// ── Salesforce REST API ──────────────────────────────────────────────────

let sfToken: { accessToken: string; instanceUrl: string; expiresAt: number } | null = null;

function sfConfigured(): boolean {
  return Boolean(env['SF_INSTANCE_URL'] && env['SF_CLIENT_ID'] && env['SF_CLIENT_SECRET']);
}

async function getSfToken(): Promise<{ accessToken: string; instanceUrl: string }> {
  const instanceUrl = env['SF_INSTANCE_URL'] ?? '';
  const clientId = env['SF_CLIENT_ID'] ?? '';
  const clientSecret = env['SF_CLIENT_SECRET'] ?? '';
  const username = env['SF_USERNAME'] ?? '';
  const password = env['SF_PASSWORD'] ?? '';

  if (!instanceUrl || !clientId || !clientSecret) {
    throw new Error('Salesforce not configured — set SF_INSTANCE_URL, SF_CLIENT_ID, SF_CLIENT_SECRET, SF_USERNAME, SF_PASSWORD in .env');
  }

  if (sfToken && Date.now() < sfToken.expiresAt - 300_000) {
    return { accessToken: sfToken.accessToken, instanceUrl: sfToken.instanceUrl };
  }

  // Sandbox detection
  const loginHost = instanceUrl.includes('.sandbox.') || instanceUrl.includes('--')
    ? 'https://test.salesforce.com' : 'https://login.salesforce.com';

  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: clientId,
    client_secret: clientSecret,
    username,
    password,
  });

  const res = await fetch(`${loginHost}/services/oauth2/token`, { method: 'POST', body });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Salesforce token request failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { access_token: string; instance_url: string };
  sfToken = {
    accessToken: data.access_token,
    instanceUrl: data.instance_url,
    expiresAt: Date.now() + 7200_000, // SF tokens typically valid ~2 hours
  };
  return { accessToken: sfToken.accessToken, instanceUrl: sfToken.instanceUrl };
}

const SF_API_VERSION = env['SF_API_VERSION'] || 'v62.0';

async function sfRequest(method: string, endpoint: string, body?: unknown, retry = true): Promise<any> {
  const { accessToken, instanceUrl } = await getSfToken();
  const url = `${instanceUrl}/services/data/${SF_API_VERSION}${endpoint}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
  const opts: RequestInit = { method, headers };
  if (body) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);

  // Parse API usage from Sforce-Limit-Info header
  const limitInfo = res.headers.get('Sforce-Limit-Info');
  if (limitInfo) {
    const match = limitInfo.match(/api-usage=(\d+)\/(\d+)/);
    if (match) {
      const [, used, total] = match;
      const pct = (Number(used) / Number(total)) * 100;
      if (pct >= 80) logger.warn(`Salesforce API usage at ${pct.toFixed(0)}% (${used}/${total})`);
    }
  }

  // Retry on 401 (expired token)
  if (res.status === 401 && retry) {
    sfToken = null;
    return sfRequest(method, endpoint, body, false);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Salesforce ${method} ${endpoint} failed (${res.status}): ${text}`);
  }

  // 204 No Content (PATCH success)
  if (res.status === 204) return { success: true };
  return res.json();
}

async function sfGet(endpoint: string): Promise<any> { return sfRequest('GET', endpoint); }
async function sfPost(endpoint: string, body: unknown): Promise<any> { return sfRequest('POST', endpoint, body); }
async function sfPatch(endpoint: string, body: unknown): Promise<any> { return sfRequest('PATCH', endpoint, body); }

async function sfQuery(soql: string): Promise<any> {
  return sfGet(`/query?q=${encodeURIComponent(soql)}`);
}

// Status mapping: local → Salesforce
const LOCAL_TO_SF_STATUS: Record<string, string> = {
  'new': 'Open - Not Contacted',
  'contacted': 'Working - Contacted',
  'replied': 'Working - Contacted',
  'qualified': 'Qualified',
  'meeting_booked': 'Qualified',
  'won': 'Closed - Converted',
  'lost': 'Closed - Not Converted',
  'opted_out': 'Closed - Not Converted',
};

// Status mapping: Salesforce → local
const SF_TO_LOCAL_STATUS: Record<string, string> = {
  'Open - Not Contacted': 'new',
  'Working - Contacted': 'contacted',
  'Qualified': 'qualified',
  'Closed - Converted': 'won',
  'Closed - Not Converted': 'lost',
};

function splitName(fullName: string): { FirstName: string; LastName: string } {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { FirstName: '', LastName: parts[0] };
  const LastName = parts.pop()!;
  return { FirstName: parts.join(' '), LastName };
}

function joinName(first?: string, last?: string): string {
  return [first, last].filter(Boolean).join(' ') || 'Unknown';
}

// ── sf_lead_push ─────────────────────────────────────────────────────────

server.tool(
  'sf_lead_push',
  'Push a local lead to Salesforce. Creates a new SF Lead or updates existing if the lead already has a Salesforce ID.',
  {
    leadId: z.number().describe('Local lead ID to push to Salesforce'),
  },
  async ({ leadId }) => {
    if (!sfConfigured()) return textResult('Salesforce not configured — set SF_INSTANCE_URL, SF_CLIENT_ID, SF_CLIENT_SECRET, SF_USERNAME, SF_PASSWORD in .env');
    const store = await getStore();
    const lead = (store as any).getLeadById(leadId) as Record<string, unknown> | undefined;
    if (!lead) return textResult(`Lead ID ${leadId} not found`);

    const { FirstName, LastName } = splitName(String(lead.name ?? ''));
    const sfData: Record<string, unknown> = {
      FirstName,
      LastName,
      Email: lead.email,
      Company: lead.company || '[Unknown]',
      Title: lead.title || undefined,
      Status: LOCAL_TO_SF_STATUS[String(lead.status ?? 'new')] || 'Open - Not Contacted',
      LeadSource: lead.source || undefined,
    };
    // Remove undefined values
    for (const k of Object.keys(sfData)) { if (sfData[k] === undefined) delete sfData[k]; }

    try {
      if (lead.sf_id) {
        await sfPatch(`/sobjects/Lead/${lead.sf_id}`, sfData);
        (store as any).logSfSync({ localTable: 'leads', localId: leadId, sfObjectType: 'Lead', sfId: String(lead.sf_id), syncDirection: 'push' });
        return textResult(`Updated Salesforce Lead ${lead.sf_id} for ${lead.name} <${lead.email}>`);
      } else {
        const result = await sfPost('/sobjects/Lead', sfData);
        const sfId = result.id;
        (store as any).upsertLead({ agentSlug: String(lead.agent_slug), email: String(lead.email), name: String(lead.name), sfId });
        (store as any).logSfSync({ localTable: 'leads', localId: leadId, sfObjectType: 'Lead', sfId, syncDirection: 'push' });
        return textResult(`Created Salesforce Lead ${sfId} for ${lead.name} <${lead.email}>`);
      }
    } catch (err) {
      (store as any).logSfSync({ localTable: 'leads', localId: leadId, sfObjectType: 'Lead', sfId: String(lead.sf_id ?? ''), syncDirection: 'push', syncStatus: 'error', errorMessage: String(err) });
      return textResult(`Error pushing lead to Salesforce: ${err}`);
    }
  },
);

// ── sf_lead_pull ─────────────────────────────────────────────────────────

server.tool(
  'sf_lead_pull',
  'Pull a Salesforce Lead or Contact into the local lead database by Salesforce ID or email address.',
  {
    sfId: z.string().optional().describe('Salesforce Lead/Contact ID'),
    email: z.string().optional().describe('Email address to search in Salesforce'),
  },
  async ({ sfId, email }) => {
    if (!sfConfigured()) return textResult('Salesforce not configured — set SF_INSTANCE_URL, SF_CLIENT_ID, SF_CLIENT_SECRET, SF_USERNAME, SF_PASSWORD in .env');
    if (!sfId && !email) return textResult('Provide either sfId or email');

    try {
      let record: Record<string, unknown> | null = null;
      let objectType = 'Lead';

      if (sfId) {
        // Try Lead first, then Contact
        try {
          record = await sfGet(`/sobjects/Lead/${sfId}`);
        } catch {
          record = await sfGet(`/sobjects/Contact/${sfId}`);
          objectType = 'Contact';
        }
      } else if (email) {
        const soql = `SELECT Id, FirstName, LastName, Email, Company, Title, Status, LeadSource FROM Lead WHERE Email = '${email.replace(/'/g, "\\'")}'  LIMIT 1`;
        const result = await sfQuery(soql);
        if (result.records?.length > 0) {
          record = result.records[0];
        } else {
          const contactSoql = `SELECT Id, FirstName, LastName, Email, Account.Name, Title FROM Contact WHERE Email = '${email.replace(/'/g, "\\'")}'  LIMIT 1`;
          const contactResult = await sfQuery(contactSoql);
          if (contactResult.records?.length > 0) {
            record = contactResult.records[0];
            objectType = 'Contact';
          }
        }
      }

      if (!record) return textResult(`No Salesforce Lead or Contact found for ${sfId || email}`);

      const store = await getStore();
      const agentSlug = ACTIVE_AGENT_SLUG ?? 'clementine';
      const name = joinName(record.FirstName as string, record.LastName as string);
      const company = objectType === 'Contact'
        ? (record.Account as Record<string, unknown>)?.Name as string ?? ''
        : (record.Company as string) ?? '';
      const localStatus = SF_TO_LOCAL_STATUS[String(record.Status ?? '')] || 'new';

      const upsertResult = (store as any).upsertLead({
        agentSlug,
        email: String(record.Email ?? email ?? ''),
        name,
        company,
        title: record.Title as string,
        status: localStatus,
        source: record.LeadSource as string,
        sfId: String(record.Id),
      });

      (store as any).logSfSync({
        localTable: 'leads', localId: upsertResult.id,
        sfObjectType: objectType, sfId: String(record.Id), syncDirection: 'pull',
      });

      return textResult(
        `${upsertResult.created ? 'Created' : 'Updated'} local lead from Salesforce ${objectType} ${record.Id}:\n` +
        `  Name: ${name}\n  Email: ${record.Email}\n  Company: ${company}\n  Status: ${localStatus}`
      );
    } catch (err) {
      return textResult(`Error pulling from Salesforce: ${err}`);
    }
  },
);

// ── sf_contact_search ────────────────────────────────────────────────────

server.tool(
  'sf_contact_search',
  'Search Salesforce Leads and/or Contacts by name, email, or company.',
  {
    query: z.string().describe('Search keyword (name, email, or company)'),
    objectType: z.enum(['Lead', 'Contact', 'Both']).optional().default('Both').describe('Which SF object type to search'),
    limit: z.number().optional().default(10).describe('Max results to return'),
  },
  async ({ query, objectType, limit }) => {
    if (!sfConfigured()) return textResult('Salesforce not configured — set SF_INSTANCE_URL, SF_CLIENT_ID, SF_CLIENT_SECRET, SF_USERNAME, SF_PASSWORD in .env');

    try {
      const safeQuery = query.replace(/'/g, "\\'");
      const results: string[] = [];
      const maxResults = Math.min(limit, 50);

      if (objectType === 'Lead' || objectType === 'Both') {
        const soql = `SELECT Id, FirstName, LastName, Email, Company, Title, Status, LeadSource FROM Lead WHERE Name LIKE '%${safeQuery}%' OR Email LIKE '%${safeQuery}%' OR Company LIKE '%${safeQuery}%' LIMIT ${maxResults}`;
        const data = await sfQuery(soql);
        for (const r of data.records ?? []) {
          results.push(`[Lead] ${joinName(r.FirstName, r.LastName)} <${r.Email ?? 'no email'}> | ${r.Company ?? ''} | ${r.Title ?? ''} | Status: ${r.Status ?? ''} | ID: ${r.Id}`);
        }
      }

      if (objectType === 'Contact' || objectType === 'Both') {
        const soql = `SELECT Id, FirstName, LastName, Email, Account.Name, Title FROM Contact WHERE Name LIKE '%${safeQuery}%' OR Email LIKE '%${safeQuery}%' OR Account.Name LIKE '%${safeQuery}%' LIMIT ${maxResults}`;
        const data = await sfQuery(soql);
        for (const r of data.records ?? []) {
          const acct = (r.Account as Record<string, unknown>)?.Name ?? '';
          results.push(`[Contact] ${joinName(r.FirstName, r.LastName)} <${r.Email ?? 'no email'}> | ${acct} | ${r.Title ?? ''} | ID: ${r.Id}`);
        }
      }

      if (results.length === 0) return textResult(`No Salesforce records found matching "${query}"`);
      return textResult(`${EXTERNAL_CONTENT_TAG}\n\nSalesforce search results for "${query}" (${results.length} found):\n\n${results.join('\n')}`);
    } catch (err) {
      return textResult(`Error searching Salesforce: ${err}`);
    }
  },
);

// ── sf_opportunity_create ────────────────────────────────────────────────

server.tool(
  'sf_opportunity_create',
  'Create a new Opportunity in Salesforce, optionally linked to an Account or Contact.',
  {
    name: z.string().describe('Opportunity name'),
    stageName: z.string().describe('Sales stage (e.g., "Prospecting", "Qualification", "Closed Won")'),
    closeDate: z.string().describe('Expected close date (YYYY-MM-DD)'),
    amount: z.number().optional().describe('Deal amount in dollars'),
    accountId: z.string().optional().describe('Salesforce Account ID to link'),
    contactId: z.string().optional().describe('Salesforce Contact ID to add as Contact Role'),
  },
  async ({ name, stageName, closeDate, amount, accountId, contactId }) => {
    if (!sfConfigured()) return textResult('Salesforce not configured — set SF_INSTANCE_URL, SF_CLIENT_ID, SF_CLIENT_SECRET, SF_USERNAME, SF_PASSWORD in .env');

    try {
      const oppData: Record<string, unknown> = { Name: name, StageName: stageName, CloseDate: closeDate };
      if (amount !== undefined) oppData.Amount = amount;
      if (accountId) oppData.AccountId = accountId;

      const result = await sfPost('/sobjects/Opportunity', oppData);
      const oppId = result.id;
      let contactRoleMsg = '';

      // Link contact role if provided
      if (contactId) {
        try {
          await sfPost('/sobjects/OpportunityContactRole', {
            OpportunityId: oppId,
            ContactId: contactId,
            Role: 'Decision Maker',
          });
          contactRoleMsg = `\nLinked Contact ${contactId} as Decision Maker`;
        } catch (err) {
          contactRoleMsg = `\nWarning: Could not link Contact Role: ${err}`;
        }
      }

      return textResult(`Created Opportunity ${oppId}: "${name}" (${stageName}, close: ${closeDate}${amount ? `, $${amount}` : ''})${contactRoleMsg}`);
    } catch (err) {
      return textResult(`Error creating Opportunity: ${err}`);
    }
  },
);

// ── sf_opportunity_update ────────────────────────────────────────────────

server.tool(
  'sf_opportunity_update',
  'Update an existing Salesforce Opportunity (stage, amount, close date, etc.).',
  {
    sfId: z.string().describe('Salesforce Opportunity ID'),
    stageName: z.string().optional().describe('New sales stage'),
    amount: z.number().optional().describe('Updated deal amount'),
    closeDate: z.string().optional().describe('Updated close date (YYYY-MM-DD)'),
    description: z.string().optional().describe('Opportunity description/notes'),
  },
  async ({ sfId, stageName, amount, closeDate, description }) => {
    if (!sfConfigured()) return textResult('Salesforce not configured — set SF_INSTANCE_URL, SF_CLIENT_ID, SF_CLIENT_SECRET, SF_USERNAME, SF_PASSWORD in .env');

    try {
      const updates: Record<string, unknown> = {};
      if (stageName) updates.StageName = stageName;
      if (amount !== undefined) updates.Amount = amount;
      if (closeDate) updates.CloseDate = closeDate;
      if (description) updates.Description = description;

      if (Object.keys(updates).length === 0) return textResult('No fields to update');

      await sfPatch(`/sobjects/Opportunity/${sfId}`, updates);
      const fields = Object.entries(updates).map(([k, v]) => `${k}: ${v}`).join(', ');
      return textResult(`Updated Opportunity ${sfId}: ${fields}`);
    } catch (err) {
      return textResult(`Error updating Opportunity: ${err}`);
    }
  },
);

// ── sf_activity_log ──────────────────────────────────────────────────────

server.tool(
  'sf_activity_log',
  'Log an activity (Task) to Salesforce linked to a Lead or Contact. Use this to record calls, emails, meetings, etc.',
  {
    sfWhoId: z.string().describe('Salesforce Lead or Contact ID to link the activity to'),
    subject: z.string().describe('Activity subject line'),
    description: z.string().optional().describe('Activity description/notes'),
    type: z.enum(['Call', 'Email', 'Meeting', 'Other']).optional().default('Other').describe('Activity type'),
    status: z.enum(['Completed', 'Not Started', 'In Progress']).optional().default('Completed').describe('Task status'),
    activityDate: z.string().optional().describe('Activity date (YYYY-MM-DD, defaults to today)'),
  },
  async ({ sfWhoId, subject, description, type, status, activityDate }) => {
    if (!sfConfigured()) return textResult('Salesforce not configured — set SF_INSTANCE_URL, SF_CLIENT_ID, SF_CLIENT_SECRET, SF_USERNAME, SF_PASSWORD in .env');

    try {
      const taskData: Record<string, unknown> = {
        WhoId: sfWhoId,
        Subject: subject,
        Status: status,
        Type: type,
        ActivityDate: activityDate || new Date().toISOString().slice(0, 10),
      };
      if (description) taskData.Description = description;

      const result = await sfPost('/sobjects/Task', taskData);
      return textResult(`Logged ${type} activity to Salesforce (Task ID: ${result.id}): "${subject}" for ${sfWhoId}`);
    } catch (err) {
      return textResult(`Error logging activity to Salesforce: ${err}`);
    }
  },
);

// ── sf_sync ──────────────────────────────────────────────────────────────

server.tool(
  'sf_sync',
  'Run a bidirectional sync between local leads and Salesforce. Pushes unsynced/modified local leads to SF and pulls recently modified SF leads into the local database.',
  {
    direction: z.enum(['push', 'pull', 'both']).optional().default('both').describe('Sync direction'),
    agentSlug: z.string().optional().describe('Only sync leads for this agent'),
    dryRun: z.boolean().optional().default(false).describe('Preview sync without making changes'),
  },
  async ({ direction, agentSlug, dryRun }) => {
    if (!sfConfigured()) return textResult('Salesforce not configured — set SF_INSTANCE_URL, SF_CLIENT_ID, SF_CLIENT_SECRET, SF_USERNAME, SF_PASSWORD in .env');

    const store = await getStore();
    const slug = agentSlug ?? ACTIVE_AGENT_SLUG ?? undefined;
    const summary = { pushed: 0, pulled: 0, errors: 0, details: [] as string[] };

    try {
      // ── Push phase ──
      if (direction === 'push' || direction === 'both') {
        // Get unsynced leads
        const unsynced = (store as any).getUnsyncedLeads(slug) as Array<Record<string, unknown>>;
        // Get recently modified leads that have sfId (need re-push)
        const lastSync = (store as any).getSfSyncHistory({ limit: 1 }) as Array<Record<string, unknown>>;
        const since = lastSync.length > 0 ? String(lastSync[0].synced_at) : '1970-01-01T00:00:00Z';
        const modified = ((store as any).getLeadsModifiedSince(since, slug) as Array<Record<string, unknown>>)
          .filter((l: Record<string, unknown>) => l.sf_id);

        const toPush = [...unsynced, ...modified].slice(0, 200); // Batch limit

        for (const lead of toPush) {
          const leadId = Number(lead.id);
          const { FirstName, LastName } = splitName(String(lead.name ?? ''));
          const sfData: Record<string, unknown> = {
            FirstName, LastName,
            Email: lead.email,
            Company: lead.company || '[Unknown]',
            Title: lead.title || undefined,
            Status: LOCAL_TO_SF_STATUS[String(lead.status ?? 'new')] || 'Open - Not Contacted',
            LeadSource: lead.source || undefined,
          };
          for (const k of Object.keys(sfData)) { if (sfData[k] === undefined) delete sfData[k]; }

          if (dryRun) {
            summary.pushed++;
            summary.details.push(`[DRY RUN] Would push ${lead.name} <${lead.email}> (${lead.sf_id ? 'update' : 'create'})`);
            continue;
          }

          try {
            if (lead.sf_id) {
              await sfPatch(`/sobjects/Lead/${lead.sf_id}`, sfData);
              (store as any).logSfSync({ localTable: 'leads', localId: leadId, sfObjectType: 'Lead', sfId: String(lead.sf_id), syncDirection: 'push' });
            } else {
              const result = await sfPost('/sobjects/Lead', sfData);
              (store as any).upsertLead({ agentSlug: String(lead.agent_slug), email: String(lead.email), name: String(lead.name), sfId: result.id });
              (store as any).logSfSync({ localTable: 'leads', localId: leadId, sfObjectType: 'Lead', sfId: result.id, syncDirection: 'push' });
            }
            summary.pushed++;
            summary.details.push(`Pushed ${lead.name} <${lead.email}>`);
          } catch (err) {
            summary.errors++;
            summary.details.push(`Error pushing ${lead.email}: ${err}`);
            (store as any).logSfSync({ localTable: 'leads', localId: leadId, sfObjectType: 'Lead', sfId: String(lead.sf_id ?? ''), syncDirection: 'push', syncStatus: 'error', errorMessage: String(err) });
          }
        }
      }

      // ── Pull phase ──
      if (direction === 'pull' || direction === 'both') {
        const lastSync = (store as any).getSfSyncHistory({ limit: 1 }) as Array<Record<string, unknown>>;
        const since = lastSync.length > 0 ? String(lastSync[0].synced_at) : '1970-01-01T00:00:00Z';
        const sinceFormatted = since.replace('T', 'T').replace(' ', 'T');

        const soql = `SELECT Id, FirstName, LastName, Email, Company, Title, Status, LeadSource, SystemModstamp FROM Lead WHERE SystemModstamp > ${sinceFormatted} AND Email != null ORDER BY SystemModstamp ASC LIMIT 200`;

        try {
          const data = await sfQuery(soql);
          const pullSlug = slug ?? 'clementine';

          for (const record of data.records ?? []) {
            const name = joinName(record.FirstName, record.LastName);
            const localStatus = SF_TO_LOCAL_STATUS[String(record.Status ?? '')] || 'new';

            if (dryRun) {
              summary.pulled++;
              summary.details.push(`[DRY RUN] Would pull ${name} <${record.Email}> (SF ID: ${record.Id})`);
              continue;
            }

            try {
              const upsertResult = (store as any).upsertLead({
                agentSlug: pullSlug,
                email: String(record.Email),
                name,
                company: record.Company ?? '',
                title: record.Title,
                status: localStatus,
                source: record.LeadSource,
                sfId: String(record.Id),
              });
              (store as any).logSfSync({
                localTable: 'leads', localId: upsertResult.id,
                sfObjectType: 'Lead', sfId: String(record.Id), syncDirection: 'pull',
              });
              summary.pulled++;
              summary.details.push(`Pulled ${name} <${record.Email}>`);
            } catch (err) {
              summary.errors++;
              summary.details.push(`Error pulling ${record.Email}: ${err}`);
            }
          }
        } catch (err) {
          summary.errors++;
          summary.details.push(`Error querying Salesforce: ${err}`);
        }
      }

      const prefix = dryRun ? '[DRY RUN] ' : '';
      return textResult(
        `${prefix}Salesforce sync complete:\n` +
        `  Pushed: ${summary.pushed}\n  Pulled: ${summary.pulled}\n  Errors: ${summary.errors}\n\n` +
        (summary.details.length > 0 ? `Details:\n${summary.details.map(d => `  • ${d}`).join('\n')}` : 'No records to sync.')
      );
    } catch (err) {
      return textResult(`Salesforce sync failed: ${err}`);
    }
  },
);


}
