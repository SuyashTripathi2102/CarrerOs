'use client';

import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '@/lib/api';

interface ReviewJob {
  jobId: string;
  title: string;
  company: string;
  location: string | null;
  url: string;
  postedAgeDays: number;
  roleFamily: string;
  primaryFunction: string;
  codingIntensity: string;
  seniority: string;
  minimumYears: number | null;
  developmentConfidence: number | null;
  targetRoleFit: number | null;
  specializationFit: number | null;
  resumeFit: number | null;
  requiredSkills: string[];
  developmentEvidence: string[];
  nonDevelopmentEvidence: string[];
  whyUncertain: string;
}

const humanize = (s: string) => s.replace(/_/g, ' ').toLowerCase();

function Dimension({ label, value }: { label: string; value: number | null }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="text-sm text-neutral-200">{value === null ? '—' : `${value}%`}</div>
    </div>
  );
}

export default function NeedsReviewPage() {
  const [jobs, setJobs] = useState<ReviewJob[] | null>(null);
  const [reviewed, setReviewed] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ jobs: ReviewJob[]; reviewed: number }>('/needs-review').then((d) => {
      setJobs(d.jobs);
      setReviewed(d.reviewed);
    });
  }, []);

  async function judge(jobId: string, relevant: boolean) {
    setBusy(jobId);
    try {
      await apiPost(`/needs-review/${jobId}`, { relevant });
      setJobs((prev) => prev?.filter((j) => j.jobId !== jobId) ?? null);
      setReviewed((n) => n + 1);
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">Needs review</h1>
        <p className="mt-1 max-w-2xl text-sm text-neutral-400">
          CareerOS could not confidently decide what these jobs are. They are never auto-applied
          and never sent to Telegram. Your answer is stored against you, not against the job — a
          reclassification will not overwrite it.
        </p>
      </header>

      {jobs === null && <p className="mt-8 text-sm text-neutral-500">Loading…</p>}

      {jobs?.length === 0 && (
        <div className="mt-8 rounded-lg border border-neutral-800 bg-neutral-950 p-6">
          <p className="text-sm text-neutral-300">Nothing is waiting on you.</p>
          <p className="mt-1 text-xs text-neutral-500">
            {reviewed > 0
              ? `You have reviewed ${reviewed} job${reviewed === 1 ? '' : 's'}.`
              : 'Every actionable job was classified confidently.'}
          </p>
        </div>
      )}

      <div className="mt-8 space-y-4">
        {jobs?.map((j) => (
          <article key={j.jobId} className="rounded-xl border border-neutral-800 bg-neutral-950 p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-base font-medium text-neutral-100">{j.title}</h2>
                <p className="mt-0.5 text-xs text-neutral-500">
                  {j.company}
                  {j.location ? ` · ${j.location}` : ''} · posted {j.postedAgeDays}d ago
                </p>
              </div>
              <span className="shrink-0 rounded-full border border-amber-900 bg-amber-950/60 px-2.5 py-1 text-[11px] text-amber-300">
                {humanize(j.roleFamily)}
              </span>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Dimension label="Development" value={j.developmentConfidence} />
              <Dimension label="Target role" value={j.targetRoleFit} />
              <Dimension label="Specialization" value={j.specializationFit} />
              <Dimension label="Resume fit" value={j.resumeFit} />
            </div>

            <dl className="mt-4 space-y-2 text-xs">
              <div className="flex gap-2">
                <dt className="w-28 shrink-0 text-neutral-500">Coding</dt>
                <dd className="text-neutral-300">
                  {humanize(j.codingIntensity)} · {humanize(j.seniority)}
                  {j.minimumYears !== null ? ` · min ${j.minimumYears}y` : ' · no stated minimum'}
                </dd>
              </div>
              {j.requiredSkills.length > 0 && (
                <div className="flex gap-2">
                  <dt className="w-28 shrink-0 text-neutral-500">Required</dt>
                  <dd className="text-neutral-300">{j.requiredSkills.join(', ')}</dd>
                </div>
              )}
              {j.developmentEvidence.length > 0 && (
                <div className="flex gap-2">
                  <dt className="w-28 shrink-0 text-neutral-500">Says build</dt>
                  <dd className="text-emerald-400/80">“{j.developmentEvidence[0]}”</dd>
                </div>
              )}
              {j.nonDevelopmentEvidence.length > 0 && (
                <div className="flex gap-2">
                  <dt className="w-28 shrink-0 text-neutral-500">Says otherwise</dt>
                  <dd className="text-amber-400/80">“{j.nonDevelopmentEvidence[0]}”</dd>
                </div>
              )}
              <div className="flex gap-2">
                <dt className="w-28 shrink-0 text-neutral-500">Why unsure</dt>
                <dd className="text-neutral-400">{j.whyUncertain}</dd>
              </div>
            </dl>

            <div className="mt-5 flex items-center gap-2">
              <button
                onClick={() => judge(j.jobId, true)}
                disabled={busy === j.jobId}
                className="rounded-lg border border-emerald-800 bg-emerald-950/60 px-3 py-1.5 text-xs text-emerald-300 hover:border-emerald-600 disabled:opacity-50"
              >
                Relevant
              </button>
              <button
                onClick={() => judge(j.jobId, false)}
                disabled={busy === j.jobId}
                className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:border-neutral-500 disabled:opacity-50"
              >
                Not relevant
              </button>
              <a
                href={j.url}
                target="_blank"
                rel="noreferrer"
                className="ml-auto text-xs text-neutral-500 underline-offset-2 hover:text-neutral-300 hover:underline"
              >
                View full JD ↗
              </a>
            </div>
          </article>
        ))}
      </div>
    </main>
  );
}
