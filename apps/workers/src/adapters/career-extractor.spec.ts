import { extractCareerPage, looksJsRendered } from './career-extractor';

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

describe('looksJsRendered (render-tier gate)', () => {
  it('flags an empty React app shell', () => {
    const shell =
      '<html><body><div id="root"></div><script src="/static/main.js"></script></body></html>';
    expect(looksJsRendered(shell)).toBe(true);
  });

  it('flags a Next.js shell with only __NEXT_DATA__', () => {
    const shell =
      '<html><body><div id="__next"></div><script id="__NEXT_DATA__">{}</script></body></html>';
    expect(looksJsRendered(shell)).toBe(true);
  });

  it('does NOT flag a static page that already lists jobs', () => {
    const html = page(
      [
        a('/careers/react-developer', 'React Developer'),
        a('/careers/node-developer', 'Node.js Developer'),
        a('/careers/backend-engineer', 'Backend Engineer'),
        a('/careers/qa', 'QA Engineer'),
        a('/careers/devops', 'DevOps Engineer'),
        a('/careers/pm', 'Product Manager'),
        a('/careers/data', 'Data Engineer'),
        a('/careers/sre', 'Site Reliability Engineer'),
      ].join(''),
    );
    expect(looksJsRendered(html)).toBe(false);
  });

  it('does NOT flag a content-rich page even with a root div', () => {
    const body = `<div id="root">${'Careers at Acme. '.repeat(200)}</div>`;
    expect(looksJsRendered(page(body))).toBe(false);
  });
});

/**
 * A listing card carries no job body, and this adapter must not pretend it has
 * one.
 *
 * It used to emit `${title} · ${location} — via ${company} careers page.` as the
 * description — about 94 characters of the title handed back as evidence.
 * Measured 2026-09-09: 82 career-page jobs were held at INSUFFICIENT_EVIDENCE
 * carrying exactly that, `descriptionSource` NULL, none of them ever judged.
 *
 * No test asserted on the description field, which is why it survived. These do.
 */
describe('description provenance — never fabricate a body', () => {
  const html = page(
    a('/careers/backend-engineer', 'Backend Engineer') +
      a('/careers/react-developer', 'React Developer'),
  );

  it('emits an EMPTY description, not a synthesised one', () => {
    const { boardJobs } = extractCareerPage(html, 'https://acme.com/careers', 'Acme', 70);
    expect(boardJobs.length).toBeGreaterThan(0);
    for (const b of boardJobs) expect(b.job.description).toBe('');
  });

  it('never writes the title, the location or the company into the description', () => {
    const { boardJobs } = extractCareerPage(html, 'https://acme.com/careers', 'Acme', 70);
    for (const b of boardJobs) {
      expect(b.job.description).not.toContain(b.job.title);
      expect(b.job.description).not.toContain('Acme');
      expect(b.job.description).not.toMatch(/careers page/i);
    }
  });

  it('marks the body MISSING — sought and genuinely unavailable', () => {
    // MISSING is load-bearing: the gate holds these instead of judging them
    // blind, which is the protection built after 6,907 jobs were refused
    // NOT_DEVELOPMENT for descriptions nobody had.
    const { boardJobs } = extractCareerPage(html, 'https://acme.com/careers', 'Acme', 70);
    for (const b of boardJobs) expect(b.job.descriptionSource).toBe('MISSING');
  });

  it('never claims LIST or DETAIL — neither was read', () => {
    const { boardJobs } = extractCareerPage(html, 'https://acme.com/careers', 'Acme', 70);
    for (const b of boardJobs) {
      expect(b.job.descriptionSource).not.toBe('LIST');
      expect(b.job.descriptionSource).not.toBe('DETAIL');
    }
  });

  it('stays empty even when the card carries rich context', () => {
    // Location, employment type and department raise the confidence score, and
    // it would be easy to mistake that context for a description. It is not.
    const rich = page(
      `<li>${a('/careers/backend', 'Backend Engineer')} Bengaluru Full-Time Engineering 3+ years</li>`,
    );
    const { boardJobs } = extractCareerPage(rich, 'https://acme.com/careers', 'Acme', 70);
    for (const b of boardJobs) {
      expect(b.job.description).toBe('');
      expect(b.job.descriptionSource).toBe('MISSING');
    }
  });
});
