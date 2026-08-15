# Architecture Decision Records

Major choices, why they were made, and what would change them. Newest last.
(Interview-prep note: each of these is a conversation, not a bullet point.)

## ADR-1: Modular monolith, not microservices

**Decision:** Three deployable units — Next.js frontend, NestJS API (owns Prisma/schema, runs
AI queue processors), Node crawl workers (+ Python scraper as a satellite for hard targets).

**Why:** One developer. Microservices trade code-boundary problems for operational problems
(deploys, service discovery, distributed tracing, versioned contracts) — a bad trade until team
boundaries force it. NestJS modules + the internal-API seam give the same logical separation.
**Would change if:** multiple people own different domains, or AI processing load starts
starving API latency (then: split AI processors into a 4th process — one-day job, seam exists).

## ADR-2: Single-writer ingest (workers never touch Postgres)

**Decision:** Crawlers/scraper POST normalized data to token-guarded internal API endpoints;
only the API (Prisma) writes to the database.

**Why:** One schema owner = no drift between Node and Python data access; dedupe/validation/
accounting logic lives in exactly one place; workers stay stateless and horizontally scalable.
**Cost:** an HTTP hop per sync (negligible at our volume, batched anyway).

## ADR-3: BullMQ + Redis for all orchestration

**Decision:** Every background operation is a queue job (crawl fan-out, per-company crawls,
board ingest, discovery probes, seeds, embeddings, matching, intelligence derivation).

**Why:** Retries with backoff, concurrency control, repeatable schedulers, and cross-language
consumers (Python `bullmq` speaks the same Redis protocol) — all for free. Learned the hard
way (see PROJECT_LOG): static jobIds dedupe concurrent runs, but finished jobs must be removed
(`removeOnComplete/Fail: true`) or re-adds are silently ignored and schedules become no-ops.

## ADR-4: Postgres + pgvector for everything (no separate vector DB)

**Decision:** Relational data and embeddings in one Postgres; HNSW indexes via hand-written
migrations (Prisma can't express them — nor generated columns: `@default(dbgenerated())` +
`@@index(type: Gin)` keep its diff engine from fighting hand-managed SQL).

**Why:** One database to run/backup; similarity search joins directly against business tables
(match = one SQL query). A dedicated vector DB adds sync complexity for zero benefit below
millions of vectors.

## ADR-5: Two-stage matching (vector prefilter → LLM deep scoring)

**Decision:** pgvector cosine similarity ranks ALL jobs cheaply; only the top ~15 get LLM
scoring, in batched calls.

**Why:** LLM-scoring every user×job pair is economically impossible and unnecessary — the
embedding space already knows a Bangalore backend dev shouldn't be scored against a Boston
nurse posting. Cost scales with matches, not corpus size.

## ADR-6: Discovery lifecycle + Confidence Score

**Decision:** Companies move DISCOVERED → WEBSITE_VERIFIED → CAREER_PAGE_FOUND → MONITORED
(or UNRESOLVABLE with monthly retry), carrying a 0-100 confidence from weighted signals
(websiteVerified 15, careerPageFound 20, atsDetected 25, jobsExtracted 25, monitoringHealthy 15).

**Why:** The success metric is *conversion to monitored*, not discovery count — a company we
can't monitor is a contact-list entry. Confidence signals debug the funnel: the SmartRecruiters
false-positive incident surfaced precisely as "atsDetected=true, jobsExtracted=false" rows.
**Key sub-decision:** ATS probes must validate *response shape* per provider (SmartRecruiters
200s with `totalFound:0` for any slug; Breezy 302s on unknown tenants), never just HTTP status.

## ADR-7: Tiered crawling, not uniform refresh

**Decision:** `crawlTier` (HOT 30m / WARM 4h / COLD 24h) + `nextCrawlAt` per company; a 15-min
scheduler fans out only due companies; failures back off 1h; tier bumps after every sync.

**Why:** "Notify within minutes" is only affordable for companies that matter (applied-to,
followed, high match density); the long tail needs daily at most. Uniform frequency either
starves the head or hammers the tail.

## ADR-8: ToS red lines

**Decision:** No LinkedIn/Indeed scraping ever (their alert emails + the fact that postings
originate on ATS boards cover the gap); no auto-apply (assistant model: prepare everything,
human reviews and submits); robots.txt respected; UA identifies the crawler honestly.

**Why:** Legal/ethical floor, and product quality — blast-applying lowers callback rates, and
a portfolio project centered on ToS violations is a negative signal, not a feature.

## ADR-9: Company intelligence derives from our own corpus first

**Decision:** Tech stack, remote/visa/junior-friendliness, experience profile, role mix, salary
medians, hiring velocity — all computed from jobs we already crawled (LLM extraction + SQL),
not from scraping Glassdoor/Crunchbase/etc.

**Why:** Free, legal, always fresh, and surprisingly complete — a company's job postings ARE
its hiring profile. External sources (funding, ratings) come later as links/references only.

## ADR-11: Company identity — names propose, ATS tenancy confirms (ACCEPTED, 2026-08-15)

**Status:** accepted 2026-08-15. FreeHire pagination is blocked on this being implemented —
scaling discovery before identity is protected would fragment company intelligence at a scale
that cannot be retrofitted.

**Context.** Fingerprint dedup keys on `companyId`, so a company that exists under two
names becomes two companies and its jobs, hiring velocity, referrals and outcomes split
between them. Measured in the live corpus:

```
key            variants  jobs  detail
paytm                 2   246  Paytm [LEVER:paytm] | PAYTM SERVICES PVT LTD [WORKABLE:...]
zensar                2    22  Zensar | Zensar Technologies          (11 / 11 split)
fefundinfo            2    15  fe-fundinfo | FE fundinfo
jpmorganchase         2    14  JP Morgan Chase | JPMorganChase        (7 / 7 split)
hexaware              2     4  HEXAWARE | Hexaware Technologies       (2 / 2 split)
nordson               2     3  Nordson | Nordson Corporation
danaher               2     3  Danaher | Danaher Corporation
```

7 groups, 307 jobs. Projected onto a paginated FreeHire (2,703-job sample): **33 groups,
530 jobs — 20%**. The even splits (Zensar 11/11, JPMorganChase 7/7) are the damaging ones:
they halve every company-level signal.

**Decision.**

1. **Normalized name PROPOSES a match; it never merges on its own.** Normalization tiers,
   measured against the FreeHire sample:

   ```
   T1  case + punctuation            19 groups   no risk
   T2  + legal (Inc/LLC/Corp/Ltd)    24 groups   no risk
   T3  + geo (India)                 25 groups   judgement (DoorDash India = DoorDash?)
   T4  + industry (Technologies…)    33 groups   unsafe on name alone
   ```

2. **The apply-URL tenant is the confirming signal — not the stored ATS columns.**
   `companies.atsIdentifier` is derived from the name (`zensar` vs `zensar-technologies`),
   so it fragments identically and confirms nothing. `companies.atsProvider` is also
   unreliable: HEXAWARE is stored as `WORKABLE` while its jobs serve from
   `fa-etqo-saasfaprod1.fa.ocs.oraclecloud.com`. The job URL is the ground truth.

   ```
   Zensar               fa-etvl-saasfaprod1.fa.ocs.oraclecloud.com  ┐ same tenant
   Zensar Technologies  fa-etvl-saasfaprod1.fa.ocs.oraclecloud.com  ┘ → STRONG
   ```

3. **Confidence hierarchy. Only STRONG may auto-merge.**

   ```
   STRONG   compatible normalized name + SAME first-party ATS tenant   → auto-merge
   MEDIUM   same canonical website domain                              → review
   WEAK     normalized name only                                       → review
   UNKNOWN  no reliable identity evidence                              → review
   ```

4. **Aggregator hosts are never company identity.** `echojobs.io`, `remoteOK.com`,
   `himalayas.app`, `jobstash`, `whatjobs`, `telegram` and similar carry jobs for arbitrary
   companies. An explicit denylist is required; without it a URL rule collapses every
   company an aggregator touches into one. Multi-tenant ATS hosts
   (`job-boards.greenhouse.io`, `jobs.lever.co`, `jobs.smartrecruiters.com`) are identity
   only when combined with their **path token** (`jobs.lever.co/paytm`), never by host.

5. **A differing tenant is NOT evidence of distinctness.** Originally proposed as such;
   the Paytm row disproves it — `Paytm` serves from `jobs.lever.co/paytm` while
   `PAYTM SERVICES PVT LTD` came via `remoteOK.com`. Companies also legitimately run more
   than one ATS. Differing tenants therefore yield UNKNOWN → review, never an auto-split
   and never an auto-merge.

6. **Non-destructive.** A `company_aliases` table points variants at a canonical
   `companyId`. Existing `jobs.companyId` foreign keys are never rewritten by inference;
   resolution happens through the alias table.

7. **Ambiguity goes to review, never to a guess.** Under-merging costs a duplicate row.
   Over-merging silently fuses two companies' funding, hiring velocity, contacts and
   outcomes — invisible, and unrecoverable once downstream signals are computed.

**Backfill (first pass, evidence-confirmed only).** `Zensar`/`Zensar Technologies` and
`HEXAWARE`/`Hexaware Technologies` — both STRONG, same Oracle tenant. Everything else in
the table above goes to review: `Paytm` (aggregator host on one side), `JPMorganChase` and
`fe-fundinfo` (one side has no ATS evidence), `Nordson` and `Danaher` (no tenancy on
either side). `Motorola Solutions` exists in the corpus with no duplicate — nothing to merge.

**Tests must protect the dangerous cases.** `Apple` ≠ `Apple Bank`; a shared
`job-boards.greenhouse.io` host must not merge; an aggregator host must never confer
identity; same tenant + compatible name merges; differing tenants go to review, not split;
absent tenancy goes to review.

**Why:** the Company Intelligence Graph (ADR-9) computes hiring velocity, role mix and
referral paths per company. Every one of those is wrong if a company is two rows — or, far
worse, if two companies are one. This ADR fixes the identity layer *before* FreeHire
pagination multiplies the corpus, because retrofitting identity after signals are computed
means recomputing everything downstream.

## ADR-10: Opportunity Score will be modular scorers, not one formula (Phase C)

**Decision (planned):** Independent scorer modules (resume fit, experience match, freshness,
remote/salary preference fit, company quality, hiring velocity, skill gap), each returning
score + reason, combined by configurable weights. Notifications carry the per-module reasons
("92% resume match · posted 14 min ago · remote · docker missing").

**Why:** Each factor evolves independently (velocity needs history; company quality needs B.5
data); per-module reasons make notifications actionable; weights become *tunable from outcome
data* once Application Analytics exists (which resume/scoring emphasis actually yields
interviews — the Resume Version Intelligence feedback loop).
