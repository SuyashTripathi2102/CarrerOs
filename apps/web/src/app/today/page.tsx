'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiGet, apiPost } from '@/lib/api';

/**
 * Fire-and-forget outcome logging — never blocks navigation, never throws.
 *
 * `displayedScore` is the number this page actually put on screen, which is NOT
 * the persisted verdict in job_matches — the two are different scoring paths and
 * are known to disagree. Sending it lets the event record what the user saw.
 */
function track(jobId: string, type: 'CLICKED' | 'DISMISSED', rank: number, a: Action) {
  apiPost('/events', {
    jobId,
    type,
    surface: 'today',
    rank,
    // What this card claimed. POTENTIAL cards show no score, and record none.
    displayedScore: a.opportunity,
    displayedVerdict: a.kind === 'APPLY' ? 'APPLY' : a.kind === 'POTENTIAL' ? 'POTENTIAL' : undefined,
  }).catch(() => {});
}

type Impact = 'DO_FIRST' | 'HIGH' | 'MEDIUM' | 'LOW';
interface Action {
  kind: string;
  title: string;
  detail: string;
  chips: string[];
  impact: Impact;
  minutes: number;
  href: string;
  value?: string;
  why?: string[];
  /** Present only on job-bound kinds (APPLY / POTENTIAL / TAILOR / REFERRAL). */
  jobId?: string;
  /** Canonical Opportunity Score from the decision engine. Absent on POTENTIAL
   *  cards, which are candidates CareerOS has not evaluated. */
  opportunity?: number;
}
interface Today {
  greeting: string;
  name: string | null;
  goal: { label: string; done: number; target: number };
  weekProbability: 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH';
  probabilityReason: string;
  totalMinutes: number;
  actions: Action[];
}

const KIND_ICON: Record<string, string> = {
  REPLY: '💬',
  FOLLOW_UP: '✉️',
  APPLY: '🚀',
  POTENTIAL: '🔍',
  TAILOR: '📄',
  REFERRAL: '🤝',
  MASTER_RESUME: '🗂️',
  LEARN: '📚',
};
const IMPACT: Record<Impact, { label: string; cls: string }> = {
  DO_FIRST: { label: 'DO THIS FIRST', cls: 'border-emerald-700 bg-emerald-950/50 text-emerald-300' },
  HIGH: { label: 'HIGH IMPACT', cls: 'border-sky-800 bg-sky-950/40 text-sky-300' },
  MEDIUM: { label: 'WORTH DOING', cls: 'border-neutral-700 bg-neutral-900 text-neutral-300' },
  LOW: { label: 'IF YOU HAVE TIME', cls: 'border-neutral-800 bg-neutral-950 text-neutral-500' },
};

export default function TodayPage() {
  const [data, setData] = useState<Today | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Session-local, exactly as /browse does it — see the note by `dismiss`. */
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    apiGet<Today>('/today')
      .then((d) => {
        setData(d);
        // Log impressions once per load — the CTR/apply-rate denominator.
        // Rank is the position in the rendered list, so a later comparison of
        // "shown at rank 1" vs "shown at rank 5" is possible. Actions with no
        // jobId (MASTER_RESUME, LEARN, outreach) are not opportunities and are
        // deliberately excluded rather than logged against a placeholder.
        const items = d.actions
          .map((a, i) => ({
            jobId: a.jobId,
            rank: i + 1,
            displayedScore: a.opportunity,
            displayedVerdict: a.kind === 'APPLY' ? 'APPLY' : a.kind === 'POTENTIAL' ? 'POTENTIAL' : undefined,
          }))
          .filter(
            (
              x,
            ): x is {
              jobId: string;
              rank: number;
              displayedScore: number | undefined;
              displayedVerdict: string | undefined;
            } => Boolean(x.jobId),
          );
        if (items.length > 0) {
          apiPost('/events/impressions', { surface: 'today', items }).catch(() => {});
        }
      })
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <Shell><p className="text-red-400">{error}</p></Shell>;
  if (!data) return <Shell><p className="text-neutral-400">Planning your day…</p></Shell>;

  // Rank is the position at IMPRESSION time and must NOT shift when a card is
  // dismissed: the SHOWN and CLICKED rows for one job have to agree or CTR by
  // position stops being computable. Display position is a separate number, so
  // the list renumbers on screen while the logged rank stays put.
  const visible = data.actions
    .map((a, i) => ({ a, rank: i + 1 }))
    .filter(({ a }) => !(a.jobId && dismissed.has(a.jobId)));
  // today.service.ts computes this as the plain sum of card minutes, so the
  // same sum over the visible cards keeps the header honest after a dismissal.
  const totalMinutes = visible.reduce((n, { a }) => n + a.minutes, 0);

  /**
   * Record the outcome, then hide the card. The event is what matters: /today
   * could previously only ever emit SHOWN and CLICKED, so the dismissed half of
   * every signal-lift comparison was structurally unobservable and `lift` was
   * null by construction.
   *
   * Nothing server-side suppresses a dismissed job yet, so this holds for the
   * session only and the card returns on reload — the same behaviour /browse
   * has. Worth knowing before reading nDismissed: one job dismissed on three
   * days counts three times.
   */
  const dismiss = (a: Action, rank: number) => {
    if (!a.jobId) return;
    track(a.jobId, 'DISMISSED', rank, a);
    setDismissed((prev) => new Set(prev).add(a.jobId as string));
  };

  const goalDone = data.goal.done >= data.goal.target;
  const pct = Math.min(100, Math.round((data.goal.done / data.goal.target) * 100));

  return (
    <Shell>
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-xl font-semibold tracking-tight text-neutral-300">
          {data.greeting}
          {data.name ? `, ${data.name.split(' ')[0]}` : ''}
        </h1>
        <nav className="flex items-center gap-3 text-sm text-neutral-500">
          <Link href="/" className="hover:text-neutral-300">Board</Link>
          <Link href="/applications" className="hover:text-neutral-300">Applications</Link>
          <Link href="/outreach" className="hover:text-neutral-300">Outreach</Link>
        </nav>
      </div>

      {/* The mission, not a metric. */}
      <section className="mt-3">
        <div className="text-[11px] font-medium uppercase tracking-[0.15em] text-neutral-500">
          Today&apos;s mission
        </div>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight">
          {visible.length === 0
            ? 'Line up your next opportunity'
            : 'Your fastest path to an interview today'}
        </h2>
        <p className="mt-1 text-sm text-neutral-400">
          {visible.length} action{visible.length === 1 ? '' : 's'} · ~{totalMinutes} min ·{' '}
          <span className="text-neutral-500">{data.probabilityReason}</span>
        </p>
      </section>

      {/* Goal progress — something to complete. */}
      <section className="mt-4 rounded-xl border border-neutral-800 bg-neutral-900 p-4">
        <div className="flex items-center justify-between text-sm">
          <span className={goalDone ? 'text-emerald-300' : 'text-neutral-200'}>
            {goalDone ? '✓ ' : ''}{data.goal.label}
          </span>
          <span className="tabular-nums text-neutral-400">
            {data.goal.done} / {data.goal.target}
          </span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-neutral-800">
          <div
            className={`h-full rounded-full ${goalDone ? 'bg-emerald-500' : 'bg-sky-500'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        {goalDone && (
          <p className="mt-2 text-[12px] text-emerald-400/90">
            Done for today. Anything below is a bonus — come back tomorrow.
          </p>
        )}
      </section>

      {visible.length === 0 ? (
        <p className="mt-6 rounded-xl border border-neutral-800 bg-neutral-900/60 p-6 text-sm text-neutral-400">
          Nothing queued right now. Head to the{' '}
          <Link href="/" className="text-sky-300 hover:underline">board</Link> — as soon as there&apos;s a
          strong fresh match, your apply / referral / tailor plan appears here.
        </p>
      ) : (
        <ol className="mt-5 space-y-3">
          {visible.map(({ a, rank }, i) => (
            <ActionCard
              key={a.jobId ?? `${a.kind}-${rank}`}
              a={a}
              rank={rank}
              step={i + 1}
              total={visible.length}
              onDismiss={() => dismiss(a, rank)}
            />
          ))}
        </ol>
      )}
    </Shell>
  );
}

function ActionCard({
  a,
  rank,
  step,
  total,
  onDismiss,
}: {
  a: Action;
  /** Position at impression time — what gets logged. Never renumbered. */
  rank: number;
  /** Position on screen right now — what gets displayed. */
  step: number;
  total: number;
  onDismiss: () => void;
}) {
  const imp = IMPACT[a.impact];
  // The border lives on the <li> so the dismiss control can sit inside the same
  // card frame while remaining OUTSIDE the <Link>: a <button> nested in an <a>
  // is invalid markup, and the click would navigate as well as dismiss.
  return (
    <li
      className={`overflow-hidden rounded-xl border bg-neutral-900 transition hover:border-neutral-600 ${
        a.impact === 'DO_FIRST' ? 'border-emerald-900/60' : 'border-neutral-800'
      }`}
    >
      <Link
        href={a.href}
        onClick={() => {
          // `rank`, not `step`: this must match the rank sent with the
          // impression so CTR by position is computable without a join.
          if (a.jobId) track(a.jobId, 'CLICKED', rank, a);
        }}
        className="block p-4"
      >
        <div className="flex items-center gap-2 text-[10px]">
          <span className="text-neutral-500">STEP {step} OF {total}</span>
          <span className={`rounded-full border px-2 py-0.5 font-medium tracking-wide ${imp.cls}`}>
            {imp.label}
          </span>
          <span className="ml-auto text-neutral-500">~{a.minutes} min</span>
        </div>

        <div className="mt-1.5 flex items-start gap-2.5">
          <span className="text-lg">{KIND_ICON[a.kind] ?? '•'}</span>
          <div className="min-w-0 flex-1">
            <div className="font-medium text-neutral-100">{a.title}</div>
            <p className="mt-0.5 text-[12.5px] text-neutral-400">{a.detail}</p>

            {/* Why this first — remove the doubt. */}
            {a.why && a.why.length > 0 && (
              <div className="mt-2 rounded-lg border border-neutral-800 bg-neutral-950/60 p-2.5">
                <div className="text-[10px] uppercase tracking-wide text-neutral-500">Why first</div>
                <ul className="mt-1 space-y-0.5">
                  {a.why.map((w, j) => (
                    <li key={j} className="text-[12px] text-neutral-300">
                      <span className="text-emerald-400">•</span> {w}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {(a.chips.length > 0 || a.value) && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {a.chips.map((c) => (
                  <span
                    key={c}
                    className="rounded border border-neutral-700 bg-neutral-950/60 px-1.5 py-0.5 text-[10px] text-neutral-300"
                  >
                    {c}
                  </span>
                ))}
                {a.value && <span className="text-[11px] text-emerald-400/90">{a.value}</span>}
              </div>
            )}
          </div>
          <span className="self-center text-neutral-500">→</span>
        </div>
      </Link>

      {/* Only job-bound cards are dismissible. MASTER_RESUME and LEARN are not
          opportunities, so a dismissal there would say nothing about ranking.
          Kept plainly visible rather than hover-revealed: /browse hides its ×
          behind `opacity-0 group-hover`, and produced no dismissals at all. */}
      {a.jobId && (
        <div className="flex justify-end border-t border-neutral-800 px-4 py-1.5">
          <button
            type="button"
            onClick={onDismiss}
            aria-label={`Dismiss "${a.title}" as not relevant`}
            className="rounded px-2 py-0.5 text-[11px] text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-300"
          >
            Not relevant
          </button>
        </div>
      )}
    </li>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-neutral-950 px-4 py-8 text-neutral-100">
      <div className="mx-auto w-full max-w-2xl">{children}</div>
    </main>
  );
}
