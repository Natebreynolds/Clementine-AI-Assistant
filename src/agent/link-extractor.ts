/**
 * Clementine TypeScript — Proactive link understanding.
 *
 * Extracts URLs from user messages, fetches their content, and returns
 * readable text so the agent has context without needing a tool call.
 */

import { LINK_EXTRACT_MAX_URLS, LINK_EXTRACT_MAX_CHARS } from '../config.js';
import { PRIVATE_URL_PATTERNS } from './hooks.js';

export interface LinkContext {
  url: string;
  title: string;
  content: string;
  error?: string;
}

// Match https:// URLs, skip common image/video/audio extensions
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const SKIP_EXT_RE = /\.(png|jpg|jpeg|gif|webp|svg|ico|mp4|mp3|wav|webm|avi|mov|pdf)(\?[^\s]*)?$/i;

/** Strip HTML tags of a given type (including content). */
function stripTags(html: string, ...tags: string[]): string {
  let result = html;
  for (const tag of tags) {
    result = result.replace(new RegExp(`<${tag}[\\s>][\\s\\S]*?</${tag}>`, 'gi'), '');
  }
  return result;
}

/** Extract the <title> text from HTML. */
function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? match[1].replace(/\s+/g, ' ').trim() : '';
}

/** Check if a URL targets a private/internal network. */
function isPrivateUrl(url: string): boolean {
  return PRIVATE_URL_PATTERNS.some(p => p.test(url));
}

async function fetchLink(url: string): Promise<LinkContext> {
  if (isPrivateUrl(url)) {
    return { url, title: '', content: '', error: 'private/internal URL blocked' };
  }

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Clementine/1.0' },
      signal: AbortSignal.timeout(10_000),
      redirect: 'follow',
    });

    if (!response.ok) {
      return { url, title: '', content: '', error: `HTTP ${response.status}` };
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      return { url, title: '', content: '', error: `unsupported content-type: ${contentType}` };
    }

    const html = await response.text();
    const title = extractTitle(html);

    // Strip non-content tags, then all remaining HTML
    let text = stripTags(html, 'script', 'style', 'nav', 'footer', 'header', 'aside');
    text = text.replace(/<[^>]+>/g, ' ');
    // Collapse whitespace
    text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    // Truncate
    if (text.length > LINK_EXTRACT_MAX_CHARS) {
      text = text.slice(0, LINK_EXTRACT_MAX_CHARS) + '…';
    }

    return { url, title, content: text };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { url, title: '', content: '', error: message };
  }
}

/**
 * Extract and fetch URLs found in the given text.
 * Returns content for up to LINK_EXTRACT_MAX_URLS unique URLs.
 * Never throws — errors are captured per-URL.
 */
export async function extractLinks(text: string): Promise<LinkContext[]> {
  const matches = text.match(URL_RE);
  if (!matches) return [];

  // Deduplicate and filter
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const raw of matches) {
    // Strip trailing punctuation that's likely not part of the URL
    const url = raw.replace(/[.,;:!?)]+$/, '');
    if (seen.has(url) || SKIP_EXT_RE.test(url)) continue;
    seen.add(url);
    urls.push(url);
    if (urls.length >= LINK_EXTRACT_MAX_URLS) break;
  }

  if (!urls.length) return [];

  return Promise.all(urls.map(fetchLink));
}
