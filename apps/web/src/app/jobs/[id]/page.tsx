'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { apiGet, apiPost } from '../../../lib/api';

interface JobDetail {
  id: string;
  title: string;
  description: string;
  url: string;
  location: string | null;
  workMode: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  currency: string | null;
  postedAt: string | null;
  firstSeenAt: string;
  company: {
    name: string;
    website: string | null;
    careerPageUrl: string | null;
    atsProvider: string;
  };
  skills: { skill: { name: string } }[];
}

interface Why {
  decision: string;
  reason: string;
  [k: string]: unknown;
}

export default function JobPage() {
  const { id } = useParams<{ id: string }>();
  const [job, setJob] = useState<JobDetail | null>(null);
  const [why, setWhy] = useState<Why | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tracked, setTracked] = useState(false);

  useEffect(() => {
    if (!id) return;
    apiGet<JobDetail>(`/jobs/${id}`).then(setJob).catch((e) => setError(String(e)));
    apiGet<Why>(`/matches/why/${id}`).then(setWhy).catch(() => setWhy(null));
  }, [id]);

  async function markApplied() {
    if (!id || tracked) return;
    try {
      await apiPost('/applications', { jobId: id });
      setTracked(true);
    } catch {
      /* retryable */
    }
  }

  if (error)
    return (
      <Shell>
        <p className="text-red-400">{error}</p>
      </Shell>
    );
  if (!job)
    return (
      <Shell>
        <p className="text-neutral-400">Loading…</p>
      </Shell>
    );

  const posted = job.postedAt ?? job.firstSeenAt;
  const ageDays = Math.floor((Date.now() - new Date(posted).getTime()) / 86_400_000);
  const salary =
    job.salaryMin == null && job.salaryMax == null
      ? 'Not listed'
      : `${job.currency ?? ''} ${[job.salaryMin, job.salaryMax]
          .filter((n) => n != null)
          .map((n) => Number(n).toLocaleString('en-IN'))
          .join('–')}`;

  return (
    <Shell>
      <Link href="/" className="text-sm text-neutral-500 hover:text-neutral-300">
        ← Mission Control
      </Link>

      <header className="mt-4">
        <h1 className="text-2xl font-semibold tracking-tight">{job.title}</h1>
        <p className="mt-1 text-neutral-400">
          {job.company.name}
          {job.location ? ` · 📍 ${job.location}` : ''}
          {job.workMode ? ` · ${job.workMode.toLowerCase()}` : ''}
        </p>
        <p className="mt-1 text-sm text-neutral-500">
          {ageDays <= 0 ? '🔥 Posted today' : `Posted ${ageDays}d ago`} · 💰 {salary}
        </p>
      </header>

      <div className="mt-5 flex gap-3">
        <a
          href={job.url}
          target="_blank"
          rel="noreferrer"
          className="rounded-lg bg-neutral-100 px-4 py-2 font-medium text-neutral-950 hover:bg-white"
        >
          🚀 Apply on company site
        </a>
        <button
          onClick={markApplied}
          disabled={tracked}
          className={`rounded-lg border px-4 py-2 font-medium ${
            tracked
              ? 'border-emerald-800 bg-emerald-950 text-emerald-300'
              : 'border-neutral-700 text-neutral-300 hover:border-neutral-500'
          }`}
        >
          {tracked ? '✓ Tracked' : 'I applied'}
        </button>
      </div>

      {why && (
        <section className="mt-6 rounded-xl border border-neutral-800 bg-neutral-900 p-4">
          <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-400">
            Why CareerOS {why.decision === 'notified' ? 'recommended' : 'ranked'} this
          </h2>
          <p className="mt-2 text-sm text-neutral-200">{why.reason}</p>
        </section>
      )}

      {job.skills.length > 0 && (
        <section className="mt-4 flex flex-wrap gap-2">
          {job.skills.map((s) => (
            <span
              key={s.skill.name}
              className="rounded-full border border-neutral-700 bg-neutral-950 px-3 py-1 text-sm text-neutral-300"
            >
              {s.skill.name}
            </span>
          ))}
        </section>
      )}

      <section className="mt-6">
        <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-400">
          Full description
        </h2>
        <div className="mt-3 whitespace-pre-line rounded-xl border border-neutral-800 bg-neutral-900 p-5 text-[15px] leading-relaxed text-neutral-200">
          {job.description}
        </div>
      </section>

      <section className="mt-6 text-sm text-neutral-500">
        {job.company.careerPageUrl && (
          <a
            href={job.company.careerPageUrl}
            target="_blank"
            rel="noreferrer"
            className="hover:text-neutral-300"
          >
            🏢 All openings at {job.company.name} →
          </a>
        )}
      </section>
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
