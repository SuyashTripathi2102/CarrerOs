import { mapAdzunaResults } from './adzuna';

describe('mapAdzunaResults', () => {
  const base = {
    id: '123',
    title: 'Node.js Developer',
    description: '<p>Build <b>APIs</b> with Node &amp; React</p>',
    redirect_url: 'https://www.adzuna.in/details/123',
    created: '2026-07-24T10:00:00Z',
    company: { display_name: 'Acme Tech' },
    location: { display_name: 'Bengaluru, Karnataka' },
    salary_min: 1200000,
  };

  it('normalises a dev role into a BoardJob (India, cleaned text)', () => {
    const [j] = mapAdzunaResults([base]);
    expect(j.company.name).toBe('Acme Tech');
    expect(j.job.externalId).toBe('adzuna-123');
    expect(j.job.title).toBe('Node.js Developer');
    expect(j.job.country).toBe('IN');
    expect(j.job.description).toBe('Build APIs with Node & React'); // tags/entities stripped
    expect(j.job.currency).toBe('INR');
  });

  it('drops non-dev roles the aggregator returns as noise', () => {
    const jobs = mapAdzunaResults([
      base,
      { ...base, id: '9', title: 'Accounts Manager' },
      { ...base, id: '10', title: 'Sales Executive' },
    ]);
    expect(jobs.map((j) => j.job.externalId)).toEqual(['adzuna-123']);
  });

  it('dedupes by id and skips rows missing company or title', () => {
    const jobs = mapAdzunaResults([
      base,
      base, // dup id
      { ...base, id: '2', company: undefined },
      { ...base, id: '3', title: undefined },
    ]);
    expect(jobs).toHaveLength(1);
  });

  it('flags remote from title/location', () => {
    const [j] = mapAdzunaResults([
      { ...base, id: '5', title: 'Remote Full Stack Developer' },
    ]);
    expect(j.job.workMode).toBe('REMOTE');
  });
});
