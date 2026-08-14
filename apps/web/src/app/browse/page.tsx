'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiGet, apiPost } from '@/lib/api';

/**
 * Fire-and-forget outcome logging — never blocks navigation, never throws.
 *
 * `displayedScore` is the live surface score this page rendered, which is NOT
 * the persisted verdict in job_matches — separate scoring paths, known to
 * disagree. Sent so the event records what the user actually saw.
 */
function track(jobId: string, type: 'CLICKED' | 'DISMISSED', rank: number, j: Job) {
  apiPost('/events', {
    jobId,
    type,
    surface: 'browse',
    rank,
    // Exactly what the row showed: a score only when one was rendered, and the
    // state the badge claimed. POTENTIAL rows legitimately carry no score.
    displayedScore: j.opportunity ?? undefined,
    displayedVerdict: j.state,
  }).catch(() => {});
}

interface Factor {
  label: string;
  delta: number;
}
interface Job {
  jobId: string;
  title: string;
  company: string;
  location: string | null;
  workMode: string | null;
  url: string;
  country: string | null;
  postedAt: string | null;
  ageDays: number;
  fit: number;
  applied: boolean;
  verdict: string | null;
  /** APPLY/CONSIDER = evaluated; POTENTIAL = not evaluated yet. */
  state: 'APPLY' | 'CONSIDER' | 'POTENTIAL' | 'REFUSED';
  /** Canonical Opportunity Score — null when the job has not been evaluated. */
  opportunity: number | null;
  /** Similarity-based ordering signal. NOT an Opportunity Score. */
  matchSignal: number;
  competition: 'LOW' | 'MEDIUM' | 'HIGH';
  factors: Factor[];
  watched: boolean;
  referral: 'CONTACTED' | 'FOUND' | 'NONE';
}
interface Browse {
  resumeReady: boolean;
  items: Job[];
}

const oppColor = (f: number) =>
  f >= 75 ? 'text-emerald-300' : f >= 55 ? 'text-sky-300' : f >= 40 ? 'text-amber-300' : 'text-neutral-400';

const VERDICT_STYLE: Record<string, string> = {
  APPLY: 'border-emerald-800 bg-emerald-950/40 text-emerald-300',
  CONSIDER: 'border-amber-800 bg-amber-950/40 text-amber-200',
  // Visually quieter than a verdict on purpose: this is a candidate CareerOS
  // has not judged, and it must not read as an endorsement.
  POTENTIAL: 'border-neutral-700 bg-neutral-900 text-neutral-400',
};

export default function BrowsePage() {
  const [data, setData] = useState<Browse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    apiGet<Browse>('/matches/browse?limit=100')
      .then((d) => {
        setData(d);
        // Log impressions once per load — the CTR/apply-rate denominator.
        if (d.items.length > 0) {
          apiPost('/events/impressions', {
            surface: 'browse',
            items: d.items.map((j, i) => ({
              jobId: j.jobId,
              rank: i + 1,
              displayedScore: j.opportunity ?? undefined,
              displayedVerdict: j.state,
            })),
          }).catch(() => {});
        }
      })
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <Shell><p className="text-red-400">{error}</p></Shell>;
  if (!data) return <Shell><p className="text-neutral-400">Ranking every job by your resume…</p></Shell>;

  const term = q.trim().toLowerCase();
  const items = (term
    ? data.items.filter(
        (j) =>
          j.title.toLowerCase().includes(term) ||
          j.company.toLowerCase().includes(term) ||
          (j.location ?? '').toLowerCase().includes(term),
      )
    : data.items
  ).filter((j) => !dismissed.has(j.jobId));

  // True rank = position in the opportunity-ranked list (not the filtered view).
  const rankOf = new Map(data.items.map((j, i) => [j.jobId, i + 1]));

  return (
    <Shell>
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Browse</h1>
          <p className="text-sm text-neutral-400">
            <b>Evaluated</b> jobs first, carrying a real <b>Opportunity Score</b> and verdict.
            Below them, <b>potential matches</b> — close to your resume but not assessed yet, so
            they show no score. Nothing here was rejected by the eligibility gate.
          </p>
        </div>
        <nav className="flex items-center gap-3 text-sm text-neutral-500">
          <Link href="/today" className="hover:text-neutral-300">Today</Link>
          <Link href="/" className="hover:text-neutral-300">Board</Link>
        </nav>
      </div>

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Filter by title, company, or city…"
        className="mt-4 w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-500 focus:border-neutral-600 focus:outline-none"
      />
      <p className="mt-2 text-[12px] text-neutral-500">
        {items.length} job{items.length === 1 ? '' : 's'}
        {term ? ` matching “${q}”` : ''}
        {!term && (
          <>
            {' — '}
            {items.filter((j) => j.opportunity != null).length} evaluated,{' '}
            {items.filter((j) => j.state === 'POTENTIAL').length} pending evaluation
          </>
        )}
      </p>

      {items.length === 0 ? (
        <p className="mt-6 text-neutral-400">
          {data.resumeReady
            ? 'No jobs yet — the India aggregator sweep will fill this in.'
            : 'Activate a resume first so CareerOS can rank jobs by fit.'}
        </p>
      ) : (
        <div className="mt-3 divide-y divide-neutral-900 rounded-xl border border-neutral-800">
          {items.map((j) => (
            <div key={j.jobId} className="group relative">
            <Link
              href={`/jobs/${j.jobId}`}
              onClick={() => track(j.jobId, 'CLICKED', rankOf.get(j.jobId) ?? 0, j)}
              className="flex items-start gap-3 px-3 py-2.5 pr-9 transition hover:bg-neutral-900"
            >
              {/* An unevaluated job shows NO score. Rendering the similarity
                  signal here would put a number in the Opportunity column that
                  no decision stands behind — the exact confusion this column
                  caused before 2026-08-15. */}
              <div className="w-10 flex-none text-right">
                {j.opportunity == null ? (
                  <>
                    <div className="text-base font-semibold tabular-nums text-neutral-600">–</div>
                    <div className="text-[9px] uppercase tracking-wide text-neutral-600">pending</div>
                  </>
                ) : (
                  <>
                    <div className={`text-base font-semibold tabular-nums ${oppColor(j.opportunity)}`}>
                      {Math.round(j.opportunity)}
                    </div>
                    <div className="text-[9px] uppercase tracking-wide text-neutral-600">opp</div>
                  </>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-[14px] font-medium text-neutral-100">{j.title}</span>
                  {j.referral === 'CONTACTED' && (
                    <span className="flex-none rounded border border-violet-800 bg-violet-950/40 px-1.5 py-0.5 text-[10px] text-violet-200">
                      referral in flight
                    </span>
                  )}
                  {j.watched && (
                    <span className="flex-none rounded border border-sky-800 bg-sky-950/40 px-1.5 py-0.5 text-[10px] text-sky-300">
                      ★ watchlist
                    </span>
                  )}
                  {j.state === 'POTENTIAL' ? (
                    <span className={`flex-none rounded border px-1.5 py-0.5 text-[10px] ${VERDICT_STYLE.POTENTIAL}`}>
                      potential · not evaluated
                    </span>
                  ) : (
                    j.verdict &&
                    VERDICT_STYLE[j.verdict] && (
                      <span
                        className={`flex-none rounded border px-1.5 py-0.5 text-[10px] ${VERDICT_STYLE[j.verdict]}`}
                      >
                        {j.verdict}
                      </span>
                    )
                  )}
                  {j.applied && (
                    <span className="flex-none rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-400">
                      applied
                    </span>
                  )}
                </div>
                <div className="truncate text-[12px] text-neutral-400">
                  {j.company}
                  {j.location ? ` · ${j.location}` : ''}
                  {' · '}
                  {j.ageDays <= 0 ? 'today' : `${j.ageDays}d ago`}
                  {' · '}fit {j.fit} · {j.competition.toLowerCase()} competition
                </div>
                <div className="mt-0.5 flex flex-wrap gap-1 text-[10px] text-neutral-500">
                  {j.factors
                    .filter((f) => f.delta > 0 && !/resume fit/i.test(f.label))
                    .slice(0, 3)
                    .map((f) => (
                      <span key={f.label} className="text-emerald-500/80">
                        +{f.delta} {f.label}
                      </span>
                    ))}
                </div>
              </div>
              <span className="flex-none self-center text-neutral-600">→</span>
            </Link>
            <button
              type="button"
              title="Not relevant — hide and record why"
              onClick={() => {
                track(j.jobId, 'DISMISSED', rankOf.get(j.jobId) ?? 0, j);
                setDismissed((prev) => new Set(prev).add(j.jobId));
              }}
              className="absolute right-2 top-2 rounded px-1.5 text-neutral-600 opacity-0 transition hover:bg-neutral-800 hover:text-neutral-300 group-hover:opacity-100"
            >
              ×
            </button>
            </div>
          ))}
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-neutral-950 px-4 py-8 text-neutral-100">
      <div className="mx-auto w-full max-w-3xl">{children}</div>
    </main>
  );
}
