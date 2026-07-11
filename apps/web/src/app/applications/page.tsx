'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiGet, apiPatch } from '../../lib/api';

const STATUSES = ['SAVED', 'APPLIED', 'OA', 'INTERVIEW', 'OFFER', 'ACCEPTED', 'REJECTED', 'WITHDRAWN'] as const;
type Status = (typeof STATUSES)[number];

// The positive pipeline, in order. SAVED is pre-application; ACCEPTED is the
// happy terminal; REJECTED/WITHDRAWN are off-ramps handled separately.
const PIPELINE: Status[] = ['APPLIED', 'OA', 'INTERVIEW', 'OFFER'];
const STAGE_LABEL: Record<string, string> = {
  APPLIED: 'Applied',
  OA: 'OA',
  INTERVIEW: 'Interview',
  OFFER: 'Offer',
};

interface AppEvent {
  fromStatus: Status | null;
  toStatus: Status;
  note: string | null;
  createdAt: string;
}

interface AppRow {
  id: string;
  status: Status;
  appliedAt: string | null;
  updatedAt: string;
  job: { title: string; url: string; location: string | null; company: { name: string } };
  events: AppEvent[];
}

interface Stats {
  byStatus: Record<string, number>;
  applied: number;
  interviews: number;
  offers: number;
  interviewRate: number | null;
}

const daysSince = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);

/** The horizontal pipeline: Applied → OA → Interview → Offer. */
function StageBar({ status }: { status: Status }) {
  if (status === 'SAVED')
    return <span className="text-xs text-neutral-500">Saved — not applied yet</span>;
  if (status === 'WITHDRAWN')
    return <span className="text-xs text-neutral-500">Withdrawn</span>;

  const rejected = status === 'REJECTED';
  const accepted = status === 'ACCEPTED';
  const currentIdx = accepted ? PIPELINE.length - 1 : PIPELINE.indexOf(status);

  return (
    <div className="flex flex-wrap items-center gap-1">
      {PIPELINE.map((stage, i) => {
        const done = i <= currentIdx;
        const isCurrent = i === currentIdx && !accepted && !rejected;
        return (
          <div key={stage} className="flex items-center gap-1">
            <div
              className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] ${
                rejected && done
                  ? 'bg-red-950/60 text-red-300'
                  : accepted
                    ? 'bg-emerald-950 text-emerald-300'
                    : isCurrent
                      ? 'bg-emerald-900/70 text-emerald-200'
                      : done
                        ? 'bg-neutral-800 text-neutral-300'
                        : 'bg-neutral-950 text-neutral-600'
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  rejected && done ? 'bg-red-400' : done ? 'bg-emerald-400' : 'bg-neutral-700'
                }`}
              />
              {STAGE_LABEL[stage]}
            </div>
            {i < PIPELINE.length - 1 && (
              <span className={`h-px w-3 ${i < currentIdx ? 'bg-emerald-700' : 'bg-neutral-800'}`} />
            )}
          </div>
        );
      })}
      {rejected && <span className="ml-1 text-[11px] text-red-400">✕ Rejected</span>}
      {accepted && <span className="ml-1 text-[11px] text-emerald-300">🎉 Accepted</span>}
    </div>
  );
}

/** No reply in a while → what to do about it. */
function FollowUpNudge({ days }: { days: number }) {
  return (
    <div className="mt-3 rounded-lg border border-amber-900/60 bg-amber-950/20 p-3">
      <p className="text-xs text-amber-300">
        <strong className="font-medium">No reply in {days} days.</strong> Applications go cold
        quietly — a nudge often un-sticks them.
      </p>
      <div className="mt-1.5 flex flex-wrap gap-2 text-[11px] text-neutral-400">
        <span className="rounded-full border border-neutral-700 px-2 py-0.5">✉ Follow up with the recruiter</span>
        <span className="rounded-full border border-neutral-700 px-2 py-0.5">🤝 Look for a referral</span>
        <Link href="/" className="rounded-full border border-neutral-700 px-2 py-0.5 hover:border-neutral-500">
          🔁 Apply to similar roles →
        </Link>
      </div>
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
      <div className="text-3xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-xs uppercase tracking-wide text-neutral-400">{label}</div>
    </div>
  );
}

function AppCard({ row, onStatus }: { row: AppRow; onStatus: (id: string, s: Status) => void }) {
  const lastEvent = row.events[0];
  const idle = lastEvent ? daysSince(lastEvent.createdAt) : row.appliedAt ? daysSince(row.appliedAt) : 0;
  const needsFollowUp = row.status === 'APPLIED' && row.appliedAt != null && daysSince(row.appliedAt) >= 7;

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <a href={row.job.url} target="_blank" rel="noreferrer" className="truncate font-medium text-neutral-100 hover:underline">
            {row.job.title}
          </a>
          <div className="truncate text-sm text-neutral-400">
            {row.job.company.name}
            {row.appliedAt
              ? ` · applied ${new Date(row.appliedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`
              : ''}
            {row.status !== 'SAVED' && idle > 0 ? ` · ${idle}d in stage` : ''}
          </div>
        </div>
        <select
          value={row.status}
          onChange={(e) => onStatus(row.id, e.target.value as Status)}
          className="shrink-0 rounded-lg border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-xs font-medium text-neutral-200"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-3">
        <StageBar status={row.status} />
      </div>

      {needsFollowUp && <FollowUpNudge days={daysSince(row.appliedAt!)} />}
    </div>
  );
}

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

  const active = rows?.filter((r) => !['REJECTED', 'WITHDRAWN', 'ACCEPTED'].includes(r.status)) ?? [];
  const closed = rows?.filter((r) => ['REJECTED', 'WITHDRAWN', 'ACCEPTED'].includes(r.status)) ?? [];

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
            <Stat value={stats.applied} label="Applied" />
            <Stat value={stats.interviews} label="Interviews" />
            <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
              <div className="text-3xl font-semibold tabular-nums">
                {stats.interviewRate === null ? '—' : `${stats.interviewRate}%`}
              </div>
              <div className="mt-1 text-xs uppercase tracking-wide text-neutral-400">Interview rate</div>
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
            No applications tracked yet. Hit <b>I applied</b> on a job after you apply — that&apos;s
            what turns the Applied number real and starts the timeline.
          </p>
        )}

        {active.length > 0 && (
          <section className="mt-6 space-y-3">
            {active.map((r) => (
              <AppCard key={r.id} row={r} onStatus={setStatus} />
            ))}
          </section>
        )}

        {closed.length > 0 && (
          <section className="mt-8">
            <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">Closed</h2>
            <div className="mt-3 space-y-3 opacity-70">
              {closed.map((r) => (
                <AppCard key={r.id} row={r} onStatus={setStatus} />
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
