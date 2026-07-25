import { extractCareerPage } from './career-extractor';

const page = (body: string) => `<html><body>${body}</body></html>`;
const a = (href: string, text: string) => `<a href="${href}">${text}</a>`;

describe('extractCareerPage', () => {
  it('extracts clean role links with job-specific URLs (the sumcircle case)', () => {
    const html = page(
      [
        a('/careers/react-developer', 'React Developer'),
        a('/careers/node-developer', 'Node.js Developer'),
        a('/careers/backend-engineer', 'Backend Engineer'),
      ].join(''),
    );
    const r = extractCareerPage(html, 'https://acme.com/careers', 'Acme');
    expect(r.boardJobs.length).toBe(3);
    expect(r.boardJobs.map((b) => b.job.title)).toEqual(
      expect.arrayContaining(['React Developer', 'Node.js Developer', 'Backend Engineer']),
    );
    expect(r.jobs[0].evidence).toEqual(expect.arrayContaining(['title', 'job-url']));
    expect(r.confidence).toBeGreaterThanOrEqual(60);
  });

  it('REJECTS certification exams (the redhat false positive)', () => {
    const html = page(
      [
        a('/training/ex294', 'Red Hat Certified Engineer exam'),
        a('/training/ex200', 'Red Hat Certified System Administrator exam'),
      ].join(''),
    );
    const r = extractCareerPage(html, 'https://redhat.com/jobs', 'Red Hat');
    expect(r.boardJobs).toHaveLength(0);
    expect(r.jobs).toHaveLength(0);
  });

  it('REJECTS service/nav pages (the collabera false positive)', () => {
    const html = page(
      [
        a('/executive-search/', 'Executive Search'),
        a('/rpo/', 'Recruitment Process Outsourcing'),
        a('/job-search/', 'Find Your Dream Job'),
      ].join(''),
    );
    const r = extractCareerPage(html, 'https://collabera.com/join-us', 'Collabera');
    expect(r.boardJobs).toHaveLength(0);
  });

  it('adds evidence + score for location / experience / employment signals', () => {
    const html = page(
      `<li>${a('/careers/senior-backend', 'Senior Backend Engineer')} · Bengaluru · 3-5 years · Full-time</li>`,
    );
    const r = extractCareerPage(html, 'https://acme.com/careers', 'Acme');
    const job = r.jobs[0];
    expect(job.evidence).toEqual(expect.arrayContaining(['location', 'experience', 'employment-type']));
    expect(job.location).toMatch(/bengaluru/i);
    expect(job.score).toBeGreaterThanOrEqual(70);
    expect(r.boardJobs[0].job.country).toBe('IN');
  });

  it('does not treat a bare role mention in prose as a job (needs a supporting signal)', () => {
    const html = page('<p>We are a leading software developer and consulting company.</p>');
    const r = extractCareerPage(html, 'https://acme.com', 'Acme');
    expect(r.boardJobs).toHaveLength(0);
  });
});
