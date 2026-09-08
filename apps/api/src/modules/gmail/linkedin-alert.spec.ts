import {
  parseLinkedInAlert,
  matchesLinkedInAlert,
  canonicalJobUrl,
  jobIdFrom,
  parseRelativeDate,
} from './linkedin-alert.parser';

/**
 * ⚠️ SYNTHETIC FIXTURES. No real LinkedIn alert email has been seen. These
 * exercise plausible template shapes and the parser's failure behaviour; they
 * are NOT evidence that LinkedIn's actual emails parse. The first live run is
 * the real validation.
 *
 * What these tests DO establish is the part that does not depend on LinkedIn's
 * markup: the URL/id contract, the refusal rules, and that nothing is ever
 * invented when a field is absent.
 */

const META = { messageId: 'msg-1', receivedAt: new Date('2026-09-09T10:00:00Z') };

/** Shape A — table-based card, the classic layout. */
const FIXTURE_A = `
<html><body>
<table><tr><td>
  <a href="https://www.linkedin.com/comm/jobs/view/4012345678/?trackingId=abc%3D&refId=xyz">
    Backend Engineer
  </a>
  <div>Razorpay</div>
  <div>Bengaluru, Karnataka, India</div>
  <div>2 days ago</div>
</td></tr>
<tr><td>
  <a href="https://www.linkedin.com/comm/jobs/view/4099999999/?trackingId=def">
    Node.js Developer
  </a>
  <div>Zerodha</div>
  <div>Mumbai, Maharashtra, India</div>
  <div>5 hours ago</div>
</td></tr></table>
</body></html>`;

/** Shape B — div-based, no relative date, different attribute order. */
const FIXTURE_B = `
<html><body>
<div class="job-card">
  <a class="title" target="_blank" href="https://www.linkedin.com/jobs/view/4055555555">Full Stack Engineer</a>
  <span>Freshworks</span>
  <span>Chennai, Tamil Nadu, India</span>
</div>
</body></html>`;

describe('URL and id contract — the part that does not depend on markup', () => {
  it('extracts a stable id and strips per-recipient tracking', () => {
    // The same posting arrives with a different trackingId in every digest.
    // An unstripped URL would defeat dedup and create one "job" per email.
    const a = 'https://www.linkedin.com/comm/jobs/view/4012345678/?trackingId=AAA&refId=1';
    const b = 'https://www.linkedin.com/comm/jobs/view/4012345678/?trackingId=BBB&refId=2';
    expect(canonicalJobUrl(a)).toBe('https://www.linkedin.com/jobs/view/4012345678');
    expect(canonicalJobUrl(a)).toBe(canonicalJobUrl(b));
    expect(jobIdFrom(a)).toBe('4012345678');
  });

  it('returns null for anything that is not a job-view URL', () => {
    expect(canonicalJobUrl('https://www.linkedin.com/feed/')).toBeNull();
    expect(canonicalJobUrl('https://example.com/jobs/view/123456')).toBeNull();
    expect(jobIdFrom('https://www.linkedin.com/jobs/')).toBeNull();
  });
});

describe('parseRelativeDate — never guess a date', () => {
  const now = new Date('2026-09-09T10:00:00Z');

  it('reads the phrases it can read', () => {
    expect(parseRelativeDate('2 days ago', now)?.toISOString()).toBe('2026-09-07T10:00:00.000Z');
    expect(parseRelativeDate('5 hours ago', now)?.toISOString()).toBe('2026-09-09T05:00:00.000Z');
  });

  it('returns NULL rather than falling back to now', () => {
    // `freshness` scores an unknown date as maximally fresh -- the latent bug in
    // the roadmap. Guessing here would make every alert job look posted today
    // and outrank genuinely fresh postings.
    expect(parseRelativeDate('Posted recently', now)).toBeNull();
    expect(parseRelativeDate('', now)).toBeNull();
    expect(parseRelativeDate('Reposted', now)).toBeNull();
  });

  it('rejects implausible values instead of accepting them', () => {
    expect(parseRelativeDate('0 days ago', now)).toBeNull();
    expect(parseRelativeDate('9999 days ago', now)).toBeNull();
  });
});

describe('matchesLinkedInAlert', () => {
  it('matches the alert senders', () => {
    expect(matchesLinkedInAlert('jobalerts-noreply@linkedin.com', 'anything')).toBe(true);
    expect(matchesLinkedInAlert('jobs-listings@linkedin.com', 'x')).toBe(true);
  });

  it('matches a linkedin sender by subject', () => {
    expect(matchesLinkedInAlert('messages-noreply@linkedin.com', '5 new jobs for you')).toBe(true);
  });

  it('never matches a non-LinkedIn sender, whatever the subject says', () => {
    // Otherwise a phishing mail titled "Job alert" would be parsed as a feed.
    expect(matchesLinkedInAlert('noreply@linkedin.com.evil.tld', 'Job alert')).toBe(false);
    expect(matchesLinkedInAlert('hr@example.com', 'New jobs for you')).toBe(false);
  });
});

describe('parsing (synthetic shapes)', () => {
  it('extracts jobs from a table-based card', () => {
    const jobs = parseLinkedInAlert(FIXTURE_A, META);
    expect(jobs).toHaveLength(2);
    expect(jobs[0].job.title).toBe('Backend Engineer');
    expect(jobs[0].company.name).toBe('Razorpay');
    expect(jobs[0].job.externalId).toBe('linkedin:4012345678');
    expect(jobs[0].job.url).toBe('https://www.linkedin.com/jobs/view/4012345678');
  });

  it('extracts from a different layout without markup-specific rules', () => {
    const jobs = parseLinkedInAlert(FIXTURE_B, META);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].job.title).toBe('Full Stack Engineer');
    expect(jobs[0].company.name).toBe('Freshworks');
  });

  it('ALWAYS marks the description MISSING — alerts carry no body', () => {
    // This is what lets INSUFFICIENT_EVIDENCE hold the job instead of judging
    // it blind, the protection built after 6,907 jobs were refused
    // NOT_DEVELOPMENT for descriptions nobody had.
    for (const j of parseLinkedInAlert(FIXTURE_A, META)) {
      expect(j.job.description).toBe('');
      expect(j.job.descriptionSource).toBe('MISSING');
    }
  });

  it('leaves postedAt null when the email states no date', () => {
    expect(parseLinkedInAlert(FIXTURE_B, META)[0].job.postedAt).toBeNull();
  });

  it('leaves country null — normalizeCountry decides at the choke point', () => {
    expect(parseLinkedInAlert(FIXTURE_A, META)[0].job.country).toBeNull();
  });

  it('preserves evidence for replay', () => {
    // A parser change can then be re-run against stored evidence rather than
    // re-fetched, the same pattern as extraction_snapshots.
    const raw = parseLinkedInAlert(FIXTURE_A, META)[0].job.raw as { messageId: string };
    expect(raw.messageId).toBe('msg-1');
  });

  it('deduplicates a posting repeated within one email', () => {
    const twice = FIXTURE_A + FIXTURE_A;
    const ids = parseLinkedInAlert(twice, META).map((j) => j.job.externalId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('refusal behaviour — reject rather than invent', () => {
  it('yields nothing for an email with no job links', () => {
    expect(parseLinkedInAlert('<html><body>Your network is hiring!</body></html>', META)).toEqual([]);
  });

  it('skips a link with no extractable title', () => {
    // BoardJobSchema requires a title; a job without one is not a job. Better a
    // parseFailure that is counted than a row titled "View job".
    const html = '<html><a href="https://www.linkedin.com/jobs/view/4012345678"></a></html>';
    expect(parseLinkedInAlert(html, META)).toEqual([]);
  });

  it('never emits an entry without a company', () => {
    const html =
      '<html><a href="https://www.linkedin.com/jobs/view/4012345678">Backend Engineer</a></html>';
    for (const j of parseLinkedInAlert(html, META)) {
      expect(j.company.name.length).toBeGreaterThan(0);
    }
  });

  it('survives malformed HTML without throwing', () => {
    expect(() => parseLinkedInAlert('<html><a href="', META)).not.toThrow();
    expect(() => parseLinkedInAlert('', META)).not.toThrow();
  });
});

/**
 * Shape C -- markup noise. Bulk mail carries per-section <style> blocks
 * (Outlook conditionals especially) and hidden preheader text between the
 * fields. Synthetic, like the others, but it pins a failure mode that a clean
 * fixture cannot: an unstripped CSS rule sits exactly where the company name
 * is looked for, and would be adopted as the employer.
 */
const FIXTURE_C = `
<html><body>
<div class="job-card">
  <a href="https://www.linkedin.com/jobs/view/4077777777">Platform Engineer</a>
  <style>.card{color:#0a66c2;padding:12px}</style>
  <span style="display:none">&nbsp;</span>
  <div>Postman</div>
  <div>Bengaluru, Karnataka, India</div>
</div>
</body></html>`;

describe('markup noise -- CSS is never a field', () => {
  it('strips style blocks rather than reading them as the company', () => {
    // Without the strip, `.card{color:#0a66c2;padding:12px}` is the first
    // plausible line after the title and becomes the employer name -- a
    // company row, a fingerprint and a judged job, all from a stylesheet.
    const jobs = parseLinkedInAlert(FIXTURE_C, META);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].job.title).toBe('Platform Engineer');
    expect(jobs[0].company.name).toBe('Postman');
  });

  it('keeps stored evidence free of CSS so a replay reads the same email', () => {
    const raw = parseLinkedInAlert(FIXTURE_C, META)[0].job.raw as { block: string };
    expect(raw.block).not.toContain('#0a66c2');
  });
});

describe('sender domain -- contains is not equals', () => {
  it('rejects a lookalike domain that merely contains linkedin.com', () => {
    for (const f of [
      'noreply@linkedin.com.evil.tld',
      'jobalerts-noreply@linkedin.com.attacker.io',
      'jobs-listings@notlinkedin.com',
    ]) {
      expect(matchesLinkedInAlert(f, '5 new jobs for you')).toBe(false);
    }
  });

  it('accepts linkedin.com and its subdomains', () => {
    expect(matchesLinkedInAlert('jobalerts-noreply@linkedin.com', 'x')).toBe(true);
    expect(matchesLinkedInAlert('jobs-noreply@e.linkedin.com', 'x')).toBe(true);
  });

  it('reads the address out of a display-name form', () => {
    expect(matchesLinkedInAlert('LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>', 'x')).toBe(true);
  });
});

/**
 * Field-level assertions.
 *
 * These exist because the first parser passed every test above while storing
 * "Engineer Razorpay Bengaluru, Karnataka, India" as the location and giving
 * card 2 card 1's posting date. Both values were present and plausible; nothing
 * errored. A test that only checks title/company cannot see either.
 */
describe('per-card field isolation', () => {
  it('reads each card its OWN date, not the previous card', () => {
    // FIXTURE_A card 1 is "2 days ago", card 2 is "5 hours ago". Reading the
    // window backward made both 2 days -- silently ageing a fresh posting, and
    // postedAt feeds freshness scoring.
    const jobs = parseLinkedInAlert(FIXTURE_A, META);
    expect(jobs[0].job.postedAt).toBe('2026-09-07T10:00:00.000Z');
    expect(jobs[1].job.postedAt).toBe('2026-09-09T05:00:00.000Z');
  });

  it('reads each card its OWN location', () => {
    const jobs = parseLinkedInAlert(FIXTURE_A, META);
    expect(jobs[0].job.location).toBe('Bengaluru, Karnataka, India');
    expect(jobs[1].job.location).toBe('Mumbai, Maharashtra, India');
  });

  it('does not let the title bleed into the location', () => {
    // The location regex, run over a flattened card, starts matching at
    // "Engineer" and swallows the title and company with it.
    for (const j of parseLinkedInAlert(FIXTURE_A, META)) {
      expect(j.job.location).not.toMatch(/Engineer|Developer/);
      expect(j.job.location).not.toContain(j.company.name);
    }
    expect(parseLinkedInAlert(FIXTURE_B, META)[0].job.location).toBe('Chennai, Tamil Nadu, India');
  });

  it('leaves location null rather than guessing when no place is stated', () => {
    const html =
      '<html><a href="https://www.linkedin.com/jobs/view/4012345678">Backend Engineer</a><div>Razorpay</div></html>';
    const jobs = parseLinkedInAlert(html, META);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].job.location).toBeNull();
    expect(jobs[0].job.postedAt).toBeNull();
  });
});
