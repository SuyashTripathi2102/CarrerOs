import {
  assessPair,
  identityConfidence,
  identityTokenFromUrl,
  isReviewCandidate,
  normalizeCompanyName,
  shouldAutoMerge,
} from './company-identity';

/**
 * ADR-11 regression suite.
 *
 * The must-not-merge cases are the point of this file. Under-merging costs a
 * duplicate row; over-merging silently fuses two companies' funding, hiring
 * velocity, contacts and outcomes, and cannot be undone once downstream signals
 * are computed.
 */

const tok = (u: string) => identityTokenFromUrl(u)?.token ?? null;

describe('identity token extraction', () => {
  it('treats a first-party Workday tenant as identity', () => {
    // motorolasolutions.wd5 is unique to that customer.
    expect(tok('https://motorolasolutions.wd5.myworkdayjobs.com/en-US/careers/job/123')).toBe(
      'motorolasolutions.wd5.myworkdayjobs.com',
    );
  });

  it('treats a first-party Oracle Fusion tenant as identity', () => {
    // Zensar and Hexaware sit on different fa-XXXX prefixes; this is the
    // evidence that let both pairs merge safely.
    expect(tok('https://fa-etvl-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/Candidate/job/1')).toBe(
      'fa-etvl-saasfaprod1.fa.ocs.oraclecloud.com',
    );
  });

  it('requires the PATH token on multi-tenant Greenhouse, never the host', () => {
    expect(tok('https://job-boards.greenhouse.io/gitlab/jobs/123')).toBe(
      'job-boards.greenhouse.io/gitlab',
    );
  });

  it('returns null for a multi-tenant host with no tenant segment', () => {
    // Host alone would merge every Greenhouse company on earth.
    expect(tok('https://job-boards.greenhouse.io/')).toBeNull();
  });

  it('covers REGIONAL greenhouse hosts, not just the ones enumerated', () => {
    // job-boards.eu.greenhouse.io fell through to FIRST_PARTY and became one
    // shared token across 6 unrelated companies (Bybit, Groww, Moniepoint...).
    expect(tok('https://job-boards.eu.greenhouse.io/groww/jobs/1')).toBe(
      'job-boards.eu.greenhouse.io/groww',
    );
    expect(tok('https://job-boards.eu.greenhouse.io/bybit/jobs/2')).not.toBe(
      tok('https://job-boards.eu.greenhouse.io/groww/jobs/1'),
    );
  });

  it('rejects route literals that are not tenants -- the Workable /j/ form', () => {
    // apply.workable.com/j/<JOBID>: "j" is a literal and the next segment is a
    // JOB id. 18 distinct companies shared the token `apply.workable.com/j`,
    // any pair of which could have reached STRONG on false evidence.
    expect(tok('https://apply.workable.com/j/3B503127EF')).toBeNull();
    expect(tok('https://apply.workable.com/j/C8DCCA2278')).toBeNull();
  });

  it('still reads a real Workable tenant when the company IS in the path', () => {
    expect(tok('https://apply.workable.com/acme-inc/j/ABC123')).toBe('apply.workable.com/acme-inc');
  });

  it('reads the subdomain tenant on breezy/recruitee style hosts', () => {
    expect(tok('https://acme.breezy.hr/p/abc-engineer')).toBe('acme.breezy.hr');
  });

  it('strips www and lowercases', () => {
    expect(tok('https://WWW.Acme-Corp.com/careers/1')).toBe('acme-corp.com');
  });

  it('returns null for unparseable or non-http URLs', () => {
    expect(tok('not a url')).toBeNull();
    expect(tok('ftp://example.com/x')).toBeNull();
    expect(identityTokenFromUrl(null)).toBeNull();
    expect(identityTokenFromUrl(undefined)).toBeNull();
  });
});

describe('aggregator hosts NEVER confer identity', () => {
  // The catastrophic case: one aggregator host would collapse every company it
  // carries into a single row.
  it.each([
    'https://echojobs.io/job/abc',
    'https://remoteOK.com/remote-jobs/12345',
    'https://www.linkedin.com/jobs/view/999',
    'https://himalayas.app/jobs/xyz',
    'https://www.indeed.com/viewjob?jk=1',
    'https://jobgether.com/offer/123',
    'https://freehire.me/jobs/abc',
  ])('%s yields no identity', (url) => {
    expect(tok(url)).toBeNull();
  });

  it('is the reason Paytm does not auto-merge', () => {
    // Paytm serves from jobs.lever.co/paytm (245 jobs); PAYTM SERVICES PVT LTD
    // arrived via remoteOK. One side has no identity, so this is UNKNOWN --
    // review, not a merge and not a split.
    const real = { name: 'Paytm', token: tok('https://jobs.lever.co/paytm/abc') };
    const other = {
      name: 'PAYTM SERVICES PVT LTD',
      token: tok('https://remoteOK.com/remote-jobs/1'),
    };
    expect(other.token).toBeNull();
    expect(identityConfidence(real, other)).not.toBe('STRONG');
    expect(shouldAutoMerge(identityConfidence(real, other))).toBe(false);
  });
});

describe('the proposal key is companies/company-name.ts, not a second normalizer', () => {
  it('ignores case, punctuation and legal form', () => {
    expect(normalizeCompanyName('GitLab Inc.')).toBe(normalizeCompanyName('GitLab'));
    expect(normalizeCompanyName('Danaher Corporation')).toBe(normalizeCompanyName('Danaher'));
  });

  it('does NOT collapse internal whitespace -- so JPMorganChase goes to review', () => {
    // "JP Morgan Chase" -> "jp morgan chase" but "JPMorganChase" ->
    // "jpmorganchase". A real alias (7/7 split in the corpus) that the key
    // deliberately does not propose. Under-merge is the safe failure, and
    // ADR-11 already routes this pair to human review rather than guessing.
    expect(normalizeCompanyName('JPMorganChase')).not.toBe(normalizeCompanyName('JP Morgan Chase'));
  });

  it('strips technologies/technology -- the two approved backfill pairs', () => {
    expect(normalizeCompanyName('Zensar Technologies')).toBe(normalizeCompanyName('Zensar'));
    expect(normalizeCompanyName('Hexaware Technologies')).toBe(normalizeCompanyName('HEXAWARE'));
  });

  it('never strips DESCRIPTIVE words -- these must stay apart', () => {
    // "Solutions", "Bank", "Capital" can genuinely distinguish employers, so
    // Motorola/Motorola Solutions never even becomes a candidate on name alone.
    expect(normalizeCompanyName('Apple')).not.toBe(normalizeCompanyName('Apple Bank'));
    expect(normalizeCompanyName('Motorola')).not.toBe(normalizeCompanyName('Motorola Solutions'));
    expect(normalizeCompanyName('Paytm')).not.toBe(normalizeCompanyName('PAYTM SERVICES PVT LTD'));
  });
});

describe('confidence hierarchy -- only STRONG automates', () => {
  const oracleZensar = 'https://fa-etvl-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/job/1';
  const oracleHexaware = 'https://fa-etqo-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/job/1';

  it('STRONG: compatible name + same tenant -> auto-merge', () => {
    const c = identityConfidence(
      { name: 'Zensar', token: tok(oracleZensar) },
      { name: 'Zensar Technologies', token: tok(oracleZensar) },
    );
    expect(c).toBe('STRONG');
    expect(shouldAutoMerge(c)).toBe(true);
  });

  it('STRONG covers the second approved backfill pair', () => {
    expect(
      identityConfidence(
        { name: 'HEXAWARE', token: tok(oracleHexaware) },
        { name: 'Hexaware Technologies', token: tok(oracleHexaware) },
      ),
    ).toBe('STRONG');
  });

  it('different tenants are UNKNOWN, not a merge and not a split', () => {
    // ADR-11 rule 5. Companies legitimately run more than one ATS, so a
    // differing tenant proves nothing. Originally specified as "evidence they
    // are different companies"; the Paytm row disproved that.
    const c = identityConfidence(
      { name: 'Zensar', token: tok(oracleZensar) },
      { name: 'Zensar Technologies', token: tok(oracleHexaware) },
    );
    expect(c).toBe('UNKNOWN');
    expect(shouldAutoMerge(c)).toBe(false);
  });

  it('MEDIUM: no tenancy but a shared canonical domain -> review', () => {
    const c = identityConfidence(
      { name: 'Nordson', domain: 'nordson.com' },
      { name: 'Nordson Corporation', domain: 'nordson.com' },
    );
    expect(c).toBe('MEDIUM');
    expect(shouldAutoMerge(c)).toBe(false);
  });

  it('WEAK: name only -> review', () => {
    const c = identityConfidence({ name: 'Danaher' }, { name: 'Danaher Corporation' });
    expect(c).toBe('WEAK');
    expect(shouldAutoMerge(c)).toBe(false);
  });

  it('MUST NOT MERGE: Apple vs Apple Bank, even on the same host', () => {
    // The headline safety case. Names never propose, so tenancy is never even
    // consulted -- a shared host cannot rescue an unrelated name.
    const c = identityConfidence(
      { name: 'Apple', token: 'jobs.example.com' },
      { name: 'Apple Bank', token: 'jobs.example.com' },
    );
    expect(c).toBe('UNKNOWN');
    expect(shouldAutoMerge(c)).toBe(false);
  });

  it('MUST NOT MERGE: two Greenhouse companies sharing the host', () => {
    const a = { name: 'Acme', token: tok('https://job-boards.greenhouse.io/acme/jobs/1') };
    const b = { name: 'Globex', token: tok('https://job-boards.greenhouse.io/globex/jobs/2') };
    expect(a.token).not.toBe(b.token);
    expect(shouldAutoMerge(identityConfidence(a, b))).toBe(false);
  });

  it('MUST NOT MERGE: same aggregator host, different companies', () => {
    const a = { name: 'Acme', token: tok('https://echojobs.io/job/1') };
    const b = { name: 'Globex', token: tok('https://echojobs.io/job/2') };
    expect(a.token).toBeNull();
    expect(b.token).toBeNull();
    expect(shouldAutoMerge(identityConfidence(a, b))).toBe(false);
    // And crucially NOT even a review candidate: two nulls are not a tenant
    // match, or every aggregator-sourced company would pair with every other.
    expect(assessPair(a, b).basis).toBe('NONE');
    expect(isReviewCandidate(assessPair(a, b))).toBe(false);
  });

  it('unrelated companies with no shared evidence are not candidates at all', () => {
    const a = assessPair(
      { name: 'Acme', token: 'acme.wd1.myworkdayjobs.com' },
      { name: 'Globex', token: 'globex.wd1.myworkdayjobs.com' },
    );
    expect(a.basis).toBe('NONE');
    expect(isReviewCandidate(a)).toBe(false);
  });

  it('records WHY, so review shows evidence rather than a bare verdict', () => {
    const t = 'fa-etvl-saasfaprod1.fa.ocs.oraclecloud.com';
    expect(assessPair({ name: 'Zensar', token: t }, { name: 'Zensar Technologies', token: t })).toEqual(
      { confidence: 'STRONG', basis: 'NAME_AND_TENANT' },
    );
    expect(
      assessPair(
        { name: 'Danaher', token: 'jobs.danaher.com' },
        { name: 'Danaher Corporation', token: 'danaher.wd1.myworkdayjobs.com' },
      ),
    ).toEqual({ confidence: 'UNKNOWN', basis: 'NAME_TENANT_CONFLICT' });
    expect(assessPair({ name: 'Nordson' }, { name: 'Nordson Corporation' })).toEqual({
      confidence: 'WEAK',
      basis: 'NAME_ONLY',
    });
  });

  it('MUST NOT MERGE: unrelated names sharing a tenant are review, never merge', () => {
    // A tenant can host a parent brand and a subsidiary. TENANT_ONLY surfaces
    // the pair for a human; it must never automate.
    const t = 'jpmc.fa.oraclecloud.com';
    const a = assessPair({ name: 'JP Morgan Chase', token: t }, { name: 'JPMorganChase', token: t });
    expect(a).toEqual({ confidence: 'UNKNOWN', basis: 'TENANT_ONLY' });
    expect(shouldAutoMerge(a.confidence)).toBe(false);
    expect(isReviewCandidate(a)).toBe(true);
  });

  it('Motorola/Motorola Solutions stays UNKNOWN even sharing a tenant', () => {
    // Both do serve from motorolasolutions.wd5, so tenancy alone would merge
    // them -- but "Solutions" is descriptive and the name never proposes, so
    // the pair never reaches the tenancy check. Deliberate: names gate the
    // whole rule, which is what keeps `Apple`/`Apple Bank` safe on a shared
    // host. Nothing to merge in the corpus today anyway (no duplicate exists).
    const t = tok('https://motorolasolutions.wd5.myworkdayjobs.com/careers/job/1');
    const c = identityConfidence(
      { name: 'Motorola', token: t },
      { name: 'Motorola Solutions', token: t },
    );
    expect(c).toBe('UNKNOWN');
    expect(shouldAutoMerge(c)).toBe(false);
  });
});
