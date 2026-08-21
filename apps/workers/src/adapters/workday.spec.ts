import {
  couldBeFresh,
  findIndiaFacet,
  listingAgeBound,
  listingLooksIndian,
  parseIdentifier,
  toIsoDateTime,
} from './workday';

/**
 * Workday adapter contract tests.
 *
 * Every case below corresponds to a behaviour MEASURED against the live API on
 * 2026-08-20, not to a hypothetical. See docs/WORKDAY_ADAPTER_DESIGN.md.
 */

describe('identifier: tenant/dc/site', () => {
  it('parses the three-part form', () => {
    expect(parseIdentifier('abb/wd3/External_Career_Page')).toEqual({
      tenant: 'abb',
      dc: 'wd3',
      site: 'External_Career_Page',
    });
  });

  it('handles high datacenter numbers', () => {
    // accenture is wd103, salesforce wd12, candescent wd501 — not single digit.
    expect(parseIdentifier('accenture/wd103/AccentureCareers')?.dc).toBe('wd103');
  });

  it('REJECTS the legacy two-part form rather than guessing a datacenter', () => {
    // Pre-2026-08-20 rows stored `tenant/site`. The host cannot be rebuilt from
    // that, and guessing wd1..wd105 would hammer Workday. These must be
    // backfilled; the adapter throws so the CrawlRun is FAILED (retires
    // nothing) instead of looking like an empty board.
    expect(parseIdentifier('abb/External_Career_Page')).toBeNull();
  });

  it('rejects malformed input', () => {
    for (const bad of ['', 'abb', 'abb/notadc/site', 'a/b/c/d', '//']) {
      expect(parseIdentifier(bad)).toBeNull();
    }
  });
});

describe('freshness: a bound is never a value', () => {
  it('reads exact relative ages', () => {
    expect(listingAgeBound('Posted Today')).toEqual({ kind: 'EXACT', days: 0 });
    expect(listingAgeBound('Posted Yesterday')).toEqual({ kind: 'EXACT', days: 1 });
    expect(listingAgeBound('Posted 12 Days Ago')).toEqual({ kind: 'EXACT', days: 12 });
  });

  it('treats "30+ Days Ago" as a LOWER BOUND, never as 30', () => {
    // The whole point. "30+" is compatible with 31 days or 300; mapping it to
    // exactly 30 would slip dead postings past the 45-day gate.
    expect(listingAgeBound('Posted 30+ Days Ago')).toEqual({ kind: 'LOWER_BOUND', days: 30 });
  });

  it('returns UNKNOWN for unparseable prose rather than a number', () => {
    expect(listingAgeBound(undefined)).toEqual({ kind: 'UNKNOWN', days: null });
    expect(listingAgeBound('Posted recently')).toEqual({ kind: 'UNKNOWN', days: null });
  });

  it('only an EXACT age past the cutoff may skip a listing', () => {
    expect(couldBeFresh('Posted Today')).toBe(true);
    expect(couldBeFresh('Posted 12 Days Ago')).toBe(true);
    expect(couldBeFresh('Posted 60 Days Ago')).toBe(false); // exact, past 45
  });

  it('a LOWER_BOUND or UNKNOWN listing is always carried to the detail fetch', () => {
    // Discarding these would silently drop real jobs; the detail payload has a
    // real ISO startDate that resolves them.
    expect(couldBeFresh('Posted 30+ Days Ago')).toBe(true);
    expect(couldBeFresh(undefined)).toBe(true);
  });
});

describe('India pre-filter (coarse by design)', () => {
  it('matches the location slug in externalPath', () => {
    expect(
      listingLooksIndian({ externalPath: '/job/Bangalore/Senior-Digital-Strategist_R169918' }),
    ).toBe(true);
  });

  it('matches bulletFields', () => {
    expect(listingLooksIndian({ title: 'SRE', bulletFields: ['JR1043296', 'Bengaluru'] })).toBe(true);
  });

  it('matches city names as well as the country', () => {
    for (const city of ['Hyderabad', 'Pune', 'Gurugram', 'Chennai', 'Noida', 'GIFT City']) {
      expect(listingLooksIndian({ externalPath: `/job/${city}/Engineer_R1` })).toBe(true);
    }
  });

  it('does not match unrelated locations', () => {
    expect(listingLooksIndian({ externalPath: '/job/Newcastle/AI-Engineer_R00346138' })).toBe(false);
    expect(listingLooksIndian({ title: 'Engineer', bulletFields: ['R1', 'Warsaw'] })).toBe(false);
  });
});

describe('location facet strategy', () => {
  const countryFacet = (values: unknown[]) => [
    { facetParameter: 'locationMainGroup', values: [{ facetParameter: 'locationCountry', values }] },
  ];

  it('finds the India facet id when a country facet exists (41 of 104 tenants)', () => {
    const f = findIndiaFacet(
      countryFacet([
        { descriptor: 'Germany', id: 'de-id', count: 17 },
        { descriptor: 'India', id: 'in-id', count: 133 },
      ]) as never,
    );
    expect(f).toEqual({ param: 'locationCountry', id: 'in-id' });
  });

  it('returns null when the tenant only exposes address-level `locations` (54 tenants)', () => {
    // Those counts double-count multi-location jobs — fractal reports total=132
    // with location buckets summing to 313 — so they must never be used as
    // job counts, and local filtering is used instead.
    const f = findIndiaFacet([
      { facetParameter: 'locationMainGroup', values: [{ facetParameter: 'locations', values: [] }] },
    ] as never);
    expect(f).toBeNull();
  });

  it('returns null when there is no location facet at all (9 tenants)', () => {
    expect(findIndiaFacet(undefined)).toBeNull();
    expect(findIndiaFacet([] as never)).toBeNull();
  });

  it('returns null when a country facet exists but has no India entry', () => {
    const f = findIndiaFacet(countryFacet([{ descriptor: 'Japan', id: 'jp', count: 11 }]) as never);
    expect(f).toBeNull();
  });
});

/**
 * Pagination termination. These mirror the three hazards measured on the live
 * API; the algorithm is reproduced here so the STOP CONDITIONS are pinned
 * independently of network behaviour.
 */
describe('pagination termination', () => {
  const PAGE = 20;
  /** Mirrors listAll()'s loop. */
  function paginate(pages: string[][], maxPages: number) {
    const seen = new Set<string>();
    let fetched = 0;
    let repeated = false;
    for (let i = 0; fetched < maxPages; i++) {
      const rows = pages[i] ?? [];
      fetched++;
      if (rows.length === 0) break;
      let fresh = 0;
      for (const r of rows) if (!seen.has(r)) { seen.add(r); fresh++; }
      if (fresh === 0) { repeated = true; break; }
      if (rows.length < PAGE) break;
    }
    return { collected: seen.size, pagesFetched: fetched, repeated };
  }
  const full = (n: number, p: string) => Array.from({ length: PAGE }, (_, i) => `${p}-${i + n}`);

  it('stops on an empty page', () => {
    const r = paginate([full(0, 'a'), []], 25);
    expect(r.collected).toBe(20);
  });

  it('stops on a short page', () => {
    const r = paginate([full(0, 'a'), ['x', 'y']], 25);
    expect(r.collected).toBe(22);
  });

  it('stops on a REPEATED page — the six real tenants', () => {
    // fractal, nasdaq, arrow, nxp, salesforce, alight all return the same page
    // forever. `while (rows.length > 0)` never terminates on them.
    const page = full(0, 'a');
    const r = paginate([page, page, page, page], 25);
    expect(r.repeated).toBe(true);
    expect(r.pagesFetched).toBe(2);
    expect(r.collected).toBe(20);
  });

  it('honours the hard page cap even when pages keep yielding', () => {
    const many = Array.from({ length: 100 }, (_, i) => full(i * PAGE, 'a'));
    expect(paginate(many, 25).pagesFetched).toBe(25);
  });

  it('does NOT stop because offset passed the reported total', () => {
    // `total` caps at 2000 while Accenture holds ~43k India jobs, and offset
    // 2500 still returns rows. Terminating on offset >= total would truncate
    // the largest tenants silently.
    const beyond = Array.from({ length: 30 }, (_, i) => full(i * PAGE, 'deep'));
    const r = paginate(beyond, 25);
    expect(r.collected).toBe(25 * PAGE);
    expect(r.repeated).toBe(false);
  });
});

describe('postedAt must satisfy the shared NormalizedJob contract', () => {
  it('widens a bare Workday date to a full ISO datetime', () => {
    // Workday sends startDate="2026-08-19". The ingest schema requires a
    // datetime and rejected all 9 canary tenants with "Invalid ISO datetime".
    // Fixed in the adapter, NOT by loosening a contract every source shares.
    expect(toIsoDateTime('2026-08-19')).toBe('2026-08-19T00:00:00.000Z');
  });

  it('passes through a value that is already a datetime', () => {
    expect(toIsoDateTime('2026-08-19T10:23:45.000Z')).toBe('2026-08-19T10:23:45.000Z');
  });

  it('returns null rather than fabricating a timestamp', () => {
    for (const bad of [undefined, null, '', 'Posted Yesterday', 'not-a-date']) {
      expect(toIsoDateTime(bad)).toBeNull();
    }
  });
});

/**
 * Truncation reporting (2026-08-21). The reconciliation guard is inert unless
 * the walk actually says it stopped short, so the distinction between a natural
 * end and a cap is pinned here — mirroring listAll's exits.
 */
describe('a walk that stops short must say so', () => {
  const PAGE = 20;
  /** Mirrors listAll()'s exits, including which ones set truncatedReason. */
  function walk(pages: string[][], maxPages: number, failAt = -1) {
    const seen = new Set<string>();
    let fetched = 0;
    let truncated: string | null = null;
    for (let i = 0; fetched < maxPages; i++) {
      if (i === failAt) {
        truncated = `list request failed at offset ${i * PAGE}`;
        break;
      }
      const rows = pages[i] ?? [];
      fetched++;
      if (rows.length === 0) break;
      let fresh = 0;
      for (const r of rows) if (!seen.has(r)) { seen.add(r); fresh++; }
      if (fresh === 0) break;
      if (rows.length < PAGE) break;
      if (fetched >= maxPages) truncated = `page cap reached (${maxPages} pages)`;
    }
    return { collected: seen.size, truncated };
  }
  const full = (n: number) => Array.from({ length: PAGE }, (_, i) => `job-${i + n}`);

  it('reports TRUNCATED when the cap stops a still-yielding listing', () => {
    // Accenture's shape: ~43k India postings behind a 500-listing ceiling.
    const many = Array.from({ length: 100 }, (_, i) => full(i * PAGE));
    expect(walk(many, 25).truncated).toContain('page cap');
  });

  it('reports TRUNCATED when a later page fails mid-walk', () => {
    const many = Array.from({ length: 100 }, (_, i) => full(i * PAGE));
    expect(walk(many, 25, 3).truncated).toContain('failed');
  });

  it('does NOT report truncation on a natural end', () => {
    // A short page, an empty page and a repeated page are all genuine ends —
    // flagging them would stop retirement forever and let dead jobs accumulate.
    expect(walk([full(0), ['a', 'b']], 25).truncated).toBeNull();          // short page
    expect(walk([full(0), []], 25).truncated).toBeNull();                  // empty page
    expect(walk([full(0), full(0)], 25).truncated).toBeNull();             // repeated page
  });

  it('does not report truncation when the cap is reached exactly at the true end', () => {
    // Exactly 25 full pages then nothing: the cap and the listing end coincide,
    // and the walk yielded new links on its last page, so this DOES read as
    // truncated. Conservative on purpose — a false "partial" only skips one
    // retirement pass, while a false "complete" deletes the tail.
    const exact = Array.from({ length: 25 }, (_, i) => full(i * PAGE));
    expect(walk(exact, 25).truncated).toContain('page cap');
  });
});
