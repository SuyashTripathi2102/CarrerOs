/**
 * Resume Quality Gate — deterministic guardrails before a tailored resume goes
 * out. Idea borrowed from JSpotter ("the hardest part isn't the AI, it's the
 * guardrails"), generalised: no LLM, no invented rules — just checkable facts
 * comparing the tailored resume against the master it derives from.
 *
 * The most important check is CONFABULATION: any impact metric in the tailored
 * resume that isn't in the master is a fabricated number. CareerOS's tailoring
 * only inserts keyword spellings, so a clean master should pass green — the gate
 * is the proof, and it catches any drift or hand-edit that crossed the line.
 */

export type GateStatus = 'PASS' | 'WARN' | 'FAIL';

export interface GateCheck {
  name: string;
  status: GateStatus;
  detail: string;
  items?: string[]; // offending examples, when useful
}

export interface QualityGate {
  score: number; // 0–100
  verdict: 'SEND' | 'REVIEW' | 'FIX';
  checks: GateCheck[];
}

const STRONG_VERBS =
  /^(built|led|owned|designed|architected|shipped|scaled|launched|delivered|improved|reduced|increased|drove|created|developed|implemented|engineered|automated|optimi[sz]ed|migrated|integrated|deployed|managed|mentored|spearheaded|streamlined|refactored|established)\b/i;

const FILLER =
  /\b(directly relevant to|well[- ]suited|perfectly aligned|proven track record|team player|hard[- ]?working|results[- ]driven|go[- ]getter|synergy|detail[- ]oriented|responsible for|self[- ]starter|think outside the box|hit the ground running|dynamic professional)\b/gi;

/** Impact metrics: percentages, multipliers, big counts, "N+ / N years / $N".
 *  Deliberately excludes version-ish tokens (2.0, ES6, S3, OAuth 2.0). */
const METRIC_RE =
  /\b\d{1,3}(?:,\d{3})+\b|\b\d+%|\b\d+x\b|\b\d+\+|\b\d{3,}\b|\$\s?\d+|\b\d+\s?(?:years?|yrs?|months?)\b/gi;

const normNum = (s: string) => s.toLowerCase().replace(/[\s,]/g, '');

const bulletsFrom = (html: string): string[] =>
  [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) =>
    m[1].replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim(),
  );

const wordCount = (s: string) => (s.match(/\S+/g) ?? []).length;

export function resumeQualityGate(input: {
  masterText: string;
  tailoredText: string;
  tailoredHtml: string;
}): QualityGate {
  const { masterText, tailoredText, tailoredHtml } = input;
  const checks: GateCheck[] = [];
  let score = 100;
  const push = (c: GateCheck, penalty: number) => {
    checks.push(c);
    if (c.status !== 'PASS') score -= penalty;
  };

  // 1) Confabulated metrics — numbers in the tailored resume absent from master.
  const masterNums = new Set((masterText.match(METRIC_RE) ?? []).map(normNum));
  const invented = [
    ...new Set((tailoredText.match(METRIC_RE) ?? []).filter((n) => !masterNums.has(normNum(n)))),
  ];
  push(
    invented.length
      ? {
          name: 'No invented metrics',
          status: 'FAIL',
          detail: `${invented.length} number(s) not found in your master resume — verify or remove.`,
          items: invented.slice(0, 8),
        }
      : { name: 'No invented metrics', status: 'PASS', detail: 'Every metric traces to your master resume.' },
    30,
  );

  // 2) ATS-safe formatting — tables/images/multi-column break many parsers.
  const atsRisks: string[] = [];
  if (/<table[\s>]/i.test(tailoredHtml)) atsRisks.push('table');
  if (/<img[\s>]/i.test(tailoredHtml)) atsRisks.push('image');
  if (/column-count|columns\s*:|display\s*:\s*flex|float\s*:/i.test(tailoredHtml)) atsRisks.push('multi-column layout');
  push(
    atsRisks.length
      ? { name: 'ATS-safe formatting', status: 'WARN', detail: `Contains ${atsRisks.join(', ')} — risky for literal ATS parsers.`, items: atsRisks }
      : { name: 'ATS-safe formatting', status: 'PASS', detail: 'Single-column, text-only — machine-readable.' },
    15,
  );

  // 3) No filler / pandering phrases.
  const fillers = [...new Set((tailoredText.match(FILLER) ?? []).map((s) => s.toLowerCase()))];
  push(
    fillers.length
      ? { name: 'No filler phrases', status: 'WARN', detail: 'Recruiter-repellent clichés — replace with specifics.', items: fillers.slice(0, 6) }
      : { name: 'No filler phrases', status: 'PASS', detail: 'No empty clichés.' },
    Math.min(12, fillers.length * 3),
  );

  const bullets = bulletsFrom(tailoredHtml);

  // 4) Bullet length — long bullets get skimmed past.
  const longBullets = bullets.filter((b) => wordCount(b) > 45);
  push(
    longBullets.length
      ? { name: 'Concise bullets', status: 'WARN', detail: `${longBullets.length} bullet(s) over 45 words.`, items: longBullets.slice(0, 3).map((b) => b.slice(0, 80) + '…') }
      : { name: 'Concise bullets', status: 'PASS', detail: bullets.length ? 'All bullets are tight.' : 'No bullet list detected.' },
    Math.min(10, longBullets.length * 2),
  );

  // 5) Strong bullet openers.
  const weak = bullets.filter((b) => b.length > 0 && !STRONG_VERBS.test(b));
  push(
    weak.length > Math.max(1, bullets.length * 0.4)
      ? { name: 'Strong action verbs', status: 'WARN', detail: `${weak.length}/${bullets.length} bullets don't open with an impact verb.`, items: weak.slice(0, 3).map((b) => b.slice(0, 60) + '…') }
      : { name: 'Strong action verbs', status: 'PASS', detail: 'Bullets lead with action.' },
    8,
  );

  // 6) Duplicate bullets.
  const seen = new Map<string, number>();
  for (const b of bullets) {
    const k = b.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
    if (k) seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const dups = [...seen.values()].filter((n) => n > 1).length;
  push(
    dups
      ? { name: 'No duplicate bullets', status: 'WARN', detail: `${dups} bullet(s) repeat near-verbatim.` }
      : { name: 'No duplicate bullets', status: 'PASS', detail: 'Every bullet is distinct.' },
    Math.min(12, dups * 4),
  );

  // 7) Keyword stuffing — one token hammered too often reads as spam.
  const words = (tailoredText.toLowerCase().match(/[a-z][a-z0-9.+#-]{2,}/g) ?? []).filter(
    (w) => !STOPWORDS.has(w),
  );
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  const stuffed = [...freq.entries()].filter(([, n]) => n >= 9).map(([w, n]) => `${w} (${n}×)`);
  push(
    stuffed.length
      ? { name: 'No keyword stuffing', status: 'WARN', detail: 'A term repeats unusually often — ATS penalises stuffing.', items: stuffed.slice(0, 5) }
      : { name: 'No keyword stuffing', status: 'PASS', detail: 'Keyword usage looks natural.' },
    8,
  );

  // 8) Contact present.
  const hasEmail = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(tailoredText);
  push(
    hasEmail
      ? { name: 'Contact details', status: 'PASS', detail: 'Email present.' }
      : { name: 'Contact details', status: 'WARN', detail: 'No email found — recruiters need a way to reach you.' },
    10,
  );

  score = Math.max(0, Math.min(100, score));
  const anyFail = checks.some((c) => c.status === 'FAIL');
  const verdict: QualityGate['verdict'] = anyFail ? 'FIX' : score >= 85 ? 'SEND' : 'REVIEW';
  return { score, verdict, checks };
}

const STOPWORDS = new Set(
  'the and for with you your from that this have has are was will has our not all can who out use used using building built across into over per via etc job role team work working experience developer engineer software company companies skills projects education summary'.split(
    ' ',
  ),
);
