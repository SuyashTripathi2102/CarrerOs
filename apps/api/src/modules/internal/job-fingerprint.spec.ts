import { jobFingerprint, normalizeTitle, normalizeLocation } from './job-fingerprint';

describe('normalizeTitle', () => {
  it('is order- and punctuation-invariant', () => {
    expect(normalizeTitle('Senior Backend Engineer')).toBe(
      normalizeTitle('Backend Engineer (Senior)'),
    );
    expect(normalizeTitle('Full-Stack Developer')).toBe(normalizeTitle('Developer, Full Stack'));
  });

  it('keeps seniority as part of the identity', () => {
    expect(normalizeTitle('Senior Backend Engineer')).not.toBe(
      normalizeTitle('Junior Backend Engineer'),
    );
  });

  it('drops structural noise words', () => {
    expect(normalizeTitle('We are hiring a Backend Engineer')).toBe(
      normalizeTitle('Backend Engineer'),
    );
  });
});

describe('normalizeLocation', () => {
  it('collapses punctuation and case', () => {
    expect(normalizeLocation('Bangalore, India')).toBe('bangalore india');
    expect(normalizeLocation(null)).toBe('');
    expect(normalizeLocation(undefined)).toBe('');
  });
});

describe('jobFingerprint', () => {
  const base = { companyId: 'c1', title: 'Senior Backend Engineer', location: 'Bangalore' };

  it('collapses the same job across sources (title ordering differs)', () => {
    expect(jobFingerprint(base)).toBe(
      jobFingerprint({ ...base, title: 'Backend Engineer (Senior)' }),
    );
  });

  it('separates the same title at different companies', () => {
    expect(jobFingerprint(base)).not.toBe(jobFingerprint({ ...base, companyId: 'c2' }));
  });

  it('separates different seniorities', () => {
    expect(jobFingerprint(base)).not.toBe(
      jobFingerprint({ ...base, title: 'Junior Backend Engineer' }),
    );
  });

  it('separates different work modes', () => {
    expect(jobFingerprint({ ...base, workMode: 'REMOTE' })).not.toBe(
      jobFingerprint({ ...base, workMode: 'ONSITE' }),
    );
  });

  it('is a stable 32-char hex string', () => {
    expect(jobFingerprint(base)).toMatch(/^[0-9a-f]{32}$/);
  });
});
