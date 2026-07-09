'use client';

import { useEffect, useState } from 'react';
import { apiGet } from '@/lib/api';

interface ExcludedJob {
  jobId: string;
  title: string;
  company: string;
  location: string | null;
  url: string;
  postedAgeDays: number;
  roleFamily: string;
  reason: string;
  developmentConfidence: number | null;
  targetRoleFit: number | null;
  specializationFit: number | null;
  evidence: string[];
}

interface Bucket {
  code: string;
  label: string;
  count: number;
  jobs: ExcludedJob[];
}

const humanize = (s: string) => s.replace(/_/g, ' ').toLowerCase();

export default function ExcludedPage() {
  const [data, setData] = useState<{ total: number; buckets: Bucket[] } | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ total: number; buckets: Bucket[] }>('/excluded').then(setData);
  }, []);

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">
          Excluded by CareerOS
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-neutral-400">
          Every job CareerOS rejected, and the exact reason. This page changes nothing — it exists
          so a wrong exclusion is visible instead of silent. If something here should not be, that
          is a bug in the classifier, not in your search.
        </p>
      </header>

      {data === null && <p className="mt-8 text-sm text-neutral-500">Loading…</p>}

      {data && (
        <>
          <p className="mt-6 text-xs text-neutral-500">
            {data.total} active job{data.total === 1 ? '' : 's'} excluded, against your active
            resume.
          </p>

          <div className="mt-4 space-y-3">
            {data.buckets.map((b) => (
              <section key={b.code} className="rounded-xl border border-neutral-800 bg-neutral-950">
                <button
                  onClick={() => setOpen(open === b.code ? null : b.code)}
                  className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
                >
                  <div>
                    <h2 className="text-sm font-medium text-neutral-100">{b.label}</h2>
                    <p className="mt-0.5 font-mono text-[10px] text-neutral-600">{b.code}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm tabular-nums text-neutral-400">{b.count}</span>
                    <span className="text-neutral-600">{open === b.code ? '−' : '+'}</span>
                  </div>
                </button>

                {open === b.code && (
                  <div className="divide-y divide-neutral-900 border-t border-neutral-900">
                    {b.jobs.map((j) => (
                      <div key={j.jobId} className="px-5 py-4">
                        <div className="flex items-start justify-between gap-4">
                          <div className="min-w-0">
                            <p className="truncate text-sm text-neutral-200">{j.title}</p>
                            <p className="mt-0.5 text-xs text-neutral-500">
                              {j.company}
                              {j.location ? ` · ${j.location}` : ''} · {j.postedAgeDays}d ago ·{' '}
                              {humanize(j.roleFamily)}
                            </p>
                          </div>
                          <a
                            href={j.url}
                            target="_blank"
                            rel="noreferrer"
                            className="shrink-0 text-xs text-neutral-600 hover:text-neutral-300"
                          >
                            View ↗
                          </a>
                        </div>

                        <p className="mt-2 text-xs text-neutral-400">{j.reason}</p>

                        {j.evidence[0] && (
                          <p className="mt-1.5 border-l border-neutral-800 pl-2 text-[11px] italic text-neutral-500">
                            “{j.evidence[0]}”
                          </p>
                        )}

                        <p className="mt-2 font-mono text-[10px] text-neutral-600">
                          dev {j.developmentConfidence ?? '—'} · role {j.targetRoleFit ?? '—'} ·
                          stack {j.specializationFit ?? '—'}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
