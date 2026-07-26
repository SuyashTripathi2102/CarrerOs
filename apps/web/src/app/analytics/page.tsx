'use client';

import { useEffect, useState } from 'react';
import { apiGet } from '@/lib/api';

interface Quality {
  shown: number;
  clicked: number;
  dismissed: number;
  applied: number;
  ctr: number | null;
  applyRate: number | null;
  dismissRate: number | null;
  avgScoreApplied: number | null;
  avgScoreDismissed: number | null;
}
interface SignalLift {
  module: string;
  avgWhenEngaged: number;
  avgWhenDismissed: number;
  lift: number;
  nEngaged: number;
  nDismissed: number;
}
interface QualityResp {
  window: string;
  quality: Quality;
  signals: SignalLift[];
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
      <div className="text-3xl font-semibold tabular-nums tracking-tight">{value}</div>
      <div className="mt-1 text-xs uppercase tracking-wide text-neutral-400">{label}</div>
      {hint && <div className="text-[11px] text-neutral-500">{hint}</div>}
    </div>
  );
}

const pctText = (v: number | null) => (v == null ? '—' : `${v}%`);
const numText = (v: number | null) => (v == null ? '—' : String(v));

export default function AnalyticsPage() {
  const [data, setData] = useState<QualityResp | null>(null);

  useEffect(() => {
    apiGet<QualityResp>('/analytics/quality').then(setData).catch(() => setData(null));
  }, []);

  return (
    <main className="min-h-screen bg-neutral-950 px-4 py-8 text-neutral-100">
      <div className="mx-auto w-full max-w-3xl">
        <header className="flex items-baseline justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Recommendation quality</h1>
            <p className="text-sm text-neutral-400">
              Do the recommendations earn engagement? This learns from what you actually do.
            </p>
          </div>
          <a href="/" className="text-sm text-neutral-400 hover:text-neutral-200">
            ← Mission Control
          </a>
        </header>

        {!data && <p className="mt-8 text-sm text-neutral-500">Loading…</p>}

        {data && data.quality.shown === 0 && (
          <p className="mt-8 rounded-xl border border-neutral-800 bg-neutral-900 p-4 text-sm text-neutral-400">
            No interaction data yet. As you browse, click, dismiss and apply, this fills in — the
            outcome log started recording at deploy and can&apos;t be backfilled, so the numbers grow
            from here.
          </p>
        )}

        {data && data.quality.shown > 0 && (
          <>
            <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Tile label="Shown" value={data.quality.shown.toLocaleString()} hint="impressions" />
              <Tile label="CTR" value={pctText(data.quality.ctr)} hint="clicked ÷ shown" />
              <Tile label="Apply rate" value={pctText(data.quality.applyRate)} hint="applied ÷ shown" />
              <Tile
                label="Dismiss rate"
                value={pctText(data.quality.dismissRate)}
                hint="dismissed ÷ shown"
              />
            </section>

            <section className="mt-4 grid grid-cols-2 gap-3">
              <Tile
                label="Avg score — applied"
                value={numText(data.quality.avgScoreApplied)}
                hint="opportunity score of jobs you applied to"
              />
              <Tile
                label="Avg score — dismissed"
                value={numText(data.quality.avgScoreDismissed)}
                hint="opportunity score of jobs you dismissed"
              />
            </section>

            {data.signals.length > 0 && (
              <section className="mt-8 rounded-xl border border-neutral-800 bg-neutral-900 p-4">
                <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-400">
                  Signal lift
                </h2>
                <p className="mt-1 text-[12px] text-neutral-500">
                  For each score signal: its average value on jobs you engaged with vs. dismissed.
                  Positive lift = the signal actually predicts your engagement.
                </p>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[460px] text-sm">
                    <thead>
                      <tr className="text-left text-[10px] uppercase tracking-wide text-neutral-500">
                        <th className="pb-2 font-medium">Signal</th>
                        <th className="pb-2 text-right font-medium">Engaged</th>
                        <th className="pb-2 text-right font-medium">Dismissed</th>
                        <th className="pb-2 text-right font-medium">Lift</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.signals.map((s) => (
                        <tr key={s.module} className="border-t border-neutral-800">
                          <td className="py-2 text-neutral-200">{s.module}</td>
                          <td className="py-2 text-right tabular-nums text-neutral-300">
                            {s.avgWhenEngaged}
                          </td>
                          <td className="py-2 text-right tabular-nums text-neutral-500">
                            {s.avgWhenDismissed}
                          </td>
                          <td
                            className={`py-2 text-right font-medium tabular-nums ${
                              s.lift > 5
                                ? 'text-emerald-400'
                                : s.lift < -5
                                  ? 'text-red-400'
                                  : 'text-neutral-400'
                            }`}
                          >
                            {s.lift > 0 ? '+' : ''}
                            {s.lift}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-3 text-[11px] text-neutral-600">
                  Window: last {data.window}. This is evidence for tuning the weights by hand — not
                  auto-retraining. Collect ~90 days before drawing conclusions.
                </p>
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
