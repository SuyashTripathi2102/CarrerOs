import { referralDraftPrompt, type DraftJob, type DraftPerson, type DraftUser } from './referral-draft';

const user: DraftUser = {
  name: 'Suyash Tripathi',
  headline: 'Full-stack developer',
  years: 2,
  topSkills: ['React', 'Node.js', 'PostgreSQL'],
  standoutProject: 'CareerOS — a job-search assistant',
};
const job: DraftJob = { title: 'Backend Engineer', company: 'Postman' };

describe('referralDraftPrompt', () => {
  it('grounds the prompt in the real sender, recipient, and role facts', () => {
    const person: DraftPerson = {
      name: 'Asha Rao',
      role: 'ENGINEER',
      sharedTech: ['Node.js'],
      via: 'postman-sdk',
      publicMember: true,
    };
    const { system, prompt } = referralDraftPrompt(user, job, person);
    expect(prompt).toContain('Suyash Tripathi');
    expect(prompt).toContain('Asha Rao');
    expect(prompt).toContain('Backend Engineer');
    expect(prompt).toContain('postman-sdk');
    // honesty guardrails are always present
    expect(system).toMatch(/never invent/i);
    expect(system).toMatch(/JSON/);
  });

  it('instructs the model NOT to fabricate a shared stack when none is provided', () => {
    const person: DraftPerson = {
      name: 'Asha Rao',
      role: 'HIRING_MANAGER',
      sharedTech: [],
      via: null,
      publicMember: true,
    };
    const { prompt } = referralDraftPrompt(user, job, person);
    expect(prompt).toContain('none provided');
    expect(prompt).toMatch(/do NOT claim a shared stack/);
    // with no repo, it falls back to the honest team-level connection
    expect(prompt).toContain('the Postman engineering team');
  });

  it('tailors the guidance to the recipient role', () => {
    const recruiter = referralDraftPrompt(user, job, {
      name: 'R',
      role: 'RECRUITER',
      sharedTech: [],
      via: null,
      publicMember: true,
    }).prompt;
    expect(recruiter).toMatch(/recruiter/i);
  });
});
