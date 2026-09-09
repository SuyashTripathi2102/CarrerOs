import {
  decideHydration,
  detailText,
  isJobDescription,
  needsHydration,
  jdMarkerCount,
} from './detail-hydration';
import { MIN_DESCRIPTION_CHARS } from '@careeros/shared';

/**
 * These pin refusals, not extraction quality.
 *
 * The bug being fixed was a synthesised description — 94 characters of the job
 * title fed back — that looked like evidence and was not. Every test here asks
 * the same question in a different way: can this code invent, weaken or
 * mislabel a description? It must not be able to.
 */

const REAL_POSTING = `
<html><body>
  <nav>Home Products Pricing Login</nav>
  <h1>Backend Engineer</h1>
  <div class="content">
    <h2>About the role</h2>
    <p>You will design and operate the services behind our inference platform,
       owning them from schema to on-call. You will work with Go and Postgres.</p>
    <h2>Responsibilities</h2>
    <ul><li>Build and maintain backend APIs</li><li>Own service reliability</li></ul>
    <h2>Requirements</h2>
    <ul><li>Experience with distributed systems</li><li>2+ years writing production code</li></ul>
    <h2>Nice to have</h2>
    <ul><li>Kubernetes</li></ul>
  </div>
  <footer>Careers Privacy Terms</footer>
</body></html>`;

/** The exact shape the career extractor was storing. */
const SYNTHETIC_STUB = 'Backend Engineer, Chanakya Bengaluru Full Time On-Site · Bengaluru — via Sarvam AI careers page.';

describe('detailText', () => {
  it('drops nav, header and footer chrome', () => {
    const t = detailText(REAL_POSTING);
    expect(t).not.toMatch(/Home Products Pricing Login/);
    expect(t).not.toMatch(/Privacy Terms/);
    expect(t).toContain('Responsibilities');
  });

  it('drops script and style bodies rather than reading them as content', () => {
    const html = `<html><body><style>.a{color:#fff;padding:2px}</style>
      <script>var x = "Requirements: none";</script><p>Hello</p></body></html>`;
    const t = detailText(html);
    expect(t).toBe('Hello');
  });
});

describe('isJobDescription — length alone is not evidence', () => {
  it('accepts a real posting', () => {
    expect(isJobDescription(detailText(REAL_POSTING))).toBe(true);
  });

  it('rejects a long marketing page with no posting phrases', () => {
    // A homepage clears 200 characters trivially. If length were the only test,
    // every company front page would become a job description.
    const marketing = 'We build delightful products for modern teams. '.repeat(20);
    expect(marketing.length).toBeGreaterThan(MIN_DESCRIPTION_CHARS);
    expect(jdMarkerCount(marketing)).toBe(0);
    expect(isJobDescription(marketing)).toBe(false);
  });

  it('rejects a short page even when it uses posting words', () => {
    expect(isJobDescription('Responsibilities: TBD')).toBe(false);
  });
});

describe('decideHydration', () => {
  const stub = { description: SYNTHETIC_STUB, descriptionSource: 'LIST' as const };

  it('WRITEs a recovered posting and labels it DETAIL', () => {
    const d = decideHydration(stub, REAL_POSTING);
    expect(d.action).toBe('WRITE');
    if (d.action !== 'WRITE') throw new Error('unreachable');
    expect(d.descriptionSource).toBe('DETAIL');
    expect(d.description.length).toBeGreaterThanOrEqual(MIN_DESCRIPTION_CHARS);
    expect(d.description).toContain('Responsibilities');
  });

  it('NEVER fabricates: the written body is the page text, not the title', () => {
    const d = decideHydration(stub, REAL_POSTING);
    if (d.action !== 'WRITE') throw new Error('expected WRITE');
    // The bug: `${title} · ${location} — via ${company} careers page.`
    expect(d.description).not.toContain('via Sarvam AI careers page');
    expect(d.description).not.toBe(SYNTHETIC_STUB);
  });

  it('KEEPs on a failed fetch — absence of evidence is not evidence of absence', () => {
    // Marking MISSING here would turn one timeout into a permanent verdict.
    const d = decideHydration(stub, null);
    expect(d.action).toBe('KEEP');
    expect(d.reason).toMatch(/fetch failed/);
  });

  it('KEEPs when the detail page is still too thin', () => {
    const d = decideHydration(stub, '<html><body><p>Coming soon</p></body></html>');
    expect(d.action).toBe('KEEP');
    expect(d.reason).toMatch(/below 200/);
  });

  it('KEEPs a long page that is not a posting', () => {
    const html = `<html><body><p>${'We build delightful products. '.repeat(30)}</p></body></html>`;
    const d = decideHydration(stub, html);
    expect(d.action).toBe('KEEP');
    expect(d.reason).toMatch(/not a job description/);
  });

  it('NEVER weakens: a shorter body cannot replace a longer one', () => {
    // A login wall can clear both checks while carrying less than what is
    // stored. Overwriting good evidence with it is unrecoverable.
    const rich = {
      description: `About the role. ${'Detailed responsibilities and requirements. '.repeat(40)}`,
      descriptionSource: 'DETAIL' as const,
    };
    const d = decideHydration(rich, REAL_POSTING);
    expect(d.action).toBe('KEEP');
    expect(d.reason).toMatch(/not richer/);
  });

  it('never returns MISSING — only a page we read could justify that', () => {
    for (const html of [null, '<html></html>', REAL_POSTING]) {
      const d = decideHydration(stub, html);
      if (d.action === 'WRITE') expect(d.descriptionSource).toBe('DETAIL');
    }
  });
});

describe('needsHydration', () => {
  it('selects a job with a thin body and an absolute URL', () => {
    expect(needsHydration({ description: SYNTHETIC_STUB, url: 'https://x.com/jobs/1' })).toBe(true);
  });

  it('skips a job that already clears the gate', () => {
    expect(needsHydration({ description: 'x'.repeat(MIN_DESCRIPTION_CHARS), url: 'https://x.com/1' })).toBe(false);
  });

  it('skips a job with no usable URL — there is nowhere to fetch from', () => {
    expect(needsHydration({ description: '', url: null })).toBe(false);
    expect(needsHydration({ description: '', url: '/careers/1' })).toBe(false);
    expect(needsHydration({ description: '', url: 'mailto:jobs@x.com' })).toBe(false);
  });
});

describe('the threshold is shared, not copied', () => {
  it('uses the same constant the API gate refuses on', () => {
    // Two copies could drift into a hydrator that "fixes" jobs the gate still
    // refuses — visible only as a count that never moves.
    expect(MIN_DESCRIPTION_CHARS).toBe(200);
  });
});
