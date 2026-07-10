'use client';

import { useEffect, useState } from 'react';
import { apiGet } from '../../lib/api';

interface Insights {
  funnel: { crawled: number; applied: number };
  pipeline: {
    lastSuccessfulCrawl: string | null;
    crawls: { succeeded: number; failed: number; topFailures: { reason: string; count: number }[] };
    newJobs: number;
    indiaJobs: number;
    apply: number;
    consider: number;
    notificationsSent: number;
    explanation: string;
  };
  supply: {
    freshIndiaEngineering7d: number;
    actionable: number;
    actionableEvaluated: number;
    coveragePct: number;
    zombieHidden: number;
    totalIndiaEngineering: number;
  };
}

interface SourceFunnel {
  source: string;
  companies: number;
  careerPages: number;
  atsDetected: number;
  freshIndia30d: number;
  targetRole30d: number;
  targetRolePer100Companies: number;
}

function Tile({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
      <div className="text-3xl font-semibold tabular-nums tracking-tight">{value.toLocaleString()}</div>
      <div className="mt-1 text-xs uppercase tracking-wide text-neutral-400">{label}</div>
      {hint && <div className="text-[11px] text-neutral-500">{hint}</div>}
    </div>
  );
}

function PipeStat({ label, value, tone }: { label: string; value: number; tone?: 'good' | 'mid' }) {
  const color =
    tone === 'good' ? 'text-emerald-400' : tone === 'mid' ? 'text-amber-400' : 'text-neutral-100';
  return (
    <div className="rounded-lg bg-neutral-950/60 px-2 py-2 text-center">
      <div className={`text-xl font-semibold tabular-nums ${color}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-neutral-500">{label}</div>
    </div>
  );
}

export default function InsightsPage() {
  const [data, setData] = useState<Insights | null>(null);
  const [sources, setSources] = useState<SourceFunnel[] | null>(null);

  useEffect(() => {
    apiGet<Insights>('/dashboard').then(setData);
    apiGet<SourceFunnel[]>('/dashboard/sources')
      .then(setSources)
      .catch(() => setSources([]));
  }, []);

  return (
    <main className="min-h-screen bg-neutral-950 px-4 py-8 text-neutral-100">
      <div className="mx-auto w-full max-w-3xl">
        <header className="flex items-baseline justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Discovery health</h1>
            <p className="text-sm text-neutral-400">
              How the crawler is doing — this is telemetry, not your job decisions.
            </p>
          </div>
          <a href="/" className="text-sm text-neutral-400 hover:text-neutral-200">
            ← Mission Control
          </a>
        </header>

        {!data && <p className="mt-8 text-sm text-neutral-500">Loading…</p>}

        {data && (
          <>
            <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Tile
                label="Fresh this week"
                value={data.supply.freshIndiaEngineering7d}
                hint="India engineering, ≤7 days"
              />
              <Tile label="Actionable now" value={data.supply.actionable} hint="≤30 days old" />
              <Tile
                label="Evaluated"
                value={data.supply.coveragePct}
                hint={`% of actionable (${data.supply.actionableEvaluated}/${data.supply.actionable})`}
              />
              <Tile label="Applied" value={data.funnel.applied} hint="the number that matters" />
            </section>
            <p className="mt-2 text-[11px] text-neutral-600">
              {data.supply.zombieHidden} listings older than 90 days are hidden from these numbers —
              on boards but almost certainly not hiring. Total watched:{' '}
              {data.funnel.crawled.toLocaleString()}.
            </p>

            <section className="mt-6 rounded-xl border border-neutral-800 bg-neutral-900 p-4">
              <div className="flex items-baseline justify-between">
                <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-400">
                  Since 8 AM
                </h2>
                <span className="text-[11px] text-neutral-500">
                  {data.pipeline.lastSuccessfulCrawl
                    ? `last crawl ${new Date(data.pipeline.lastSuccessfulCrawl).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`
                    : 'no crawl yet'}
                </span>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-sm sm:grid-cols-6">
                <PipeStat label="Crawls" value={data.pipeline.crawls.succeeded} />
                <PipeStat label="New jobs" value={data.pipeline.newJobs} />
                <PipeStat label="India" value={data.pipeline.indiaJobs} />
                <PipeStat label="Apply" value={data.pipeline.apply} tone="good" />
                <PipeStat label="Consider" value={data.pipeline.consider} tone="mid" />
                <PipeStat label="Sent" value={data.pipeline.notificationsSent} />
              </div>
              <p className="mt-3 text-sm text-neutral-300">{data.pipeline.explanation}</p>
              {data.pipeline.crawls.failed > 0 && (
                <p className="mt-1 text-[11px] text-amber-500/80">
                  {data.pipeline.crawls.failed} crawls failed
                  {data.pipeline.crawls.topFailures[0]
                    ? ` · ${data.pipeline.crawls.topFailures[0].reason}`
                    : ''}
                </p>
              )}
            </section>

            {sources && sources.length > 0 && (
              <section className="mt-8 rounded-xl border border-neutral-800 bg-neutral-900 p-4">
                <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-400">
                  Source yield
                </h2>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[520px] text-sm">
                    <thead>
                      <tr className="text-left text-[10px] uppercase tracking-wide text-neutral-500">
                        <th className="pb-2 font-medium">Source</th>
                        <th className="pb-2 text-right font-medium">Companies</th>
                        <th className="pb-2 text-right font-medium">Career pages</th>
                        <th className="pb-2 text-right font-medium">ATS</th>
                        <th className="pb-2 text-right font-medium">Target roles</th>
                        <th className="pb-2 text-right font-medium">Per 100</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sources.map((s) => (
                        <tr key={s.source} className="border-t border-neutral-800">
                          <td className="py-2 text-neutral-200">{s.source}</td>
                          <td className="py-2 text-right tabular-nums text-neutral-400">{s.companies}</td>
                          <td className="py-2 text-right tabular-nums text-neutral-400">{s.careerPages}</td>
                          <td className="py-2 text-right tabular-nums text-neutral-400">{s.atsDetected}</td>
                          <td className="py-2 text-right tabular-nums text-neutral-200">{s.targetRole30d}</td>
                          <td
                            className={`py-2 text-right tabular-nums font-medium ${
                              s.targetRolePer100Companies >= 10
                                ? 'text-emerald-400'
                                : s.targetRolePer100Companies >= 2
                                  ? 'text-amber-400'
                                  : 'text-red-400'
                            }`}
                          >
                            {s.targetRolePer100Companies}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-3 text-[11px] text-neutral-500">
                  Target-role India jobs (≤30 days) per 100 companies discovered. Adding companies to
                  a low-yield source does not add opportunities.
                </p>
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
