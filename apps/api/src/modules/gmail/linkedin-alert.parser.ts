import type { BoardJob } from '@careeros/shared';

/**
 * LinkedIn job-alert email parser.
 *
 * BUILT AGAINST SYNTHETIC FIXTURES (2026-09-09). No real LinkedIn alert email
 * has been seen yet. The tests validate the parser against plausible template
 * shapes, which is NOT the same as evidence that LinkedIn's actual emails parse.
 * Treat the first live run as the real validation, and expect this file to
 * change once a genuine email exists.
 *
 * That uncertainty drives the design: the parser anchors on the ONE thing that
 * is stable and verifiable -- the job-view URL and the numeric id inside it --
 * rather than on a table layout, class name or element order, any of which
 * LinkedIn can change without notice and all of which are guesses right now.
 *
 * TWO STRUCTURAL RULES, both written after the first version got them wrong
 * while every test still passed:
 *
 *   A CARD IS BOUNDED BY THE NEXT JOB URL. The first version read a fixed
 *   window BACKWARD from each link, so card 2's window contained card 1 and the
 *   first date match won -- a job posted "5 hours ago" was recorded with the
 *   previous job's "2 days ago". Wrong, plausible, and silent.
 *
 *   FIELDS ARE READ PER LINE, NOT FROM A BLOB. Collapsing a card to one string
 *   destroys the tag boundaries that ARE the field boundaries: the location
 *   regex then matched "Engineer Razorpay Bengaluru, Karnataka, India".
 *
 * ADR-8: this reads the user's own inbox. It never fetches a LinkedIn page.
 */

/** `https://www.linkedin.com/comm/jobs/view/4012345678/?trackingId=...` */
const JOB_URL_RE = /https?:\/\/[^"'\s>]*linkedin\.com\/(?:comm\/)?jobs\/view\/(\d{6,})[^"'\s>]*/gi;

const TAG_RE = /<[^>]+>/g;
const WS_RE = /\s+/g;

/** `<style>` and `<script>` bodies are markup, never content. */
function stripInvisible(html: string): string {
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&[a-z]+;/gi, ' ');
}

function text(html: string): string {
  return decodeEntities(stripInvisible(html).replace(TAG_RE, ' ')).replace(WS_RE, ' ').trim();
}

/**
 * Split a fragment into its text nodes, one per element.
 *
 * Field boundaries in these emails ARE the tag boundaries -- title, company,
 * location and date each sit in their own element. Every field below is read
 * from this list rather than from a flattened string, because flattening makes
 * a company line followed by a location line indistinguishable from a location.
 */
function textLines(html: string): string[] {
  return stripInvisible(html)
    .split(TAG_RE)
    .map((t) => decodeEntities(t).replace(WS_RE, ' ').trim())
    .filter((t) => t.length > 0);
}

/**
 * LinkedIn tracking parameters carry per-recipient identifiers. Stripping them
 * is both hygiene and correctness: the same posting arrives with a different
 * trackingId in every digest, so an unstripped URL would defeat dedup and
 * create one "job" per email.
 */
export function canonicalJobUrl(raw: string): string | null {
  const m = /linkedin\.com\/(?:comm\/)?jobs\/view\/(\d{6,})/i.exec(raw);
  if (!m) return null;
  return `https://www.linkedin.com/jobs/view/${m[1]}`;
}

export function jobIdFrom(raw: string): string | null {
  const m = /jobs\/view\/(\d{6,})/i.exec(raw);
  return m ? m[1] : null;
}

/**
 * Relative dates: "2 days ago", "3 weeks ago".
 *
 * Returns null whenever the phrase cannot be read confidently. It must NEVER
 * fall back to "now": `freshness` scores an unknown date as maximally fresh --
 * the latent bug already recorded in the roadmap -- so a guess here would make
 * every alert job look posted today and outrank genuinely fresh postings.
 */
export function parseRelativeDate(phrase: string, now = new Date()): Date | null {
  const m = /(\d+)\s*(minute|hour|day|week|month)s?\s+ago/i.exec(phrase);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0 || n > 400) return null;
  const ms: Record<string, number> = {
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 604_800_000,
    month: 2_592_000_000,
  };
  const unit = ms[m[2].toLowerCase()];
  return unit ? new Date(now.getTime() - n * unit) : null;
}

export interface AlertMessageMeta {
  messageId: string;
  receivedAt: Date;
}

/**
 * Sender/subject match. Declared by the parser rather than centrally, so adding
 * Naukri later touches only its own file.
 */
export function matchesLinkedInAlert(from: string, subject: string): boolean {
  const f = from.toLowerCase();
  // The domain must BE linkedin.com, not merely contain it. A substring test
  // accepts `noreply@linkedin.com.evil.tld`, which is exactly the shape of a
  // phishing sender -- and this parser's output goes on to ingest.
  const at = f.lastIndexOf('@');
  if (at < 0) return false;
  const domain = f.slice(at + 1).replace(/[>\s]+$/, '');
  if (domain !== 'linkedin.com' && !domain.endsWith('.linkedin.com')) return false;
  if (/jobalerts|jobs-noreply|jobs-listings/.test(f)) return true;
  // Fall back to the subject only for genuine linkedin.com senders.
  return /job alert|new jobs?|jobs? for you|hiring/i.test(subject);
}

/**
 * The markup belonging to ONE job card.
 *
 * Starts at this job's own `<a`, ends at the next job link in the email. That
 * boundary is what keeps a card's fields its own; without it the neighbouring
 * card's date and location bleed in and are indistinguishable from this card's.
 */
function cardHtml(html: string, at: number, nextAt: number): string {
  const lookback = Math.max(0, at - 600);
  const open = html.slice(lookback, at).lastIndexOf('<a ');
  const start = open >= 0 ? lookback + open : Math.max(0, at - 200);
  const end = Math.min(html.length, nextAt, at + 800);
  // Drop a tag left unterminated by the cut, so it cannot survive as text.
  return html.slice(start, end).replace(/<[^>]*$/, '');
}

const LOCATION_RE =
  /\b([A-Z][A-Za-z.\- ]{2,28},\s*(?:[A-Z][A-Za-z.\- ]{2,28},\s*)?(?:India|Karnataka|Maharashtra|Telangana|Tamil Nadu|Delhi|Haryana|Remote))\b/;

const BOILERPLATE_RE = /^(view job|apply|see all|unsubscribe|linkedin|\d+ (new )?jobs?)/i;

export function parseLinkedInAlert(html: string, meta: AlertMessageMeta): BoardJob[] {
  const out: BoardJob[] = [];
  const seen = new Set<string>();
  const links = [...html.matchAll(JOB_URL_RE)];

  for (let i = 0; i < links.length; i++) {
    const m = links[i];
    const at = m.index ?? 0;
    const jobId = jobIdFrom(m[0]);
    const url = canonicalJobUrl(m[0]);
    // No id or no URL means no stable identity and nowhere to apply. Reject
    // rather than synthesising one -- a fabricated externalId would break dedup
    // permanently and invisibly.
    if (!jobId || !url || seen.has(jobId)) continue;

    const card = cardHtml(html, at, links[i + 1]?.index ?? html.length);
    const title = extractTitle(html, at);
    const fields = linesAfterTitle(textLines(card), title);
    const company = pickCompany(fields);
    if (!title || !company) continue; // BoardJobSchema requires both

    seen.add(jobId);
    const posted = pickPostedAt(fields, meta.receivedAt);
    out.push({
      company: { name: company, website: null, atsHintUrl: null, sourceSlug: null },
      job: {
        externalId: `linkedin:${jobId}`,
        title,
        // Alert emails carry NO job body. Storing '' with MISSING lets the
        // INSUFFICIENT_EVIDENCE gate hold the job instead of judging it blind --
        // the protection built after 6,907 jobs were refused NOT_DEVELOPMENT
        // for descriptions nobody had.
        description: '',
        descriptionSource: 'MISSING',
        url,
        location: pickLocation(fields),
        country: null, // normalizeCountry decides at the ingest choke point
        workMode: null,
        postedAt: posted ? posted.toISOString() : null,
        raw: { messageId: meta.messageId, jobId, block: text(card).slice(0, 500) },
      },
    });
  }
  return out;
}

/** Title = the anchor text of the job link. */
function extractTitle(html: string, at: number): string | null {
  const lookback = Math.max(0, at - 600);
  const open = html.slice(lookback, at).lastIndexOf('<a ');
  if (open < 0) return null;
  const close = html.indexOf('</a>', at);
  if (close < 0) return null;
  const inner = text(html.slice(lookback + open, close));
  const cleaned = inner.replace(/^https?:\S+\s*/i, '').trim();
  return cleaned.length >= 2 && cleaned.length <= 200 ? cleaned : null;
}

/**
 * The card's remaining fields: everything after the title line.
 *
 * Anchoring on the title is what stops markup that precedes the link from being
 * read as this card's company.
 */
function linesAfterTitle(lines: string[], title: string | null): string[] {
  if (!title) return [];
  const at = lines.findIndex((l) => l === title || l.includes(title));
  return at >= 0 ? lines.slice(at + 1) : lines;
}

/** Company: the first line after the title that is not a location or chrome. */
function pickCompany(fields: string[]): string | null {
  for (const c of fields) {
    if (c.length < 2 || c.length > 100) continue;
    if (LOCATION_RE.test(c)) continue;
    if (/ago$/i.test(c)) continue;
    if (BOILERPLATE_RE.test(c)) continue;
    return c;
  }
  return null;
}

/**
 * Location, matched per line. Run against a flattened card this regex happily
 * starts inside the title -- "Engineer Razorpay Bengaluru, Karnataka, India"
 * was a real result, stored as the location with no error anywhere.
 */
function pickLocation(fields: string[]): string | null {
  for (const line of fields) {
    const m = LOCATION_RE.exec(line);
    if (m) return m[1];
  }
  return null;
}

/** Posted date, matched per line and only within this card's own boundary. */
function pickPostedAt(fields: string[], now: Date): Date | null {
  for (const line of fields) {
    const d = parseRelativeDate(line, now);
    if (d) return d;
  }
  return null;
}
