import { companyFieldMatches, orgSlugCandidates } from './github-people';

describe('orgSlugCandidates', () => {
  it('strips legal/industry suffixes to the core name', () => {
    expect(orgSlugCandidates('Postman Inc.')).toContain('postman');
    expect(orgSlugCandidates('Razorpay Software Pvt Ltd')).toContain('razorpay');
  });

  it('offers joined, hyphenated, and first-word variants for multi-word names', () => {
    const c = orgSlugCandidates('Scaler Academy');
    expect(c).toContain('scaleracademy');
    expect(c).toContain('scaler-academy');
    expect(c).toContain('scaler');
  });

  it('drops names that reduce to nothing usable', () => {
    expect(orgSlugCandidates('The Co.')).toEqual([]);
  });
});

describe('companyFieldMatches', () => {
  it('matches a self-reported company field to the employer', () => {
    expect(companyFieldMatches('@postman', 'Postman', 'postman')).toBe(true);
    expect(companyFieldMatches('Postman Inc', 'Postman', 'postman')).toBe(true);
  });

  it('rejects an unrelated OSS contributor', () => {
    expect(companyFieldMatches('Google', 'Postman', 'postman')).toBe(false);
    expect(companyFieldMatches(null, 'Postman', 'postman')).toBe(false);
  });
});
