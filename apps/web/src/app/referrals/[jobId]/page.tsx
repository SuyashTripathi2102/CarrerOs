'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { apiGet, apiPatch, apiPost } from '@/lib/api';

type Role = 'RECRUITER' | 'HIRING_MANAGER' | 'ENGINEER';
type Status = 'SUGGESTED' | 'DRAFTED' | 'CONTACTED' | 'REPLIED' | 'ARCHIVED';

interface Contact {
  id: string;
  name: string;
  handle: string;
  role: Role;
  priority: number;
  reason: string;
  profileUrl: string;
  avatarUrl: string | null;
  bio: string | null;
  location: string | null;
  email: string | null;
  blog: string | null;
  twitter: string | null;
  sharedTech: string[];
  via: string | null;
  publicMember: boolean;
  status: Status;
  draft: string | null;
}
interface Data {
  jobTitle: string;
  companyName: string;
  contacts: Contact[];
  message: string | null;
}

const ROLE_LABEL: Record<Role, string> = {
  RECRUITER: 'Recruiter / talent',
  HIRING_MANAGER: 'Engineering leader',
  ENGINEER: 'Engineer',
};
const ROLE_STYLE: Record<Role, string> = {
  RECRUITER: 'border-violet-800 bg-violet-950/40 text-violet-200',
  HIRING_MANAGER: 'border-amber-800 bg-amber-950/40 text-amber-200',
  ENGINEER: 'border-sky-800 bg-sky-950/40 text-sky-200',
};

export default function ReferralsPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!jobId) return;
    apiGet<Data>(`/referrals/job/${jobId}`)
      .then(setData)
      .catch((e) => setError(String(e)));
  }, [jobId]);

  useEffect(load, [load]);

  function patchContact(id: string, patch: Partial<Contact>) {
    setData((d) =>
      d ? { ...d, contacts: d.contacts.map((c) => (c.id === id ? { ...c, ...patch } : c)) } : d,
    );
  }

  if (error)
    return (
      <Shell>
        <p className="text-red-400">{error}</p>
      </Shell>
    );
  if (!data)
    return (
      <Shell>
        <p className="text-neutral-400">Finding people who could refer you…</p>
      </Shell>
    );

  return (
    <Shell>
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Referrals — {data.companyName}</h1>
          <p className="text-sm text-neutral-400">{data.jobTitle}</p>
        </div>
        <Link href={`/jobs/${jobId}`} className="text-sm text-neutral-500 hover:text-neutral-300">
          ← Back to job
        </Link>
      </div>

      {/* The ethic, stated plainly — this is a referral tool, not a spam cannon. */}
      <div className="mt-4 rounded-xl border border-neutral-800 bg-neutral-900/60 p-4 text-[13px] leading-relaxed text-neutral-300">
        Found from <strong>public GitHub</strong> only — people who show they work here or build the
        company&apos;s open source. CareerOS never messages anyone: drafts are yours to review, edit,
        and send. <strong>One thoughtful message per person — never spam.</strong>
      </div>

      {data.message && <p className="mt-5 text-neutral-400">{data.message}</p>}

      <div className="mt-5 space-y-4">
        {data.contacts.map((c) => (
          <ContactCard key={c.id} c={c} onPatch={patchContact} />
        ))}
      </div>
    </Shell>
  );
}

function ContactCard({
  c,
  onPatch,
}: {
  c: Contact;
  onPatch: (id: string, patch: Partial<Contact>) => void;
}) {
  const [draft, setDraft] = useState(c.draft ?? '');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function generate() {
    setBusy(true);
    try {
      const r = await apiPost<{ draft: string }>(`/referrals/${c.id}/draft`, {});
      setDraft(r.draft);
      onPatch(c.id, { draft: r.draft, status: c.status === 'CONTACTED' || c.status === 'REPLIED' ? c.status : 'DRAFTED' });
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(status: Status) {
    onPatch(c.id, { status });
    await apiPatch(`/referrals/${c.id}/status`, { status }).catch(() => undefined);
  }

  function copy() {
    navigator.clipboard.writeText(draft).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  const initials = c.name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
      <div className="flex items-start gap-3">
        {c.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={c.avatarUrl} alt="" className="h-11 w-11 rounded-full" />
        ) : (
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-neutral-800 text-sm text-neutral-300">
            {initials}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-neutral-100">{c.name}</span>
            <span className={`rounded-full border px-2 py-0.5 text-[11px] ${ROLE_STYLE[c.role]}`}>
              {ROLE_LABEL[c.role]}
            </span>
            {c.publicMember && (
              <span className="rounded-full border border-emerald-800 bg-emerald-950/40 px-2 py-0.5 text-[11px] text-emerald-300">
                verified employee
              </span>
            )}
            <span className="ml-auto text-[11px] tabular-nums text-neutral-500">
              match {c.priority}
            </span>
          </div>
          <p className="mt-1 text-[13px] text-neutral-400">{c.reason}</p>

          {c.sharedTech.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {c.sharedTech.map((t) => (
                <span
                  key={t}
                  className="rounded border border-neutral-700 bg-neutral-950/60 px-1.5 py-0.5 text-[11px] text-neutral-300"
                >
                  {t}
                </span>
              ))}
            </div>
          )}

          <div className="mt-2 flex flex-wrap gap-3 text-[12px]">
            <a href={c.profileUrl} target="_blank" rel="noreferrer" className="text-sky-300 hover:underline">
              GitHub ↗
            </a>
            {c.email && (
              <a href={`mailto:${c.email}`} className="text-sky-300 hover:underline">
                Email ↗
              </a>
            )}
            {c.blog && (
              <a href={c.blog} target="_blank" rel="noreferrer" className="text-sky-300 hover:underline">
                Site ↗
              </a>
            )}
            {c.twitter && (
              <a
                href={`https://x.com/${c.twitter}`}
                target="_blank"
                rel="noreferrer"
                className="text-sky-300 hover:underline"
              >
                X ↗
              </a>
            )}
            {c.location && <span className="text-neutral-500">{c.location}</span>}
          </div>
        </div>
      </div>

      {/* Outreach — a draft the user owns. */}
      <div className="mt-3 border-t border-neutral-800 pt-3">
        {draft ? (
          <>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={8}
              className="w-full rounded-lg border border-neutral-700 bg-neutral-950 p-3 text-[13px] leading-relaxed text-neutral-200 focus:border-neutral-500 focus:outline-none"
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                onClick={copy}
                className="rounded-lg bg-neutral-100 px-3 py-1.5 text-[13px] font-medium text-neutral-950 hover:bg-white"
              >
                {copied ? '✓ Copied' : 'Copy'}
              </button>
              <button
                onClick={generate}
                disabled={busy}
                className="rounded-lg border border-neutral-700 px-3 py-1.5 text-[13px] text-neutral-300 hover:border-neutral-500 disabled:opacity-50"
              >
                {busy ? 'Rewriting…' : 'Regenerate'}
              </button>
              <StatusControls status={c.status} onSet={setStatus} />
            </div>
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={generate}
              disabled={busy}
              className="rounded-lg border border-violet-800 bg-violet-950/40 px-3 py-1.5 text-[13px] font-medium text-violet-200 hover:bg-violet-900/40 disabled:opacity-50"
            >
              {busy ? 'Writing…' : '✍️ Draft an intro'}
            </button>
            <StatusControls status={c.status} onSet={setStatus} />
          </div>
        )}
      </div>
    </div>
  );
}

function StatusControls({ status, onSet }: { status: Status; onSet: (s: Status) => void }) {
  if (status === 'REPLIED')
    return <span className="text-[12px] text-emerald-400">💬 Replied</span>;
  if (status === 'CONTACTED')
    return (
      <>
        <span className="text-[12px] text-amber-300">✓ Reached out</span>
        <button onClick={() => onSet('REPLIED')} className="text-[12px] text-neutral-400 hover:text-neutral-200">
          Got a reply
        </button>
      </>
    );
  return (
    <button
      onClick={() => onSet('CONTACTED')}
      className="rounded-lg border border-neutral-700 px-3 py-1.5 text-[13px] text-neutral-300 hover:border-neutral-500"
    >
      I reached out
    </button>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-neutral-950 px-4 py-8 text-neutral-100">
      <div className="mx-auto w-full max-w-3xl">{children}</div>
    </main>
  );
}
