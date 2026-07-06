# Architecture Review — before any further feature work

*2026-07-06. Requested by Suyash after Phase 5 core: "challenge the current design before
writing another line of code." Verdict and revised roadmap at the end. This document is the
basis for re-planning; VISION.md stays the product north star.*

## The verdict in one paragraph

The criticism is correct in its core: **the current system crawls companies we already know;
the product requires a system that finds companies we don't.** The architecture underneath is
sound — the contracts, queues, dedupe semantics, and two-stage matching all survive the bigger
vision unchanged — but one number exposes the real gap: of 96 companies in the database, **only
3 are actively monitorable** (the 3 seeded by hand). The 93 companies the flywheel discovered
from RemoteOK all have `atsProvider = UNKNOWN`, because RemoteOK's apply links are redirects,
not ATS URLs. Discovery without conversion-to-monitoring is just a contact list. The next phase
must be the **Company Discovery Engine** — not the dashboard, not more AI features.

## Honest answers to the audit questions

**1. What breaks at 100,000 companies?**

| Component | Breaks? | At what scale | Fix |
|---|---|---|---|
| Per-job upsert loop in ingest (2 queries/job) | Yes | ~10k companies/day | Batched upsert (single INSERT ... ON CONFLICT with unnest) — 50-100× fewer round trips |
| `ILIKE contains` job search (unindexed) | Yes | ~100k jobs | Postgres full-text (tsvector + GIN) — planned in original spec anyway |
| `crawl_runs` table growth | Yes | hourly × 100k companies = 2.4M rows/day | Retention policy (30-day detail, aggregates after) or monthly partitions |
| One BullMQ/Redis instance | No | fine to ~1k jobs/sec | Nothing until far beyond our needs |
| pgvector HNSW | No | fine to low millions of vectors | Nothing; revisit if >5M jobs |
| Workers→API HTTP ingest (single writer) | No | ~50 syncs/sec sustained | Nothing; queue smoothing already exists |
| AI processors inside API process | Eventually | when AI load affects API latency | Move to a dedicated worker process — planned split, one-day job |
| Full-regenerate matching per user | Yes | conceptually already | Event-driven incremental: match only NEW jobs against users after each crawl (the "notify within minutes" path) |
| Single machine, single IP crawling | Yes | ~10-20k requests/hour politely | Not a code problem: needs a VPS + proxy abstraction (already stubbed in Python service) when we scale past ~10k companies |

**2. What needs redesign?** Nothing structural. The layering (adapters → normalize → single
writer → Postgres; provider-agnostic LLM; queue-driven fan-out) is exactly what the bigger
system needs. This is refactor-and-extend, not rewrite.

**3. What should be refactored NOW before debt grows?**
- Batched job upsert (before adapter count grows the ingest volume).
- `nextCrawlAt`/`crawlTier` on Company + scheduler that queries "due now" — replaces the
  single 24h tick with tiered monitoring. Do this before adding 10 more adapters.
- Split AI processors out of the API process (cheap now, painful later).
- Full-text index on jobs.

**4. Microservices?** **No.** At one-developer scale, microservices multiply operational pain
without buying anything. We keep exactly three deployable units — API (+AI workers as a fourth
process later), Node crawl workers, Python scraper — as a modular monolith constellation.
LinkedIn-scale companies split services because of team boundaries, not because the code wants
it. Revisit only if this becomes a multi-person company.

**5. What should be cached?** Almost nothing yet (Postgres at 20MB laughs at our query load).
When the dashboard exists: company profiles and aggregate stats (Redis, TTL minutes). Never
cache embeddings/matches — they're already materialized in Postgres.

**6. Queue partitioning?** Per-tier queues (`crawl-hot`, `crawl-warm`, `crawl-cold`) with
distinct concurrency + rate limits, so 50k cold companies can never starve OpenAI's 15-minute
checks. BullMQ supports this natively — small change.

**7. Distributed crawlers?** BullMQ already gives us N workers on M machines for free (they
share Redis). The real constraint is IP reputation — solved with a cheap VPS + the proxy layer,
not with architecture.

**8. Incremental embeddings?** Already correct by accident of design: embeddings persist per
job and only missing ones get backfilled. Add: embed *at ingest time* for new jobs (small daily
trickle) instead of batch-at-match-time.

**9. Failure recovery?** Mostly there (retries+backoff, chunk persistence, CrawlRun logging,
non-fatal degradation). Missing: a dead-letter queue review path and alerting on repeated
company-level failures (fold into admin/dashboard phase).

**10. Monitoring?** CrawlRun table is the seed. Add per-source success-rate + jobs/day metrics
and a `/metrics` endpoint (Prometheus format) when we deploy — not before.

## Where I push back on the advice

- **"14,000 companies found in Bangalore → 6,200 career pages"** — Google Places is paid
  (~$25-32/1000 text-search requests after the free monthly credit) and returns *businesses*,
  not *software employers* — expect heavy noise filtering. City discovery is worth building,
  but it's a supplement. The highest-yield legal sources remain: ATS URL datasets (public
  GitHub datasets of tens of thousands of Greenhouse/Lever/Ashby tokens), YC directory,
  HN Who's Hiring, VC portfolio pages, GitHub orgs. Those are free and pre-filtered to tech.
- **"Check OpenAI every 15 minutes"** — polite and easy for ATS *APIs*; but tier assignment
  should be driven by *user signal* (companies you applied to / follow / high match density),
  not fame.
- **"Millions of jobs, 100k+ companies"** — the *architecture* will take it after the fixes
  above; the *laptop* won't. Realistic sequence: 1k monitored companies (free, this month) →
  10k (needs VPS ~$5-10/mo) → 100k (needs proxies + paid LLM budget). Scale is a budget
  decision, not a code decision.
- **Renaming** — fine idea, low stakes. "CareerOS" already reads as "Job Intelligence."
  If renaming, do it now before more history accumulates.

## What stays (validated by living through it)

Monorepo + shared contracts; NestJS single-writer ingest; adapter pattern (a new ATS = one
file); two-stage matching (this is exactly how you scale AI matching affordably); LLM provider
abstraction (already paid for itself during the Gemini quota fight); ToS red lines
(no LinkedIn/Indeed scraping, no auto-apply — assistant model instead).

## Revised roadmap (replaces phase numbering from here)

| # | Phase | Content |
|---|---|---|
| A | **Data Platform hardening** | Batched upsert; tiered scheduling (`crawlTier`, `nextCrawlAt`, per-tier queues); embed-at-ingest; full-text index; AI workers out of API process |
| B | **Company Discovery Engine v1** ← the heart | Career-page prober (given website/name → find careers URL → detect ATS → monitor); flywheel hardening (follow redirect apply links to real ATS); bulk seed from public ATS-token datasets + YC directory + HN Who's Hiring; adapters: Workday, SmartRecruiters, Recruitee, Teamtailor; target: **1,000+ monitored companies** |
| C | **Incremental match + notify** | New job → embed → match against user → notify (Telegram/email) within the crawl tier's latency. "Never miss an opportunity" becomes real here |
| D | **AI Recruiter features** | Tailored resume, cover letter, outreach drafts, interview prep, salary estimate (needs LLM budget decision) |
| E | **Referral engine v1** | Public-source people finding + outreach drafts + contact tracking (design doc first — legal lines matter) |
| F | **Dashboard** | Now it has something worth showing: discovery stats, hiring signals, application analytics |
| G | **Deploy** | VPS, Docker, CI/CD, monitoring — earlier if local crawling hits IP limits |

City-wise discovery (Places API) and the Hiring Signals Engine slot into B and F respectively
once their prerequisites (budget key; crawl history depth) exist.

## Decisions needed from Suyash

1. **Approve this roadmap reordering** (A → B → C before any dashboard work).
2. **Budget**: $0 is workable for A-C at ~1k companies. ~$5-20/mo (VPS + paid Gemini tier or
   OpenAI $5) unlocks 10k companies + fast bulk AI. Places API only when we want city sweeps.
3. **Rename or keep CareerOS** — if renaming, now.
