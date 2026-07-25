import { resumeQualityGate } from './resume-quality-gate';

const master = `
Suyash Tripathi — Full Stack Developer
suyash@example.com
EXPERIENCE
Logikview Analytics
- Built RESTful APIs with Node.js serving 5,000+ concurrent users.
- Reduced authentication errors by 35% with hardened RBAC middleware.
`;
const masterText = master;

const html = (bullets: string[]) =>
  `<article><h2>EXPERIENCE</h2><ul>${bullets.map((b) => `<li>${b}</li>`).join('')}</ul></article>`;

describe('resumeQualityGate', () => {
  it('passes a clean tailored resume derived from the master', () => {
    const tailoredHtml = html([
      'Built RESTful APIs with Node.js serving 5,000+ concurrent users.',
      'Reduced authentication errors by 35% with hardened RBAC middleware.',
    ]);
    const g = resumeQualityGate({ masterText, tailoredText: masterText, tailoredHtml });
    expect(g.checks.find((c) => c.name === 'No invented metrics')?.status).toBe('PASS');
    expect(g.verdict).toBe('SEND');
    expect(g.score).toBeGreaterThanOrEqual(85);
  });

  it('FAILS on a metric not present in the master (confabulation)', () => {
    const tailoredText = masterText + ' Increased revenue by 200% and led 40 engineers.';
    const g = resumeQualityGate({ masterText, tailoredText, tailoredHtml: html([tailoredText]) });
    const c = g.checks.find((x) => x.name === 'No invented metrics');
    expect(c?.status).toBe('FAIL');
    expect(c?.items).toEqual(expect.arrayContaining(['200%']));
    expect(g.verdict).toBe('FIX');
  });

  it('does not flag version-like numbers (OAuth 2.0, ES6) as invented metrics', () => {
    const tailoredText = masterText + ' OAuth 2.0, ES6, S3.';
    const g = resumeQualityGate({ masterText, tailoredText, tailoredHtml: html([tailoredText]) });
    expect(g.checks.find((c) => c.name === 'No invented metrics')?.status).toBe('PASS');
  });

  it('warns on filler phrases and ATS-risky tables', () => {
    const tailoredText = masterText + ' A proven track record, well-suited for this role.';
    const tailoredHtml = `<table><tr><td>x</td></tr></table>` + html([tailoredText]);
    const g = resumeQualityGate({ masterText, tailoredText, tailoredHtml });
    expect(g.checks.find((c) => c.name === 'No filler phrases')?.status).toBe('WARN');
    expect(g.checks.find((c) => c.name === 'ATS-safe formatting')?.status).toBe('WARN');
    expect(g.verdict).not.toBe('SEND');
  });

  it('warns on duplicate bullets', () => {
    const b = 'Built RESTful APIs with Node.js serving 5,000+ concurrent users.';
    const g = resumeQualityGate({ masterText, tailoredText: masterText, tailoredHtml: html([b, b, b]) });
    expect(g.checks.find((c) => c.name === 'No duplicate bullets')?.status).toBe('WARN');
  });
});
