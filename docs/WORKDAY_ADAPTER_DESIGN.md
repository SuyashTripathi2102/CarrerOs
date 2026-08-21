# Workday adapter — implementation design

> Status: **DESIGN ONLY — nothing built, nothing ingested.**
> Written 2026-08-20. Read `CLAUDE.md`, `docs/DECISIONS.md` (ADR-11) first.

## Why this exists

Not "add another source". Measured 2026-08-20:

```
FreeHire holds 76.7% of all actionable opportunities, from 3.6% of jobs.
When its API went down for ~7h, three quarters of the pipeline had no fallback.
```

104 companies in the corpus are identified as Workday and are **100%
FreeHire-only** — no other source can reach them. They contribute 302 active
jobs today. The Workday CXS API exposes far more, so this is both a resilience
layer and a supply expansion.

**Objective: reduce single-source dependency and increase first-party
acquisition — not merely raise the job count.**

---

## 1. Measured facts (proven)

| fact | value | how measured |
|---|---|---|
| tenants reachable | 104 / 104 | full CXS probe, zero errors, zero empty |
| latency (list) | p50 1,441 ms · p90 2,135 ms | 104-tenant run |
| latency (detail) | 483 ms | single GET |
| India + ≤45d found | **≥ 7,470** | bounded 300/tenant pull — a **floor** |
| novelty | 7,333 of 7,461 (98.3%) | URL-path + requisition-id match vs whole corpus |
| duplicates found | 105 exact + 23 req-id, all FreeHire | as above |
| tenant/dc/site recoverable | 104 / 104 | 44 via `identityToken`, 104 via job URL |
| pagination repeats a page | 6 tenants | fractal, nasdaq, arrow, nxp, salesforce, alight |
| `total` is capped | at 2000 | Accenture: `total=2000`, offset 2500 still returns rows |
| `locations` facet double-counts | yes | fractal: total 132, buckets sum 313 |
| `limit` ceiling | 20 | 50/100/200 all error |

---

## 2. Adapter contract — no new interface

The existing contract is:

```ts
export interface AtsAdapter {
  source: string;
  fetchJobs(identifier: string): Promise<NormalizedJob[]>;
}
```

Workday needs `tenant`, `datacenter`, `site`. `detectAts()` currently stores
only `tenant/site` — **the `wdN` datacenter is discarded**:

```ts
const tenant = host.split('.')[0];              // "abb" — wd3 thrown away
return { provider: 'WORKDAY', identifier: `${tenant}/${site}` };
```

**Decision: widen the identifier string to `tenant/dc/site`.** No interface
change, no schema change, no special case in the dispatcher — `atsIdentifier`
is already a free-form string per provider (Greenhouse stores a board token,
Lever a slug). Workday simply stores three segments instead of two.

Migration for the existing 104 rows is a backfill from the newest job URL, which
is proven to work for 104/104.

`crawl-company.processor.ts` gains one line in `ADAPTERS` and Workday joins
`CRAWLABLE_PROVIDERS`. Everything downstream — `syncCompanyJobs`, dedup,
ADR-11 identity, embeddings, the evaluation belt — is untouched.

---

## 3. Data flow

```
company (atsProvider=WORKDAY, atsIdentifier=tenant/dc/site)
        ↓
  LIST  POST /wday/cxs/{tenant}/{site}/jobs   limit=20, paged
        ↓
  location strategy (§5) → India candidates only
        ↓
  DETAIL GET /wday/cxs/{tenant}/{site}{externalPath}
        ↓  authoritative country + startDate + jobDescription
  freshness filter (§6) on the REAL date
        ↓
  NormalizedJob[]  → api.syncCompanyJobs(companyId, 'workday', jobs)
        ↓
  the existing spine: validate → fingerprint dedup → ingest → embed → evaluate
```

---

## 4. Pagination algorithm

Three independent termination conditions. **`offset >= total` is NOT one of
them** — `total` caps at 2000 and would truncate Accenture at 2,000 of ~43,000.

```
seen = Set<externalPath>
for (offset = 0; offset < HARD_CAP; offset += 20):
    page = POST(... offset ...)
    if page is empty                 -> stop  (natural end)
    newInPage = paths not already in seen
    if newInPage == 0                -> stop  (REPEATED PAGE — 6 tenants do this)
    if pagesFetched >= MAX_PAGES     -> stop  (hard ceiling)
    seen += page paths
```

`MAX_PAGES` env-tunable, default 25 (500 listings/tenant). The seen-ID check is
the load-bearing one: six tenants return the same page forever and a naive
`while (rows.length > 0)` never terminates.

---

## 5. Location strategy — three implementations, one interface

Measured split across 104 tenants: `locationCountry` **41** · `locations` **54**
· none **9**.

```
A. locationCountry facet present (41)
   → apply appliedFacets: { locationCountry: [indiaFacetId] }
   → server-side filter, exact, cheapest

B. locations facet only (54)
   → facet counts are UNUSABLE (double-count multi-location jobs)
   → list unfiltered, prefilter locally on externalPath + bulletFields
   → confirm via detail-fetch country

C. no location facet (9)
   → list unfiltered, same local prefilter as B
```

All three return the same `NormalizedJob[]`. The branching lives **inside the
adapter**, never leaks into the pipeline.

**The listing-level prefilter is coarse on purpose** — `externalPath` contains
a location slug (`/job/Bangalore/...`) and `bulletFields` carries `["R169918",
"Bangalore"]`. It is a cheap filter to avoid detail-fetching obvious non-India
rows; the detail fetch is the authority.

---

## 6. Freshness — bounded state, resolved by the detail fetch

The **listing** gives only prose:

```
"Posted Today" · "Posted 2 Days Ago" · "Posted 30+ Days Ago"
```

`30+` is a **LOWER_BOUND**, compatible with 31 days or 300. Per
`careeros-absence-of-evidence`, it must never be silently mapped to 30 — that
would let long-dead postings through the 45-day gate.

The **detail** endpoint returns a real ISO date:

```
startDate: "2026-08-19"
```

**So freshness is decided on `startDate`, never on the prose.** The prose is
used only as a cheap pre-filter: anything showing "Posted Today/N Days Ago"
where N ≤ 45 is a candidate; `30+` rows are candidates too (they may be 31
days) and are resolved by the detail fetch. Nothing is discarded on an
unbounded string.

---

## 7. Description-fetch strategy — recommend **B (prefilter, then fetch)**

The A/B/C comparison changed once the detail endpoint was actually tested. It
returns far more than a description:

```
jobDescription  8,093 chars
country         "India"        ← structured, authoritative
startDate       "2026-08-19"   ← real ISO date
location, jobReqId, externalUrl
```

| option | requests | cost | verdict |
|---|---|---|---|
| **A — fetch every listing's detail** | ~75k+ | hours of upstream load for mostly non-India rows | reject |
| **B — prefilter, then fetch candidates** | ~7.5k | ~12 min at concurrency 5 | **recommended** |
| **C — ingest listings without details** | ~0 | no country, no real date, no description | reject |

C fails hard: without the detail fetch there is no reliable country, no real
date, and no description — and the classifier needs a description to judge
eligibility at all. Ingesting title-only rows would starve the gate and produce
`UNKNOWN` verdicts at scale.

B is the only option that gets authoritative data at sane cost. At the measured
≥7,470 India+fresh candidates × 483 ms, one full pass is roughly **60 min
sequential, ~12 min at concurrency 5**.

---

## 8. Concurrency, rate limits, cost

```
company-level    existing CRAWL_CONCURRENCY (default 5) — unchanged
detail fetches   concurrency 3 per tenant, 150 ms spacing
page fetches     150 ms between pages of the same tenant
timeouts         list 20 s · detail 15 s
```

No rate limit was ever observed — but **that is because nothing pushed hard
enough to find one** (§12). Start conservative.

**AI cost is unchanged by this adapter.** It fetches and normalizes; embedding
and classification happen downstream on the same budget guard
(`AI_DAILY_BUDGET_USD`). The new volume *will* consume that budget faster, and
at ~$0.0073/decision a 7,000-job intake is roughly **$50** spread across the
belt's normal cadence. Worth stating plainly before it happens.

---

## 9. Failure and reconciliation behaviour

Inherited unchanged from `crawl-reconciliation.ts` — no Workday-specific path:

```
empty result   → decideReconciliation → retire NOTHING
adapter throws → CrawlRun FAILED, retire NOTHING
partial pages  → whatever was fetched is upserted; absent jobs NOT retired
                 (an incomplete crawl is not authority over the board)
```

A Workday crawl only ever reconciles `source='workday'` rows — it can never
retire a FreeHire job for the same company (guard 2). During rollout both
sources will legitimately hold the same jobs; fingerprint dedup handles the
surface, and duplication is the safe failure.

---

## 10. Identity and attribution

ADR-11 applies unchanged. Two Workday specifics:

- `identityToken` for these companies is the **tenant host**
  (`abb.wd3.myworkdayjobs.com`) — already first-party and unambiguous, not an
  aggregator host.
- Tenant collisions (two company rows sharing one Workday tenant) are STRONG
  merge evidence and route to the existing ADR-11 resolver. `jda` and
  `issgovernance` already appear twice in the 104 and are likely aliases.

**Attribution gap (not fixed here):** `jobs.source` will say `workday` while
`companies.discoverySource` still says `board`. The fact that FreeHire
*discovered* these 104 companies will be invisible once Workday supplies their
jobs — exactly the mismeasurement that made FreeHire look like 6 APPLY when 22
sat at companies it found. Recorded as a known gap; needs `discoveredBy`
separate from `acquiredFrom`.

---

## 11. Schema changes

**None required.** `atsIdentifier` is a free-form string; widening it to
`tenant/dc/site` is data, not schema. One backfill script updates the 104
existing rows from their newest job URL.

---

## 12. Assumptions NOT yet proven by measurement

Stated explicitly so none of these silently becomes a requirement:

1. **≥7,470 is a floor, not a total.** The pull was capped at 300/tenant and
   several tenants hit that ceiling. The true India+fresh volume is unknown and
   larger.
2. **7,333 "new" is bounded by the same sample** and by the matching rules used
   (exact path, requisition id). It means *not found in CareerOS under those
   rules*, not *provably unique*.
3. **India volume for the 54 `locations` and 9 no-facet tenants is unknown** —
   their facet counts are unusable or absent. Only the 41 `locationCountry`
   tenants have trustworthy counts.
4. **No rate limit has been observed — because none was provoked.** A full
   production pass is far heavier than any probe run so far.
5. **The `postedOn` bucket distribution is unmeasured.** If a large share of
   India rows are `30+`, the detail-fetch volume is higher than estimated.
6. **Eligibility-gate pass rate is unknown.** Workday skews large-enterprise;
   these may gate-refuse at a different rate than FreeHire's mid-market mix, so
   actionable yield is *not* predictable from FreeHire's 126.5/1k.
7. **The detail endpoint was tested on one tenant.** Its shape is assumed
   consistent across all 104; not verified.
8. **`MAX_PAGES=25` is a chosen ceiling, not a measured optimum.**

---

## 13. Test matrix

| area | cases |
|---|---|
| identifier | `tenant/dc/site` parse · legacy `tenant/site` · malformed · missing dc |
| pagination | natural end · repeated page (the 6 real tenants) · hard cap · `offset > total` still yielding rows |
| location A | facet id applied · India facet absent |
| location B/C | path/bulletField prefilter hit + miss · detail-confirmed non-India discarded |
| freshness | `Posted Today` · `N Days Ago` · **`30+ Days Ago` never treated as 30** · missing date · `startDate` beyond 45d |
| detail fetch | 200 · 404 · timeout · malformed JSON · missing `jobPostingInfo` |
| reconciliation | empty → retires nothing · throw → retires nothing · partial → retires nothing · cross-source isolation |
| identity | tenant collision → ADR-11 STRONG · aggregator host never used |
| normalization | `NormalizedJob` shape valid for the ingest contract |

---

## 14. Rollout and rollback

```
1. backfill atsIdentifier -> tenant/dc/site for the 104   (data only, reversible)
2. ship adapter behind WORKDAY_ENABLED=false               (dead code, no effect)
3. enable for 3 pilot tenants, hand-triggered              (~900 jobs)
4. measure: new jobs · India % · fresh % · dup rate · gate pass rate · cost
5. if clean → add WORKDAY to CRAWLABLE_PROVIDERS           (scheduler picks it up)
6. re-run the source scorecard + dependency ratio
```

**Rollback:** remove `WORKDAY` from `CRAWLABLE_PROVIDERS` — companies stop
being handed out for crawling. No data is deleted; existing Workday jobs stay
ACTIVE and age out naturally. The backfilled identifier is harmless if unused.

**Success criterion is not job count.** It is:

```
FreeHire share of actionable opportunities:  76.7%  →  target < 50%
```

If Workday adds 7,000 jobs and FreeHire's share does not fall, the objective
was missed regardless of volume.
