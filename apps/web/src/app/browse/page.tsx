'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiGet } from '@/lib/api';

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
  opportunity: number;
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
};

export default function BrowsePage() {
  const [data, setData] = useState<Browse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    apiGet<Browse>('/matches/browse?limit=100')
      .then(setData)
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <Shell><p className="text-red-400">{error}</p></Shell>;
  if (!data) return <Shell><p className="text-neutral-400">Ranking every job by your resume…</p></Shell>;

  const term = q.trim().toLowerCase();
  const items = term
    ? data.items.filter(
        (j) =>
          j.title.toLowerCase().includes(term) ||
          j.company.toLowerCase().includes(term) ||
          (j.location ?? '').toLowerCase().includes(term),
      )
    : data.items;

  return (
    <Shell>
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Browse</h1>
          <p className="text-sm text-neutral-400">
            Every live job ranked by <b>Opportunity Score</b> — resume fit + referral + freshness +
            watchlist + hiring signal. Instant, no waiting on scoring.
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
        {items.length} job{items.length === 1 ? '' : 's'}{term ? ` matching “${q}”` : ' — best opportunity first'}
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
            <Link
              key={j.jobId}
              href={`/jobs/${j.jobId}`}
              className="flex items-start gap-3 px-3 py-2.5 transition hover:bg-neutral-900"
            >
              <div className="w-10 flex-none text-right">
                <div className={`text-base font-semibold tabular-nums ${oppColor(j.opportunity)}`}>
                  {j.opportunity}
                </div>
                <div className="text-[9px] uppercase tracking-wide text-neutral-600">opp</div>
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
                  {j.verdict && VERDICT_STYLE[j.verdict] && (
                    <span className={`flex-none rounded border px-1.5 py-0.5 text-[10px] ${VERDICT_STYLE[j.verdict]}`}>
                      {j.verdict}
                    </span>
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
