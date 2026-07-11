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

interface WaitAction {
  label: string;
  detail: string;
  stars: number;
  href?: string;
}
interface Cause {
  factor: string;
  detail: string;
  strength: number;
}
interface IntelItem {
  applicationId: string;
  jobId: string;
  status: string;
  hadReferralContact: boolean;
  tailoredResume: boolean;
  waitingActions: WaitAction[];
  likelyCauses: Cause[];
}
interface Intel {
  funnel: Stats;
  insights: string[];
  items: IntelItem[];
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

const Stars = ({ n, max = 5 }: { n: number; max?: number }) => (
  <span className="text-amber-300">
    {'★'.repeat(n)}
    <span className="text-neutral-700">{'★'.repeat(Math.max(0, max - n))}</span>
  </span>
);

/** While an application is live: the highest-leverage moves, ranked. */
function NextActions({ actions }: { actions: WaitAction[] }) {
  if (!actions.length) return null;
  return (
    <div className="mt-3 rounded-lg border border-neutral-800 bg-neutral-950/60 p-3">
      <p className="text-[11px] uppercase tracking-wide text-neutral-500">Best next moves</p>
      <ul className="mt-1.5 space-y-1">
        {actions.map((a, i) => (
          <li key={i} className="flex items-baseline gap-2 text-[12.5px]">
            <Stars n={a.stars} />
            {a.href ? (
              <Link href={a.href} className="text-sky-300 hover:underline">
                {a.label}
              </Link>
            ) : (
              <span className="text-neutral-200">{a.label}</span>
            )}
            <span className="text-neutral-500">— {a.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** After a rejection / long silence: honest, ranked likely contributors. */
function LikelyCauses({ causes }: { causes: Cause[] }) {
  if (!causes.length) return null;
  return (
    <div className="mt-3 rounded-lg border border-red-900/40 bg-red-950/15 p-3">
      <p className="text-[11px] uppercase tracking-wide text-red-300/80">
        Likely factors (not certainties) — fix the inputs next time
      </p>
      <ul className="mt-1.5 space-y-1.5">
        {causes.map((c, i) => (
          <li key={i} className="text-[12.5px]">
            <span className="mr-1"><Stars n={c.strength} max={4} /></span>
            <span className="font-medium text-neutral-100">{c.factor}</span>
            <span className="text-neutral-400"> — {c.detail}</span>
          </li>
        ))}
      </ul>
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

function AppCard({
  row,
  intel,
  onStatus,
}: {
  row: AppRow;
  intel?: IntelItem;
  onStatus: (id: string, s: Status) => void;
}) {
  const lastEvent = row.events[0];
  const idle = lastEvent ? daysSince(lastEvent.createdAt) : row.appliedAt ? daysSince(row.appliedAt) : 0;
  const active = !['REJECTED', 'WITHDRAWN', 'ACCEPTED'].includes(row.status);

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
          {intel && (
            <div className="mt-1 flex gap-1.5 text-[10px]">
              <span className={intel.hadReferralContact ? 'text-emerald-400' : 'text-neutral-600'}>
                {intel.hadReferralContact ? '✓ referral' : '✗ no referral'}
              </span>
              <span className={intel.tailoredResume ? 'text-emerald-400' : 'text-neutral-600'}>
                {intel.tailoredResume ? '✓ tailored' : '✗ generic resume'}
              </span>
            </div>
          )}
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

      {active && intel && <NextActions actions={intel.waitingActions} />}
      {intel && <LikelyCauses causes={intel.likelyCauses} />}
    </div>
  );
}

export default function ApplicationsPage() {
  const [rows, setRows] = useState<AppRow[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [intel, setIntel] = useState<Intel | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    Promise.all([
      apiGet<AppRow[]>('/applications'),
      apiGet<Stats>('/applications/stats'),
      apiGet<Intel>('/applications/intelligence'),
    ])
      .then(([r, s, i]) => {
        setRows(r);
        setStats(s);
        setIntel(i);
      })
      .catch((e) => setError(String(e)));
  }
  useEffect(load, []);

  const intelById = new Map((intel?.items ?? []).map((i) => [i.applicationId, i]));

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

        {intel && intel.insights.length > 0 && (
          <section className="mt-4 space-y-2">
            {intel.insights.map((t, i) => (
              <p
                key={i}
                className="rounded-lg border border-sky-900/40 bg-sky-950/20 px-3 py-2 text-[13px] text-sky-100/90"
              >
                💡 {t}
              </p>
            ))}
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
              <AppCard key={r.id} row={r} intel={intelById.get(r.id)} onStatus={setStatus} />
            ))}
          </section>
        )}

        {closed.length > 0 && (
          <section className="mt-8">
            <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">Closed</h2>
            <div className="mt-3 space-y-3 opacity-70">
              {closed.map((r) => (
                <AppCard key={r.id} row={r} intel={intelById.get(r.id)} onStatus={setStatus} />
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
