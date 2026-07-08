'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiGet, apiPatch } from '../../lib/api';

const STATUSES = ['SAVED', 'APPLIED', 'OA', 'INTERVIEW', 'OFFER', 'ACCEPTED', 'REJECTED', 'WITHDRAWN'] as const;
type Status = (typeof STATUSES)[number];

interface AppRow {
  id: string;
  status: Status;
  appliedAt: string | null;
  updatedAt: string;
  job: {
    title: string;
    url: string;
    location: string | null;
    company: { name: string };
  };
}

interface Stats {
  byStatus: Record<string, number>;
  applied: number;
  interviews: number;
  offers: number;
  interviewRate: number | null;
}

const STATUS_STYLE: Record<Status, string> = {
  SAVED: 'text-neutral-400',
  APPLIED: 'text-sky-300',
  OA: 'text-indigo-300',
  INTERVIEW: 'text-amber-300',
  OFFER: 'text-emerald-300',
  ACCEPTED: 'text-emerald-200',
  REJECTED: 'text-red-400',
  WITHDRAWN: 'text-neutral-500',
};

export default function ApplicationsPage() {
  const [rows, setRows] = useState<AppRow[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    Promise.all([apiGet<AppRow[]>('/applications'), apiGet<Stats>('/applications/stats')])
      .then(([r, s]) => {
        setRows(r);
        setStats(s);
      })
      .catch((e) => setError(String(e)));
  }
  useEffect(load, []);

  async function setStatus(id: string, status: Status) {
    await apiPatch(`/applications/${id}`, { status });
    load();
  }

  return (
    <main className="min-h-screen bg-neutral-950 px-4 py-8 text-neutral-100">
      <div className="mx-auto w-full max-w-3xl">
        <header className="flex items-baseline justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">Applications</h1>
          <Link href="/" className="text-sm text-neutral-500 hover:text-neutral-300">
            ← Mission Control
          </Link>
        </header>

        {stats && (
          <section className="mt-6 grid grid-cols-3 gap-3">
            <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
              <div className="text-3xl font-semibold tabular-nums">{stats.applied}</div>
              <div className="mt-1 text-xs uppercase tracking-wide text-neutral-400">Applied</div>
            </div>
            <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
              <div className="text-3xl font-semibold tabular-nums">{stats.interviews}</div>
              <div className="mt-1 text-xs uppercase tracking-wide text-neutral-400">Interviews</div>
            </div>
            <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
              <div className="text-3xl font-semibold tabular-nums">
                {stats.interviewRate === null ? '—' : `${stats.interviewRate}%`}
              </div>
              <div className="mt-1 text-xs uppercase tracking-wide text-neutral-400">
                Interview rate
              </div>
              {stats.interviewRate === null && (
                <div className="text-[11px] text-neutral-500">needs 5+ applications</div>
              )}
            </div>
          </section>
        )}

        {error && <p className="mt-6 text-red-400">{error}</p>}
        {!rows && !error && <p className="mt-6 text-neutral-400">Loading…</p>}

        {rows && rows.length === 0 && (
          <p className="mt-8 rounded-xl border border-neutral-800 bg-neutral-900/60 p-6 text-sm text-neutral-400">
            No applications tracked yet. Hit <b>I applied</b> on a job card in Mission Control
            after you apply — that&apos;s what makes the Applied number real.
          </p>
        )}

        <div className="mt-6 space-y-2">
          {rows?.map((r) => (
            <div
              key={r.id}
              className="flex items-center gap-4 rounded-xl border border-neutral-800 bg-neutral-900 p-4"
            >
              <div className="min-w-0 flex-1">
                <a
                  href={r.job.url}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate font-medium text-neutral-100 hover:underline"
                >
                  {r.job.title}
                </a>
                <div className="truncate text-sm text-neutral-400">
                  {r.job.company.name}
                  {r.appliedAt
                    ? ` · applied ${new Date(r.appliedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`
                    : ''}
                </div>
              </div>
              <select
                value={r.status}
                onChange={(e) => setStatus(r.id, e.target.value as Status)}
                className={`shrink-0 rounded-lg border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm font-medium ${STATUS_STYLE[r.status]}`}
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
