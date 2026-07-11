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
  company: { name: string; website: string | null; careerPageUrl: string | null; atsProvider: string };
  skills: { skill: { name: string } }[];
}

interface Transferable {
  skill: string;
  via: string;
  note: string;
}

interface Detail {
  verdict: {
    verdict: string | null;
    code: string | null;
    reason: string | null;
    action: string | null;
    opportunityScore: number | null;
    developmentConfidence: number | null;
    targetRoleFit: number | null;
    specializationFit: number | null;
    resumeFit: number | null;
    missingSkills: string[];
  } | null;
  classification: {
    roleFamily: string;
    primaryFunction: string;
    codingIntensity: string;
    seniority: string;
    minimumYears: number | null;
    maximumYears: number | null;
    requiredSkills: string[];
    responsibilities: string[];
    developmentEvidence: string[];
  } | null;
  specialization: { fit: number | null; strong: string[]; transferable: Transferable[]; missing: string[] } | null;
}

const humanize = (s: string | null) => (s ? s.replace(/_/g, ' ').toLowerCase() : '');

const VERDICT_STYLE: Record<string, { ring: string; text: string; dot: string; label: string }> = {
  APPLY: { ring: 'border-emerald-700', text: 'text-emerald-300', dot: 'bg-emerald-400', label: 'Apply now' },
  CONSIDER: { ring: 'border-amber-700', text: 'text-amber-300', dot: 'bg-amber-400', label: 'Worth applying' },
  NEEDS_REVIEW: { ring: 'border-sky-700', text: 'text-sky-300', dot: 'bg-sky-400', label: 'Needs review' },
  SKIP: { ring: 'border-neutral-700', text: 'text-neutral-400', dot: 'bg-neutral-500', label: 'Not a match' },
};

function Dim({ label, value, suffix = '%' }: { label: string; value: number | null; suffix?: string }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-950/60 p-3">
      <div className="text-[10px] uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums text-neutral-100">
        {value == null ? '—' : `${value}${suffix}`}
      </div>
    </div>
  );
}

function Bar({ pct }: { pct: number }) {
  const color = pct >= 75 ? 'bg-emerald-500' : pct >= 50 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-800">
      <div className={`h-full ${color}`} style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
    </div>
  );
}

export default function JobPage() {
  const { id } = useParams<{ id: string }>();
  const [job, setJob] = useState<JobDetail | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tracked, setTracked] = useState(false);

  useEffect(() => {
    if (!id) return;
    apiGet<JobDetail>(`/jobs/${id}`).then(setJob).catch((e) => setError(String(e)));
    apiGet<Detail>(`/matches/detail/${id}`).then(setDetail).catch(() => setDetail(null));
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

  const v = detail?.verdict;
  const c = detail?.classification;
  const spec = detail?.specialization;
  const vstyle = (v?.verdict && VERDICT_STYLE[v.verdict]) || VERDICT_STYLE.SKIP;
  const experience = c
    ? c.minimumYears == null
      ? 'No stated minimum'
      : c.maximumYears
        ? `${c.minimumYears}–${c.maximumYears} yrs`
        : `${c.minimumYears}+ yrs`
    : null;

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
          {experience ? ` · 🧭 ${experience}` : ''}
        </p>
      </header>

      {/* VERDICT HERO */}
      {v && v.verdict && (
        <section className={`mt-5 rounded-2xl border ${vstyle.ring} bg-neutral-900 p-5`}>
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className={`flex items-center gap-2 text-sm font-medium ${vstyle.text}`}>
                <span className={`h-2.5 w-2.5 rounded-full ${vstyle.dot}`} />
                CareerOS verdict · {vstyle.label}
              </div>
              {v.action && (
                <div className="mt-1 text-xs text-neutral-500">{humanize(v.action)}</div>
              )}
            </div>
            {v.opportunityScore != null && (
              <div className="text-right">
                <div className="text-3xl font-semibold tabular-nums text-neutral-100">
                  {v.opportunityScore}
                </div>
                <div className="text-[10px] uppercase tracking-wide text-neutral-500">/ 100</div>
              </div>
            )}
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Dim label="Development" value={v.developmentConfidence} />
            <Dim label="Role fit" value={v.targetRoleFit} />
            <Dim label="Specialization" value={v.specializationFit} />
            <Dim label="Resume fit" value={v.resumeFit} />
          </div>

          {v.reason && (
            <p className="mt-4 whitespace-pre-line border-t border-neutral-800 pt-3 text-sm text-neutral-300">
              {v.reason}
            </p>
          )}
        </section>
      )}

      <div className="mt-5 flex flex-wrap gap-3">
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

      {/* SPECIALIZATION BREAKDOWN — the auditable stack fit */}
      {spec && (spec.strong.length > 0 || spec.transferable.length > 0 || spec.missing.length > 0) && (
        <section className="mt-6 rounded-xl border border-neutral-800 bg-neutral-900 p-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-400">
              Stack fit vs your resume
            </h2>
            {spec.fit != null && (
              <span className="text-sm font-semibold tabular-nums text-neutral-200">{spec.fit}%</span>
            )}
          </div>
          {spec.fit != null && (
            <div className="mt-2">
              <Bar pct={spec.fit} />
            </div>
          )}
          <div className="mt-4 space-y-3 text-sm">
            {spec.strong.length > 0 && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-emerald-500">On your resume</div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {spec.strong.map((s) => (
                    <span key={s} className="rounded-full border border-emerald-800 bg-emerald-950/50 px-2.5 py-0.5 text-xs text-emerald-300">
                      ✓ {s}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {spec.transferable.length > 0 && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-amber-500">Transferable</div>
                <div className="mt-1 space-y-1">
                  {spec.transferable.map((t) => (
                    <div key={t.skill} className="text-xs text-amber-300/90">
                      ~ <span className="font-medium">{t.skill}</span>{' '}
                      <span className="text-amber-400/60">— {t.note}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {spec.missing.length > 0 && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-neutral-500">Missing</div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {spec.missing.map((s) => (
                    <span key={s} className="rounded-full border border-neutral-700 bg-neutral-950 px-2.5 py-0.5 text-xs text-neutral-400">
                      ✕ {s}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* CLASSIFICATION FACTS */}
      {c && (
        <section className="mt-6 grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4 text-sm">
            <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-400">What this role is</h2>
            <dl className="mt-3 space-y-1.5 text-neutral-300">
              <Row k="Family" val={humanize(c.roleFamily)} />
              <Row k="Function" val={humanize(c.primaryFunction)} />
              <Row k="Coding" val={humanize(c.codingIntensity)} />
              <Row k="Seniority" val={humanize(c.seniority)} />
              {experience && <Row k="Experience" val={experience} />}
            </dl>
          </div>
          {c.developmentEvidence.length > 0 && (
            <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
              <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-400">Evidence it builds software</h2>
              <ul className="mt-3 space-y-1.5 text-sm text-neutral-300">
                {c.developmentEvidence.slice(0, 4).map((e, i) => (
                  <li key={i} className="text-emerald-400/80">“{e}”</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {/* RESPONSIBILITIES */}
      {c && c.responsibilities.length > 0 && (
        <section className="mt-6 rounded-xl border border-neutral-800 bg-neutral-900 p-4">
          <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-400">Responsibilities</h2>
          <ul className="mt-3 list-inside list-disc space-y-1 text-sm text-neutral-300">
            {c.responsibilities.slice(0, 6).map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </section>
      )}

      {job.skills.length > 0 && (
        <section className="mt-4 flex flex-wrap gap-2">
          {job.skills.map((s) => (
            <span key={s.skill.name} className="rounded-full border border-neutral-700 bg-neutral-950 px-3 py-1 text-sm text-neutral-300">
              {s.skill.name}
            </span>
          ))}
        </section>
      )}

      <section className="mt-6">
        <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-400">Full description</h2>
        <div className="mt-3 whitespace-pre-line rounded-xl border border-neutral-800 bg-neutral-900 p-5 text-[15px] leading-relaxed text-neutral-200">
          {job.description}
        </div>
      </section>

      <section className="mt-6 text-sm text-neutral-500">
        {job.company.careerPageUrl && (
          <a href={job.company.careerPageUrl} target="_blank" rel="noreferrer" className="hover:text-neutral-300">
            🏢 All openings at {job.company.name} →
          </a>
        )}
      </section>
    </Shell>
  );
}

function Row({ k, val }: { k: string; val: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-neutral-500">{k}</dt>
      <dd className="text-right capitalize text-neutral-200">{val}</dd>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-neutral-950 px-4 py-8 text-neutral-100">
      <div className="mx-auto w-full max-w-3xl">{children}</div>
    </main>
  );
}
