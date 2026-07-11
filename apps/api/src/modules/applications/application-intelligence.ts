/**
 * Application Intelligence — close the feedback loop. For every application it
 * answers two questions from data CareerOS already has:
 *   • while you wait: what's the highest-leverage next action?
 *   • after a rejection / long silence: what LIKELY held it back?
 *
 * Pure, deterministic, and deliberately honest — every cause is framed as
 * "likely", never "definitely". These are leading indicators to act on, not
 * verdicts. Improves the Application → Reply → Interview conversion steps.
 */

export interface AppSignals {
  status: string; // APPLIED | OA | INTERVIEW | OFFER | REJECTED | ...
  daysSinceApplied: number | null;
  jobAgeAtApplyDays: number | null; // posting age when you applied
  userYears: number | null;
  minimumYears: number | null;
  missingRequired: string[]; // required skills not evidenced on your resume
  specializationFit: number | null; // 0–100 stack match
  hadReferralContact: boolean; // you actually contacted someone at the company
  tailoredResume: boolean; // a company-tailored resume exists for this job
}

export interface Cause {
  factor: string;
  detail: string;
  strength: number; // 1–4 (how likely a contributor)
}

export interface WaitAction {
  label: string;
  detail: string;
  stars: number; // 1–5
  href?: string;
}

/** Likely contributors to a rejection / silence — ranked, honest, never absolute. */
export function likelyCauses(s: AppSignals): Cause[] {
  const causes: Cause[] = [];

  if (s.minimumYears != null && s.userYears != null && s.userYears < s.minimumYears) {
    const gap = s.minimumYears - s.userYears;
    causes.push({
      factor: 'Experience stretch',
      detail: `The role asks ~${s.minimumYears}+ years; you have ${s.userYears}. A referral and impact-heavy bullets bridge this best.`,
      strength: gap >= 2 ? 4 : 3,
    });
  }

  if (s.missingRequired.length > 0) {
    causes.push({
      factor: 'Missing required skills',
      detail: `Not evidenced on your resume: ${s.missingRequired.slice(0, 3).join(', ')}. Add honestly if you have them, or learn the top one.`,
      strength: s.missingRequired.length >= 3 ? 4 : 3,
    });
  }

  if (!s.hadReferralContact) {
    causes.push({
      factor: 'No referral',
      detail: 'This went in cold. A warm internal intro is the single biggest lever on getting seen.',
      strength: 3,
    });
  }

  if (s.jobAgeAtApplyDays != null && s.jobAgeAtApplyDays >= 14) {
    causes.push({
      factor: 'Applied late',
      detail: `You applied ~${s.jobAgeAtApplyDays} days after it posted. Early applicants are screened first; aim for <72h.`,
      strength: s.jobAgeAtApplyDays >= 30 ? 3 : 2,
    });
  }

  if (s.specializationFit != null && s.specializationFit < 60) {
    causes.push({
      factor: 'Partial stack match',
      detail: `The JD's stack was only a ${s.specializationFit}% match to yours — expect this to weigh against borderline apps.`,
      strength: s.specializationFit < 45 ? 3 : 2,
    });
  }

  return causes.sort((a, b) => b.strength - a.strength).slice(0, 4);
}

/** Highest-leverage moves while an application is still live. */
export function waitingActions(s: AppSignals, jobId: string | null): WaitAction[] {
  const actions: WaitAction[] = [];

  if (!s.hadReferralContact && jobId) {
    actions.push({
      label: 'Find a referral',
      detail: 'A warm intro is the warmest path to a reply.',
      stars: 5,
      href: `/referrals/${jobId}`,
    });
  }

  if ((s.daysSinceApplied ?? 0) >= 5) {
    actions.push({
      label: 'Send a follow-up',
      detail: `No movement in ${s.daysSinceApplied} days — a short nudge often un-sticks it.`,
      stars: 4,
      href: '/outreach',
    });
  }

  if (!s.tailoredResume && jobId) {
    actions.push({
      label: 'Tailor your resume',
      detail: 'Match the JD keywords (ATS) before a recruiter re-checks.',
      stars: 4,
      href: `/resumes/tailor/${jobId}`,
    });
  }

  actions.push({
    label: 'Apply to similar roles',
    detail: 'Keep volume up while this one plays out.',
    stars: 3,
    href: '/',
  });

  return actions.slice(0, 4);
}

/** Honest, volume-gated portfolio insights (null-safe, never fabricated). */
export function funnelInsights(agg: {
  applied: number;
  withReferral: number;
  tailored: number;
  interviews: number;
}): string[] {
  const out: string[] = [];
  if (agg.applied < 4) return out; // too little signal to say anything real

  const refPct = Math.round((agg.withReferral / agg.applied) * 100);
  if (refPct < 34) {
    out.push(
      `Only ${refPct}% of your applications had a referral. Referrals are your biggest untapped lever — start with your strongest-fit open apps.`,
    );
  }
  const tailoredPct = Math.round((agg.tailored / agg.applied) * 100);
  if (tailoredPct < 50) {
    out.push(
      `${tailoredPct}% of your applications used a tailored resume. Tailoring lifts ATS pass-through with near-zero effort.`,
    );
  }
  if (agg.interviews === 0 && agg.applied >= 8) {
    out.push(
      `${agg.applied} applications, no interviews yet — the pattern points at reach (referrals, timing) more than resume. Lead with warm intros.`,
    );
  }
  return out.slice(0, 2);
}
