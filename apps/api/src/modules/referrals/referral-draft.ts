/**
 * Outreach draft prompt — builds the instruction for the LLM that writes a
 * referral request the USER will review and send themselves. It is a draft, not
 * a message: CareerOS never sends anything, never sends in bulk, and never
 * fabricates a relationship.
 *
 * The prompt is deliberately strict about honesty because a cold referral ask
 * lives or dies on being specific and truthful. It may reference only the real
 * facts we pass in (the person's public role/repo, a genuinely shared skill,
 * the user's actual experience). No invented mutual connections, no flattery
 * about work we didn't cite, no pretending to have met.
 */
import type { ReferralRole } from './referral-ranking';

export interface DraftUser {
  name: string;
  headline: string | null;
  years: number | null;
  topSkills: string[];
  standoutProject: string | null; // "Name — one-line what it does"
}

export interface DraftJob {
  title: string;
  company: string;
}

export interface DraftPerson {
  name: string;
  role: ReferralRole;
  sharedTech: string[];
  via: string | null; // a specific repo, or null → "the engineering team"
  publicMember: boolean;
}

const ROLE_HINT: Record<ReferralRole, string> = {
  RECRUITER:
    'They are a recruiter / talent person, so it is appropriate to ask directly about the open role and how to be considered.',
  HIRING_MANAGER:
    'They are an engineering leader, so lead with your relevant work and a concise, respectful ask — they are busy.',
  ENGINEER:
    'They are a fellow engineer, so connect peer-to-peer over shared tech before asking whether they could refer you.',
};

export function referralDraftPrompt(
  user: DraftUser,
  job: DraftJob,
  person: DraftPerson,
): { system: string; prompt: string } {
  const system = [
    'You write a single, short, honest outreach message that a job seeker will REVIEW and send themselves.',
    'Hard rules:',
    '- Use ONLY the facts provided. Never invent a mutual connection, a shared employer, a past meeting, or work you were not told about.',
    '- No flattery about specifics you were not given. If there is nothing genuinely shared, keep it warm but general — do not fabricate a reason.',
    '- One clear, low-pressure ask. Make it easy to say no.',
    '- Sound like a real person, not a template. No buzzwords, no "I hope this email finds you well", no exclamation-mark spam.',
    '- 90–130 words in the body. Plain text.',
    'Return JSON: {"subject": string, "body": string}. The body must be ready to send as-is, signed with the sender\'s first name.',
  ].join('\n');

  const shared = person.sharedTech.length ? person.sharedTech.join(', ') : 'none provided';
  const via = person.via ? `their work on ${person.via}` : `the ${job.company} engineering team`;

  const prompt = [
    `SENDER (the job seeker):`,
    `- Name: ${user.name}`,
    `- Headline: ${user.headline ?? 'software developer'}`,
    `- Experience: ${user.years != null ? `${user.years} years` : 'early-career'}`,
    `- Core skills: ${user.topSkills.join(', ') || 'general full-stack'}`,
    user.standoutProject ? `- A project they built: ${user.standoutProject}` : '',
    ``,
    `RECIPIENT:`,
    `- Name: ${person.name}`,
    `- Relationship to ${job.company}: ${person.publicMember ? `works at ${job.company}` : `contributes to ${job.company}'s open source`}`,
    `- What connects them: ${via}`,
    `- Genuinely shared tech: ${shared}`,
    `- ${ROLE_HINT[person.role]}`,
    ``,
    `THE ASK: ${user.name} is interested in the "${job.title}" role at ${job.company} and would value a referral or a quick pointer on the right way to apply.`,
    ``,
    `Write the message now. If "genuinely shared tech" is "none provided", do NOT claim a shared stack — connect over ${via} instead, honestly.`,
  ]
    .filter(Boolean)
    .join('\n');

  return { system, prompt };
}
