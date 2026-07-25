import { mapJoobleJobs } from './jooble';

describe('mapJoobleJobs', () => {
  const base = {
    id: 987,
    title: 'Node.js Developer',
    company: 'Acme Tech',
    location: 'Bengaluru',
    snippet: 'Build <b>APIs</b> with Node &amp; React',
    link: 'https://jooble.org/desc/123',
    updated: '2026-07-25T00:00:00Z',
  };

  it('normalises a dev role into a BoardJob (India, cleaned snippet)', () => {
    const [j] = mapJoobleJobs([base]);
    expect(j.company.name).toBe('Acme Tech');
    expect(j.job.externalId).toBe('jooble-987');
    expect(j.job.country).toBe('IN');
    expect(j.job.description).toBe('Build APIs with Node & React');
    expect(j.job.url).toBe('https://jooble.org/desc/123');
  });

  it('drops rows missing a company or a valid link (no ghost companies)', () => {
    const jobs = mapJoobleJobs([
      base,
      { ...base, id: 2, company: undefined },
      { ...base, id: 3, link: 'not-a-url' },
    ]);
    expect(jobs).toHaveLength(1);
  });

  it('drops non-dev roles and dedupes by id', () => {
    const jobs = mapJoobleJobs([base, base, { ...base, id: 5, title: 'Sales Manager' }]);
    expect(jobs.map((j) => j.job.externalId)).toEqual(['jooble-987']);
  });
});
