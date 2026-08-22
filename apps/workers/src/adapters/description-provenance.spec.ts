import { buildDescription } from './lever';
import { descriptionFromJobPostingLd } from './breezy';

/**
 * Description provenance (2026-08-23).
 *
 * 6,907 ACTIVE jobs were stored with an EMPTY body — lever 3,993/5,493 (73%),
 * breezy 2,914/2,914 (100%) — and the gate then refused them NOT_DEVELOPMENT
 * for "no coding responsibility stated". Breezy's 0.2% actionable rate was
 * never about job quality; nobody could read the jobs.
 *
 * The two causes were different, and so are the fixes:
 *   lever   read ONE field of several. The content was already downloaded.
 *   breezy  the listing has no description field at all. Needs a detail fetch.
 */

describe('lever: assemble the body from whichever fields the tenant fills', () => {
  it('reads `description` when `descriptionPlain` is empty — the jobgether case', () => {
    // Measured live: jobgether returns descriptionPlain:"" alongside 1,574
    // chars of HTML in `description`, and that ONE mismatch accounted for
    // 9,087 empty bodies.
    const body = buildDescription({
      id: '1', text: 'Backend Engineer', hostedUrl: 'https://x',
      descriptionPlain: '',
      description: '<p>Build and operate Node.js services for our platform.</p>',
    } as never);
    expect(body).toMatch(/Build and operate Node\.js services/);
  });

  it('prefers the plain variant when both exist (no conversion needed)', () => {
    const body = buildDescription({
      id: '1', text: 'x', hostedUrl: 'https://x',
      descriptionPlain: 'PLAIN VERSION',
      description: '<p>HTML VERSION</p>',
    } as never);
    expect(body).toContain('PLAIN VERSION');
    expect(body).not.toContain('HTML VERSION');
  });

  it('joins opening + body + additional, because Lever splits some postings', () => {
    const body = buildDescription({
      id: '1', text: 'x', hostedUrl: 'https://x',
      openingPlain: 'About us.',
      descriptionPlain: 'What you will do.',
      additionalPlain: 'Benefits.',
    } as never);
    expect(body).toBe('About us.\n\nWhat you will do.\n\nBenefits.');
  });

  it('falls back to descriptionBody when description is absent', () => {
    const body = buildDescription({
      id: '1', text: 'x', hostedUrl: 'https://x',
      descriptionBodyPlain: 'Body via descriptionBody.',
    } as never);
    expect(body).toBe('Body via descriptionBody.');
  });

  it('returns empty — never whitespace — when the tenant fills nothing', () => {
    // This must stay distinguishable so the adapter can report MISSING rather
    // than passing '' off as a description.
    expect(buildDescription({ id: '1', text: 'x', hostedUrl: 'https://x' } as never)).toBe('');
    expect(
      buildDescription({ id: '1', text: 'x', hostedUrl: 'https://x', descriptionPlain: '   ' } as never),
    ).toBe('');
  });
});

describe('breezy: pull the body from the detail page ld+json', () => {
  const page = (inner: string) =>
    `<html><head><script type="application/ld+json">${inner}</script></head></html>`;

  it('extracts a JobPosting description', () => {
    const html = page(JSON.stringify({
      '@type': 'JobPosting',
      title: 'AI Staff Engineer',
      description: '<p>Design and ship backend services.</p>',
    }));
    expect(descriptionFromJobPostingLd(html)).toMatch(/Design and ship backend services/);
  });

  it('finds JobPosting inside @graph', () => {
    const html = page(JSON.stringify({
      '@graph': [{ '@type': 'Organization', name: 'Acme' },
                 { '@type': 'JobPosting', description: 'Write TypeScript daily.' }],
    }));
    expect(descriptionFromJobPostingLd(html)).toBe('Write TypeScript daily.');
  });

  it('skips a malformed ld+json block and keeps looking', () => {
    // Malformed ld+json is common; one bad block must not hide a good one.
    const html =
      `<script type="application/ld+json">{ not json </script>` +
      page(JSON.stringify({ '@type': 'JobPosting', description: 'Real body here.' }));
    expect(descriptionFromJobPostingLd(html)).toBe('Real body here.');
  });

  it('returns null when the page has no JobPosting — the MISSING case', () => {
    // null must stay distinct from '' so the adapter reports MISSING
    // (sought and unavailable) rather than storing a silent empty string.
    expect(descriptionFromJobPostingLd(page(JSON.stringify({ '@type': 'Organization' })))).toBeNull();
    expect(descriptionFromJobPostingLd('<html><body>no structured data</body></html>')).toBeNull();
  });

  it('returns null for a JobPosting whose description is empty', () => {
    const html = page(JSON.stringify({ '@type': 'JobPosting', description: '   ' }));
    expect(descriptionFromJobPostingLd(html)).toBeNull();
  });
});
