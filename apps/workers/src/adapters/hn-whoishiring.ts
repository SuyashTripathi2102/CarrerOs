/**
 * Hacker News "Ask HN: Who is hiring?" — the highest-signal free source of
 * software jobs there is. A monthly thread whose top-level comments are each a
 * job posting from a company actively hiring engineers. Official public API
 * (Algolia), zero ToS risk.
 *
 * Parsing is conservative on purpose: these comments are free text. We only
 * emit a job when we can confidently pull a company and a role, and we keep
 * only remote or India-relevant postings so the pipeline isn't flooded with
 * US-onsite roles the user can't act on. The classifier + matcher do the rest.
 */
import type { BoardJob } from '@careeros/shared';
import { capDescription, fetchJson } from './types';

interface AlgoliaStory {
  objectID: string;
  title: string;
  created_at: string;
}
interface AlgoliaSearch {
  hits: AlgoliaStory[];
}
interface AlgoliaItem {
  id: number;
  title?: string;
  children?: AlgoliaComment[];
}
interface AlgoliaComment {
  id: number;
  author?: string;
  text?: string | null;
}

/** The most recent "Who is hiring?" thread, posted monthly by whoishiring. */
async function latestThreadId(): Promise<string | null> {
  const res = await fetchJson<AlgoliaSearch>(
    'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&query=who%20is%20hiring&hitsPerPage=5',
  );
  const hit = res.hits.find((h) => /who is hiring/i.test(h.title));
  return hit?.objectID ?? null;
}

const stripHtml = (html: string) =>
  html
    .replace(/<a[^>]*href="([^"]+)"[^>]*>.*?<\/a>/gi, ' $1 ') // keep the URL text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x2F;/g, '/')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

const firstUrl = (text: string): string | null =>
  text.match(/https?:\/\/[^\s)|]+/i)?.[0]?.replace(/[.,]$/, '') ?? null;

/** A dev role we'd actually surface — filters out non-eng and non-actionable. */
function isRelevant(text: string): boolean {
  const t = text.toLowerCase();
  const eng = /engineer|developer|\bsde\b|programmer|full.?stack|back.?end|front.?end|software/.test(t);
  const actionable = /remote|india|bangalore|bengaluru|mumbai|pune|hyderabad|delhi|gurgaon|noida|worldwide|anywhere/.test(t);
  return eng && actionable;
}

/**
 * Parse one top-level comment into a BoardJob. HN convention: the first line is
 * a header like "Company | Role | Location | REMOTE | ...". Returns null when we
 * cannot confidently extract a company + role.
 */
function parseComment(c: AlgoliaComment): BoardJob | null {
  if (!c.text) return null;
  const text = stripHtml(c.text);
  if (text.length < 60 || !isRelevant(text)) return null;

  // The header is the first pipe-delimited line; fall back to the first sentence.
  const headerLine = c.text.split(/<p>|\n/)[0] ?? text;
  const header = stripHtml(headerLine);
  const parts = header.split('|').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  const company = parts[0].replace(/^\W+|\W+$/g, '').slice(0, 120);
  // The role is the first segment that reads like a title, else the 2nd segment.
  const roleSeg =
    parts.find((p) => /engineer|developer|\bsde\b|full.?stack|back.?end|front.?end|software|lead|architect/i.test(p)) ??
    parts[1];
  const title = roleSeg.slice(0, 160);
  if (!company || company.length < 2 || /^https?:/i.test(company)) return null;

  const url = firstUrl(text) ?? `https://news.ycombinator.com/item?id=${c.id}`;
  const location = parts.find((p) => /remote|india|bangalore|bengaluru|mumbai|pune|hyderabad|worldwide|anywhere/i.test(p)) ?? null;

  return {
    company: { name: company, atsHintUrl: /^https?:/i.test(url) && !url.includes('news.ycombinator.com') ? url : null },
    job: {
      externalId: `hn-${c.id}`,
      title,
      description: capDescription(text),
      url,
      location,
      country: /india|bangalore|bengaluru|mumbai|pune|hyderabad|delhi|gurgaon|noida/i.test(text) ? 'IN' : null,
      workMode: /remote|worldwide|anywhere/i.test(text) ? 'REMOTE' : null,
    },
  };
}

export async function fetchHnWhoIsHiring(): Promise<BoardJob[]> {
  const threadId = await latestThreadId();
  if (!threadId) {
    console.log('[hn-whoishiring] no thread found');
    return [];
  }
  const thread = await fetchJson<AlgoliaItem>(`https://hn.algolia.com/api/v1/items/${threadId}`);
  const comments = thread.children ?? [];
  const jobs: BoardJob[] = [];
  for (const c of comments) {
    try {
      const job = parseComment(c);
      if (job) jobs.push(job);
    } catch {
      /* one malformed comment never stops the batch */
    }
  }
  console.log(`[hn-whoishiring] thread ${threadId}: ${comments.length} comments -> ${jobs.length} relevant jobs`);
  return jobs;
}
