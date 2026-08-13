import { mapFreehireJobs } from './freehire';

/**
 * FreeHire adapter contract.
 *
 * FreeHire is a keyless aggregator fanning out across 80+ ATS platforms. Two
 * lessons from earlier incidents shape these tests:
 *
 *  1. RemoteOK shipped error pages and nav headings as jobs (96% of its feed)
 *     because the adapter only checked id/company/title. Aggregator rows get
 *     validated at the adapter, never downstream.
 *  2. A title is NOT an eligibility decision. `ROLE_OK` is a cheap prefilter to
 *     avoid paying $0.019/job classifying obvious non-engineering rows. Whether
 *     a "Full Stack Engineer" wants 2 years or 8 is the classifier's call.
 */
describe('mapFreehireJobs', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    public_slug: 'node-js-backend-developer-hyderabad-abc123',
    source: 'freshteam',
    external_id: 'ft-991',
    url: 'https://acme.freshteam.com/jobs/991',
    title: 'Node.js Backend Developer',
    company: 'Acme Systems',
    company_slug: 'acme-systems',
    location: 'Telangana, Hyderabad, India',
    description: '<p>Build <b>APIs</b> with Node &amp; React</p>',
    posted_at: '2026-08-10T00:00:00Z',
    ...over,
  });

  it('normalises a dev role into a BoardJob tagged country=IN', () => {
    const [j] = mapFreehireJobs([row()]);
    expect(j.company.name).toBe('Acme Systems');
    expect(j.job.externalId).toBe('freehire-node-js-backend-developer-hyderabad-abc123');
    expect(j.job.title).toBe('Node.js Backend Developer');
    expect(j.job.description).toBe('Build APIs with Node & React'); // markup + entities stripped
    expect(j.job.country).toBe('IN');
    expect(j.job.url).toBe('https://acme.freshteam.com/jobs/991');
    expect(j.job.postedAt).toBe('2026-08-10T00:00:00Z');
  });

  describe('rejects rows that would poison the corpus', () => {
    it('drops a row with no company (no ghost companies in the flywheel)', () => {
      expect(mapFreehireJobs([row({ company: undefined })])).toHaveLength(0);
    });

    it('drops a row with no title', () => {
      expect(mapFreehireJobs([row({ title: '' })])).toHaveLength(0);
    });

    it('drops a row whose URL will not parse (dead apply link)', () => {
      expect(mapFreehireJobs([row({ url: 'not-a-url' })])).toHaveLength(0);
    });

    it('drops obvious non-engineering roles before they cost a classification', () => {
      const out = mapFreehireJobs([
        row({ title: 'Customer Success Manager', public_slug: 'a' }),
        row({ title: 'Meat Department Manager', public_slug: 'b' }),
        row({ title: 'Registered Nurse', public_slug: 'c' }),
      ]);
      expect(out).toHaveLength(0);
    });
  });

  describe('identity and dedup', () => {
    it('collapses repeats of the same slug within one batch', () => {
      const out = mapFreehireJobs([row(), row(), row()]);
      expect(out).toHaveLength(1);
    });

    it('falls back to external_id, then URL, when no slug is present', () => {
      const [byExternal] = mapFreehireJobs([row({ public_slug: undefined })]);
      expect(byExternal.job.externalId).toBe('freehire-ft-991');

      const [byUrl] = mapFreehireJobs([row({ public_slug: undefined, external_id: undefined })]);
      expect(byUrl.job.externalId).toBe('freehire-https://acme.freshteam.com/jobs/991');
    });

    it('keeps two genuinely different postings from the same company', () => {
      const out = mapFreehireJobs([
        row({ public_slug: 'x', title: 'Backend Engineer' }),
        row({ public_slug: 'y', title: 'React Developer' }),
      ]);
      expect(out).toHaveLength(2);
    });
  });

  describe('seniority is NOT decided here', () => {
    // The classifier reads the JD body for years-of-experience. The adapter
    // must pass senior-titled rows through rather than pre-judging them —
    // filtering here would hide them from the audit trail and from
    // /excluded, and would silently duplicate the role gate's job.
    it.each([
      'Senior Full Stack Engineer',
      'Staff Backend Engineer',
      'Lead Software Developer',
      'Principal Engineer',
    ])('passes %p through to the classifier', (title) => {
      const out = mapFreehireJobs([row({ title, public_slug: title })]);
      expect(out).toHaveLength(1);
      expect(out[0].job.title).toBe(title);
    });
  });

  it('tolerates a missing location and description without dropping the job', () => {
    const [j] = mapFreehireJobs([row({ location: undefined, description: undefined })]);
    expect(j.job.location).toBeNull();
    expect(j.job.description).toBe('');
  });
});
