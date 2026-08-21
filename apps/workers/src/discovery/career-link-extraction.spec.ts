import { extractCareerLinksForTest } from './prober';

/**
 * Career-link extraction (2026-08-21).
 *
 * The prober read `href=` only, while its own comment said boards are "usually
 * embedded or linked". Measured across 50 Bangalore companies: Jupiter serves a
 * Keka board — an ATS CareerOS already crawls — entirely inside an iframe. It
 * was invisible, and the company would have been recorded UNKNOWN: crawlable
 * today, filed as not crawlable.
 */
describe('extractCareerLinks', () => {
  it('finds a board embedded in an iframe', () => {
    const html = `<div><iframe src="https://jupiter.keka.com/careers/" /></div>`;
    expect(extractCareerLinksForTest(html, 'https://jupiter.money/careers')).toEqual([
      'https://jupiter.keka.com/careers/',
    ]);
  });

  it('still finds ordinary anchor links', () => {
    const html = `<a href="https://boards.greenhouse.io/acme">Open roles</a>`;
    expect(extractCareerLinksForTest(html, 'https://acme.com')).toEqual([
      'https://boards.greenhouse.io/acme',
    ]);
  });

  it('returns the FRAME before the anchor when a page has both', () => {
    // Callers probe only the first few links, so ordering is load-bearing: the
    // embedded board is the board, while the anchor is usually a nav item.
    const html = `
      <a href="/careers">Careers</a>
      <iframe src="https://acme.keka.com/careers/"></iframe>`;
    const out = extractCareerLinksForTest(html, 'https://acme.com/');
    expect(out[0]).toBe('https://acme.keka.com/careers/');
  });

  it('resolves relative frame sources against the page', () => {
    const html = `<iframe src="/jobs/board"></iframe>`;
    expect(extractCareerLinksForTest(html, 'https://acme.com/careers')).toEqual([
      'https://acme.com/jobs/board',
    ]);
  });

  it('ignores frames that are not careers-related', () => {
    // A careers page carries trackers, maps and video embeds. Probing those
    // would spend the small link budget on things that can never be a board.
    const html = `
      <iframe src="https://www.youtube.com/embed/xyz"></iframe>
      <iframe src="https://www.google.com/maps/embed?pb=1"></iframe>`;
    expect(extractCareerLinksForTest(html, 'https://acme.com/careers')).toEqual([]);
  });

  it('returns http(s) only, never data:/javascript:/mailto:', () => {
    // These resolve perfectly well and would each burn one of the four probe
    // slots on something that can never be a board. Sandboxed embeds really do
    // use data: URIs, so this is not hypothetical.
    const html = `
      <iframe src="data:text/html,careers"></iframe>
      <a href="javascript:openCareers()">careers</a>
      <a href="mailto:jobs@acme.com">jobs</a>
      <iframe src="https://acme.keka.com/careers/"></iframe>`;
    expect(extractCareerLinksForTest(html, 'https://acme.com')).toEqual([
      'https://acme.keka.com/careers/',
    ]);
  });

  it('deduplicates a board that appears as both a frame and a link', () => {
    const html = `
      <iframe src="https://acme.keka.com/careers/"></iframe>
      <a href="https://acme.keka.com/careers/">Apply</a>`;
    expect(extractCareerLinksForTest(html, 'https://acme.com')).toHaveLength(1);
  });
});
