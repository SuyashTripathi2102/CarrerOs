/**
 * Telegram message layouts, v2 (23 Nov 2026). Pure functions: the services fetch the data, these lay it
 * out. The rules, from reviewing real messages sent on 21-22 Nov:
 * - the decision first, and ONE score (resume fit), not two that disagree;
 * - every job is a tappable link to where you apply, with tracking parameters removed, and the link's
 *   host named, so an aggregator link is never mistaken for the company's own page;
 * - only reasons that say something about THIS job: generic ones ("experience level fits", "freshly
 *   posted", "strong resume match (N%)", "solid company signals") appeared on nearly every message;
 * - the AI's analysis is kept short; the full text stays on the dashboard;
 * - placeholder postings ("Dummy ID", "do not apply") are never shown.
 * Telegram HTML: <b>, <i> and <a href>, properly nested.
 */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

/** Query parameters that only track the click; removing them never changes the page. */
const TRACKING_PARAM =
  /^(utm_[a-z0-9_]+|gclid|fbclid|msclkid|applicationsource)$/i;

/** The same URL without click-tracking parameters; anything unparseable is returned as it was. */
export function cleanJobUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return raw;
  }
}

/** The link's host without "www.", or null for an unparseable URL. */
export function linkHost(raw: string): string | null {
  try {
    return new URL(raw).hostname.replace(/^www\./i, '') || null;
  } catch {
    return null;
  }
}

/** Titles that are not real openings: a recruiter's placeholder or a test requisition. */
export const PLACEHOLDER_TITLE =
  /\b(dummy|placeholder|do not apply|test (job|posting|requisition))\b/i;
/** The same rule for Postgres (`~*`, where \m and \M are word boundaries). */
export const PLACEHOLDER_TITLE_PG =
  '\\m(dummy|placeholder|do not apply|test (job|posting|requisition))\\M';

const GENERIC_REASON = [
  /^experience level fits$/i,
  /^freshly posted\b/i,
  /^strong resume match\b/i,
  /^solid company signals$/i,
  /^recent \(<1 week\)$/i,
  /^company hiring is growing$/i,
];

/** The reasons that say something about this job; generic ones are dropped. */
export function informativeReasons(reasons: string[]): string[] {
  return reasons
    .map((r) => r.trim())
    .filter((r) => r && !GENERIC_REASON.some((g) => g.test(r)));
}

/** "today", "yesterday", "3d ago": the posting date, or the first sighting when there is none. */
export function ageLabel(
  postedAt: Date | null,
  firstSeenAt: Date,
  now: Date = new Date(),
): string {
  const days = Math.floor(
    (now.getTime() - (postedAt ?? firstSeenAt).getTime()) / 86_400_000,
  );
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

/** At most `max` characters, cut at a sentence end when one is close enough, otherwise at a word. */
export function shorten(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const sentence = Math.max(
    head.lastIndexOf('. '),
    head.lastIndexOf('! '),
    head.lastIndexOf('? '),
  );
  if (sentence >= max * 0.5) return head.slice(0, sentence + 1);
  const word = head.lastIndexOf(' ');
  return `${head.slice(0, word > 0 ? word : max).replace(/[,;:]$/, '')}…`;
}

function gapNote(gaps: string[]): string | null {
  if (gaps.length === 0) return null;
  const shown = gaps.slice(0, 2).join(', ');
  return gaps.length > 2
    ? `gaps: ${shown} +${gaps.length - 2}`
    : `gap: ${shown}`;
}

/** A job as a list entry: a linked bold title, then one line of facts. */
export interface JobLine {
  title: string;
  url: string;
  company: string;
  place: string | null;
  age?: string | null;
  fitPct?: number | null;
  gaps?: string[];
  note?: string | null;
}

function jobEntry(j: JobLine, prefix: string): string[] {
  const facts = [
    escapeHtml(j.company),
    j.place ? escapeHtml(j.place) : null,
    j.age ? escapeHtml(j.age) : null,
    j.fitPct != null ? `fit ${Math.round(j.fitPct)}%` : null,
    j.gaps ? gapNote(j.gaps) : null,
    j.note ? escapeHtml(j.note) : null,
  ].filter((x): x is string => !!x);
  return [
    `${prefix}<a href="${escapeAttr(cleanJobUrl(j.url))}"><b>${escapeHtml(j.title)}</b></a>`,
    `${prefix ? '   ' : ''}${facts.join(' · ')}`,
  ];
}

// ─── the instant alert ─────────────────────────────────────────────────────────────────────────────

export interface AlertView {
  /** The decision label, e.g. "✅ APPLY". */
  action: string;
  fitPct: number;
  title: string;
  /** Where to apply: the same link as the Apply button. */
  applyUrl: string;
  company: string;
  place: string | null;
  age: string;
  /** "₹12L–18L", or null when the posting lists none (then nothing is shown). */
  salary: string | null;
  reasons: string[];
  missingSkills: string[];
  analysis: string | null;
  twinCount: number;
}

export const ALERT_ANALYSIS_MAX = 420;

export function formatAlert(v: AlertView): string {
  const facts = [
    escapeHtml(v.company),
    v.place ? escapeHtml(v.place) : null,
    escapeHtml(v.age),
    v.salary ? escapeHtml(v.salary) : null,
  ]
    .filter((x): x is string => !!x)
    .join(' · ');
  const lines = [
    `<b>${escapeHtml(v.action)}</b> · fit <b>${Math.round(v.fitPct)}%</b>`,
    ``,
    `<a href="${escapeAttr(cleanJobUrl(v.applyUrl))}"><b>${escapeHtml(v.title)}</b></a>`,
    facts,
  ];
  const why = informativeReasons(v.reasons);
  const mentionsGaps = why.some((r) => /missing|skill gap|gap:/i.test(r));
  const gaps = mentionsGaps ? null : gapNote(v.missingSkills);
  if (gaps) why.push(gaps);
  if (why.length > 0) lines.push(``, ...why.map((r) => `• ${escapeHtml(r)}`));
  if (v.analysis?.trim())
    lines.push(
      ``,
      `<i>${escapeHtml(shorten(v.analysis, ALERT_ANALYSIS_MAX))}</i>`,
    );
  if (v.twinCount > 1)
    lines.push(
      ``,
      `${v.twinCount} postings of this role at ${escapeHtml(v.company)}`,
    );
  const host = linkHost(v.applyUrl);
  if (host) lines.push(``, `Apply via ${escapeHtml(host)}`);
  return lines.join('\n');
}

// ─── the 14:00 digest ──────────────────────────────────────────────────────────────────────────────

export function formatDigest(items: JobLine[]): string {
  const lines = [
    `🟡 <b>Worth a look · ${items.length}</b>`,
    `Good matches that didn't quite make "apply now".`,
  ];
  items.forEach((j, i) => lines.push(``, ...jobEntry(j, `${i + 1}. `)));
  return lines.join('\n');
}

// ─── the 08:00 brief ───────────────────────────────────────────────────────────────────────────────

export interface BriefView {
  dateLabel: string;
  firstName: string | null;
  /** APPLY verdicts not acted on yet, best first. */
  doToday: JobLine[];
  /** CONSIDER verdicts, best first. */
  worthALook: JobLine[];
  /** Shown only when there is nothing to apply to: the closest matches by profile similarity. */
  closest: JobLine[];
  followUps: { title: string; company: string; daysWaiting: number }[];
  newJobs24h: number;
  indiaNew24h: number;
  learnNext: { skill: string; count: number }[];
  /** Pre-formatted operator lines (large retirements), appended as they are. */
  extra: string[];
}

export function formatBrief(v: BriefView): string {
  const lines = [
    `☀️ <b>Daily Brief · ${escapeHtml(v.dateLabel)}</b>`,
    `Good morning${v.firstName ? ` ${escapeHtml(v.firstName)}` : ''}.`,
  ];
  if (v.doToday.length > 0) {
    lines.push(``, `<b>Do today</b> · ${v.doToday.length} to apply`);
    v.doToday.forEach((j, i) => lines.push(...jobEntry(j, `${i + 1}. `)));
  } else if (v.closest.length > 0) {
    lines.push(
      ``,
      `<b>Do today</b>`,
      `Nothing new to apply to. Closest matches:`,
    );
    v.closest.forEach((j, i) => lines.push(...jobEntry(j, `${i + 1}. `)));
  } else {
    lines.push(
      ``,
      `<b>Do today</b>`,
      `Nothing new to apply to; the bar stays high on purpose.`,
    );
  }
  if (v.worthALook.length > 0) {
    lines.push(``, `<b>Worth a look</b>`);
    for (const j of v.worthALook) lines.push(...jobEntry(j, '• '));
  }
  if (v.followUps.length > 0) {
    lines.push(``, `<b>Follow up</b> (no reply yet)`);
    for (const f of v.followUps) {
      lines.push(
        `• ${escapeHtml(f.title)} · ${escapeHtml(f.company)} · applied ${f.daysWaiting}d ago`,
      );
    }
  }
  lines.push(
    ``,
    `📊 ${v.newJobs24h.toLocaleString('en-IN')} new jobs in 24 h · ${v.indiaNew24h.toLocaleString('en-IN')} in India`,
  );
  if (v.learnNext.length > 0) {
    lines.push(
      `🧩 Learn next: ${v.learnNext.map((s) => `${escapeHtml(s.skill)} (${s.count} matches)`).join(' · ')}`,
    );
  }
  if (v.extra.length > 0) lines.push(``, ...v.extra);
  return lines.join('\n');
}
