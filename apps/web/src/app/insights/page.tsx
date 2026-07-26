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

interface CityCoverage {
  city: string;
  companies: number;
  careerPages: number;
  atsDetected: number;
  monitored: number;
  hiring: number;
  activeJobs: number;
  devJobs: number;
  coverage: number;
}

interface Extraction {
  runs: number;
  jobsExtracted: number;
  companiesTotal: number;
  companiesProcessed: number;
  processedPct: number;
  lastRun: string | null;
}

interface Replay {
  snapshots: number;
  behindCurrentVersion: number;
  jobsAccepted: number;
  avgConfidence: number;
  currentVersion: string;
}

interface SourceTrust {
  source: string;
  baseline: number;
  trustScore: number;
  jobsActive: number;
  jobsStale: number;
  jobsFresh: number;
}

interface Pipeline {
  window: string;
  runs: number;
  funnel: {
    queued: number;
    fetched: number;
    fetchFailed: number;
    parsed: number;
    accepted: number;
    ingested: number;
    duplicates: number;
    snapshotted: number;
  };
  quality: {
    avgConfidence: number;
    jobsPerPage: number;
    avgFetchMs: number;
    avgParseMs: number;
    topRejections: { reason: string; count: number }[];
  };
  stages: { activeJobs: number; embedded: number; ranked: number };
}

/** One stage in the horizontal funnel, with the drop-off from the previous stage. */
function FunnelStep({
  label,
  value,
  prev,
  tone,
}: {
  label: string;
  value: number;
  prev?: number;
  tone?: 'good' | 'mid' | 'bad';
}) {
  const dropPct =
    prev && prev > 0 && value <= prev ? Math.round(((prev - value) / prev) * 100) : null;
  const color =
    tone === 'good'
      ? 'text-emerald-400'
      : tone === 'mid'
        ? 'text-amber-400'
        : tone === 'bad'
          ? 'text-red-400'
          : 'text-neutral-100';
  return (
    <div className="flex min-w-[84px] flex-1 flex-col items-center">
      <div className={`text-2xl font-semibold tabular-nums ${color}`}>{value.toLocaleString()}</div>
      <div className="mt-1 text-center text-[10px] uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      {dropPct != null && dropPct > 0 && (
        <div className="text-[10px] text-neutral-600">−{dropPct}%</div>
      )}
    </div>
  );
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
  const [cities, setCities] = useState<CityCoverage[] | null>(null);
  const [extraction, setExtraction] = useState<Extraction | null>(null);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [trust, setTrust] = useState<SourceTrust[] | null>(null);
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);

  useEffect(() => {
    apiGet<Insights>('/dashboard').then(setData);
    apiGet<SourceFunnel[]>('/dashboard/sources')
      .then(setSources)
      .catch(() => setSources([]));
    apiGet<CityCoverage[]>('/discovery/coverage')
      .then(setCities)
      .catch(() => setCities([]));
    apiGet<Extraction>('/discovery/extraction')
      .then(setExtraction)
      .catch(() => setExtraction(null));
    apiGet<Replay>('/discovery/replay')
      .then(setReplay)
      .catch(() => setReplay(null));
    apiGet<SourceTrust[]>('/source-trust')
      .then(setTrust)
      .catch(() => setTrust([]));
    apiGet<Pipeline>('/discovery/pipeline')
      .then(setPipeline)
      .catch(() => setPipeline(null));
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

            {pipeline && pipeline.runs > 0 && (
              <section className="mt-8 rounded-xl border border-neutral-800 bg-neutral-900 p-4">
                <div className="flex items-baseline justify-between">
                  <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-400">
                    Extraction pipeline
                  </h2>
                  <span className="text-[11px] text-neutral-500">
                    {pipeline.runs} runs · last {pipeline.window}
                  </span>
                </div>

                <div className="mt-4 flex items-stretch gap-1 overflow-x-auto">
                  <FunnelStep label="Queued" value={pipeline.funnel.queued} />
                  <FunnelStep
                    label="Fetched"
                    value={pipeline.funnel.fetched}
                    prev={pipeline.funnel.queued}
                  />
                  <FunnelStep
                    label="Parsed"
                    value={pipeline.funnel.parsed}
                    prev={pipeline.funnel.fetched}
                  />
                  <FunnelStep
                    label="Accepted"
                    value={pipeline.funnel.accepted}
                    prev={pipeline.funnel.parsed}
                    tone="good"
                  />
                  <FunnelStep
                    label="Ingested"
                    value={pipeline.funnel.ingested}
                    prev={pipeline.funnel.accepted}
                    tone="good"
                  />
                  <FunnelStep label="Embedded" value={pipeline.stages.embedded} tone="mid" />
                  <FunnelStep label="Ranked" value={pipeline.stages.ranked} tone="mid" />
                </div>

                <div className="mt-4 grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
                  <PipeStat label="Avg conf" value={pipeline.quality.avgConfidence} tone="good" />
                  <PipeStat label="Jobs/page" value={pipeline.quality.jobsPerPage} />
                  <PipeStat label="Dup collapsed" value={pipeline.funnel.duplicates} tone="mid" />
                  <PipeStat label="Fetch ms" value={pipeline.quality.avgFetchMs} />
                  <PipeStat label="Parse ms" value={pipeline.quality.avgParseMs} />
                </div>

                {pipeline.quality.topRejections.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <span className="text-[11px] uppercase tracking-wide text-neutral-500">
                      Top rejections:
                    </span>
                    {pipeline.quality.topRejections.map((r) => (
                      <span
                        key={r.reason}
                        className="rounded-full bg-neutral-950/70 px-2 py-0.5 text-[11px] text-neutral-400"
                      >
                        {r.reason} · {r.count.toLocaleString()}
                      </span>
                    ))}
                  </div>
                )}
                <p className="mt-3 text-[11px] text-neutral-500">
                  Queued → fetched → parsed (page yielded ≥1 job) → accepted → ingested, then the
                  global embed → rank stages. A big drop between two stages is exactly where to look.
                </p>
              </section>
            )}

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

            {trust && trust.length > 0 && (
              <section className="mt-8 rounded-xl border border-neutral-800 bg-neutral-900 p-4">
                <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-400">
                  Source trust
                </h2>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[480px] text-sm">
                    <thead>
                      <tr className="text-left text-[10px] uppercase tracking-wide text-neutral-500">
                        <th className="pb-2 font-medium">Ingest source</th>
                        <th className="pb-2 text-right font-medium">Trust</th>
                        <th className="pb-2 text-right font-medium">Baseline</th>
                        <th className="pb-2 text-right font-medium">Active</th>
                        <th className="pb-2 text-right font-medium">Fresh</th>
                        <th className="pb-2 text-right font-medium">Stale</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trust.map((t) => (
                        <tr key={t.source} className="border-t border-neutral-800">
                          <td className="py-2 text-neutral-200">{t.source}</td>
                          <td
                            className={`py-2 text-right font-medium tabular-nums ${
                              t.trustScore >= 95
                                ? 'text-emerald-400'
                                : t.trustScore >= 80
                                  ? 'text-amber-400'
                                  : 'text-red-400'
                            }`}
                          >
                            {t.trustScore}
                          </td>
                          <td className="py-2 text-right tabular-nums text-neutral-500">{t.baseline}</td>
                          <td className="py-2 text-right tabular-nums text-neutral-400">{t.jobsActive}</td>
                          <td className="py-2 text-right tabular-nums text-emerald-400/80">{t.jobsFresh}</td>
                          <td className="py-2 text-right tabular-nums text-red-400/70">{t.jobsStale}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-3 text-[11px] text-neutral-500">
                  A curated baseline nudged by observed listing quality (fresh up, stale down). Feeds
                  a small bounded adjustment into every Opportunity Score.
                </p>
              </section>
            )}

            {extraction && (
              <section className="mt-8 rounded-xl border border-neutral-800 bg-neutral-900 p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-400">
                    Career-page extractor (deterministic v1)
                  </h2>
                  <span className="text-[11px] text-neutral-500">
                    {extraction.lastRun
                      ? `last run ${new Date(extraction.lastRun).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
                      : 'no run yet'}
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                  <PipeStat label="Jobs extracted" value={extraction.jobsExtracted} tone="good" />
                  <PipeStat label="Ingest runs" value={extraction.runs} />
                  <PipeStat label="Pages processed" value={extraction.companiesProcessed} />
                  <PipeStat label="Corpus %" value={extraction.processedPct} tone="mid" />
                </div>
                <p className="mt-3 text-[11px] text-neutral-500">
                  Tier-1 static extraction (no browser, no LLM): {extraction.companiesProcessed} of{' '}
                  {extraction.companiesTotal.toLocaleString()} custom career pages claimed. High
                  precision, modest recall — only anchor-structured pages yield jobs; the rest await
                  the render/LLM tiers.
                </p>

                {replay && (
                  <div className="mt-4 border-t border-neutral-800 pt-3">
                    <div className="flex items-baseline justify-between">
                      <h3 className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
                        Replay corpus · {replay.currentVersion}
                      </h3>
                      {replay.behindCurrentVersion > 0 ? (
                        <span className="text-[11px] text-amber-400">
                          {replay.behindCurrentVersion} behind — re-mining
                        </span>
                      ) : (
                        <span className="text-[11px] text-emerald-400">all current</span>
                      )}
                    </div>
                    <div className="mt-2 grid grid-cols-3 gap-2 text-sm">
                      <PipeStat label="Snapshots" value={replay.snapshots} />
                      <PipeStat label="Jobs held" value={replay.jobsAccepted} tone="good" />
                      <PipeStat label="Avg conf" value={replay.avgConfidence} tone="mid" />
                    </div>
                    <p className="mt-2 text-[11px] text-neutral-600">
                      Stored HTML of every job-bearing page. When the extractor improves, replay
                      re-mines these {replay.snapshots.toLocaleString()} pages for new jobs — no
                      re-crawl.
                    </p>
                  </div>
                )}
              </section>
            )}

            {cities && cities.length > 0 && (
              <section className="mt-8 rounded-xl border border-neutral-800 bg-neutral-900 p-4">
                <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-400">
                  City coverage
                </h2>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[560px] text-sm">
                    <thead>
                      <tr className="text-left text-[10px] uppercase tracking-wide text-neutral-500">
                        <th className="pb-2 font-medium">City</th>
                        <th className="pb-2 text-right font-medium">Known</th>
                        <th className="pb-2 text-right font-medium">Career pages</th>
                        <th className="pb-2 text-right font-medium">Monitored</th>
                        <th className="pb-2 text-right font-medium">Dev jobs</th>
                        <th className="pb-2 text-right font-medium">Coverage</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cities.map((c) => (
                        <tr key={c.city} className="border-t border-neutral-800">
                          <td className="py-2 text-neutral-200">{c.city}</td>
                          <td className="py-2 text-right tabular-nums text-neutral-400">{c.companies}</td>
                          <td className="py-2 text-right tabular-nums text-neutral-400">{c.careerPages}</td>
                          <td className="py-2 text-right tabular-nums text-neutral-400">{c.monitored}</td>
                          <td className="py-2 text-right tabular-nums text-neutral-200">{c.devJobs}</td>
                          <td
                            className={`py-2 text-right tabular-nums font-medium ${
                              c.coverage >= 50
                                ? 'text-emerald-400'
                                : c.coverage >= 20
                                  ? 'text-amber-400'
                                  : 'text-red-400'
                            }`}
                          >
                            {c.coverage}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-3 text-[11px] text-neutral-500">
                  Coverage = monitored ÷ known. The gap between career pages found and monitored is
                  the custom/JavaScript career-page wall — pages we found but can&apos;t yet parse.
                </p>
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
