'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { apiDelete, apiGet, apiPost } from '@/lib/api';

interface Role {
  jobId: string;
  title: string;
  location: string | null;
  fit: number;
  ageDays: number;
  applied: boolean;
}
interface Watch {
  watchId: string;
  companyId: string;
  name: string;
  monitored: boolean;
  ats: string;
  careerPageUrl: string | null;
  openRoles: number;
  newThisWeek: number;
  roles: Role[];
}
interface List {
  items: Watch[];
}
interface Suggestion {
  id: string;
  name: string;
  monitored: boolean;
  ats: string;
}

const fitColor = (f: number) =>
  f >= 82 ? 'text-emerald-300' : f >= 75 ? 'text-sky-300' : f >= 68 ? 'text-amber-300' : 'text-neutral-400';

export default function WatchlistPage() {
  const [data, setData] = useState<List | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [sugs, setSugs] = useState<Suggestion[]>([]);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    apiGet<List>('/watchlist').then(setData).catch((e) => setError(String(e)));
  }, []);
  useEffect(load, [load]);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (q.trim().length < 2) {
      setSugs([]);
      return;
    }
    timer.current = setTimeout(() => {
      apiGet<Suggestion[]>(`/watchlist/search?q=${encodeURIComponent(q.trim())}`)
        .then(setSugs)
        .catch(() => setSugs([]));
    }, 250);
  }, [q]);

  async function add(name: string) {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const res = await apiPost<List>('/watchlist', { company: name.trim() });
      setData(res);
      setQ('');
      setSugs([]);
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    setData(await apiDelete<List>(`/watchlist/${id}`).catch(() => data!));
  }

  return (
    <main className="min-h-screen bg-neutral-950 px-4 py-8 text-neutral-100">
      <div className="mx-auto w-full max-w-3xl">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Watchlist</h1>
            <p className="text-sm text-neutral-400">
              Your dream companies, monitored. Watched companies are crawled often; their open roles
              are ranked by your resume fit.
            </p>
          </div>
          <nav className="flex items-center gap-3 text-sm text-neutral-500">
            <Link href="/today" className="hover:text-neutral-300">Today</Link>
            <Link href="/browse" className="hover:text-neutral-300">Browse</Link>
            <Link href="/" className="hover:text-neutral-300">Board</Link>
          </nav>
        </div>

        {/* Add a company. */}
        <div className="relative mt-4">
          <div className="flex gap-2">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add(q)}
              placeholder="Add a company — Razorpay, PhonePe, Postman…"
              className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-500 focus:border-neutral-600 focus:outline-none"
            />
            <button
              onClick={() => add(q)}
              disabled={busy || q.trim().length < 2}
              className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-950 hover:bg-white disabled:opacity-40"
            >
              Watch
            </button>
          </div>
          {sugs.length > 0 && (
            <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 shadow-xl">
              {sugs.map((s) => (
                <button
                  key={s.id}
                  onClick={() => add(s.name)}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-neutral-800"
                >
                  <span className="text-neutral-100">{s.name}</span>
                  <span className="text-[11px] text-neutral-500">
                    {s.monitored ? 'monitored' : s.ats !== 'UNKNOWN' ? s.ats.toLowerCase() : 'new'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {error && <p className="mt-6 text-red-400">{error}</p>}
        {!data && !error && <p className="mt-6 text-neutral-400">Loading…</p>}

        {data && data.items.length === 0 && (
          <p className="mt-8 rounded-xl border border-neutral-800 bg-neutral-900/60 p-6 text-sm text-neutral-400">
            No companies watched yet. Add the ones you actually want to work at — CareerOS will crawl
            them often and show their open roles ranked by your fit, so you never miss a posting.
          </p>
        )}

        <div className="mt-5 space-y-3">
          {data?.items.map((w) => (
            <div key={w.watchId} className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-neutral-100">{w.name}</span>
                    {w.monitored ? (
                      <span className="rounded-full border border-emerald-800 bg-emerald-950/40 px-2 py-0.5 text-[10px] text-emerald-300">
                        monitored
                      </span>
                    ) : (
                      <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-[10px] text-neutral-400">
                        finding career page…
                      </span>
                    )}
                    {w.newThisWeek > 0 && (
                      <span className="rounded-full border border-sky-800 bg-sky-950/40 px-2 py-0.5 text-[10px] text-sky-300">
                        {w.newThisWeek} new this week
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[12px] text-neutral-500">
                    {w.openRoles} open role{w.openRoles === 1 ? '' : 's'} matched
                    {w.careerPageUrl && (
                      <>
                        {' · '}
                        <a href={w.careerPageUrl} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">
                          careers ↗
                        </a>
                      </>
                    )}
                  </div>
                </div>
                <button onClick={() => remove(w.watchId)} className="flex-none text-[12px] text-neutral-500 hover:text-red-300">
                  unwatch
                </button>
              </div>

              {w.roles.length > 0 ? (
                <div className="mt-2 divide-y divide-neutral-900 border-t border-neutral-900">
                  {w.roles.map((r) => (
                    <Link
                      key={r.jobId}
                      href={`/jobs/${r.jobId}`}
                      className="flex items-center gap-3 py-2 transition hover:opacity-90"
                    >
                      <span className={`w-8 flex-none text-right text-sm font-semibold tabular-nums ${fitColor(r.fit)}`}>
                        {r.fit}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-200">{r.title}</span>
                      {r.applied && <span className="flex-none text-[10px] text-neutral-500">applied</span>}
                      <span className="flex-none text-[11px] text-neutral-500">
                        {r.ageDays <= 0 ? 'today' : `${r.ageDays}d`}
                      </span>
                    </Link>
                  ))}
                </div>
              ) : (
                <p className="mt-2 border-t border-neutral-900 pt-2 text-[12px] text-neutral-500">
                  No matching open roles right now — you&apos;ll see them here the moment they post.
                </p>
              )}
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
