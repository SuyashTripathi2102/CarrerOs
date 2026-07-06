# Phase 4 — Job Discovery Engine

Goal: a reliable river of real, deduplicated, correctly-linked jobs flowing into the database
every 24 hours. Everything later (matching, resume tailoring, interview prep) feeds off this.
Not a job portal — a personal intelligence pipeline.

## Sources

### Tier 1 — official JSON APIs (Node workers, no scraping needed)

| Source | Endpoint pattern | Notes |
|---|---|---|
| Greenhouse | `boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` | thousands of startups/scaleups |
| Lever | `api.lever.co/v0/postings/{site}?mode=json` | |
| Ashby | `api.ashbyhq.com/posting-api/job-board/{name}` | OpenAI, Ramp, Linear... |
| RemoteOK | `remoteok.com/api` | public API, remote jobs, reveals companies |
| We Work Remotely | RSS feeds | |
| Amazon | `amazon.jobs/en/search.json` | big-tech direct |

### Tier 2 — public but needs scraping (Python service, robots.txt respected)

- YC Work at a Startup, Hacker News "Who's Hiring" (Algolia API — actually Tier 1),
  Wellfound (anti-bot: best effort, back off when blocked), Google Careers,
  Workday-hosted boards (JSON endpoints exist per-tenant but are fiddly).

### Explicitly out: LinkedIn / Indeed scrapers

Both prohibit scraping; ~90% of their postings are aggregated copies whose originals live on
company ATS boards we crawl directly. The gap (Easy-Apply-only postings) gets covered later by
parsing LinkedIn's/Indeed's own **job-alert emails** sent to the user's inbox — user's own data,
via a channel the platforms built for that purpose.

## Company discovery — four channels

The core question: how do we know *which* companies to crawl?

1. **Discovery flywheel (primary, automatic).** Every job ingested from any aggregate board
   (RemoteOK, HN, YC) names a company → auto-create the Company row → detect its ATS from the
   job's apply URL → from then on that company's board is crawled directly, forever. The system
   discovers companies the way a recruiter does: by seeing who is actually hiring.
2. **Seed lists (bootstrap).** Known ATS tokens for target companies (curated JSON committed in
   repo + one-call bulk endpoint). Public GitHub datasets of Greenhouse/Lever tokens exist.
3. **Manual add (instant).** `POST /companies` with any career-page URL — ATS auto-detected from
   URL patterns (`boards.greenhouse.io/X`, `jobs.lever.co/X`, `jobs.ashbyhq.com/X`...).
4. **City-based discovery (supplement, later).** "All software companies in Indore/Pune/
   Bangalore" via Google Places API (needs API key) → website → career-page probe. Kept as a
   *supplement* because city directories are noisy (non-tech businesses) and miss remote-first
   companies entirely — the flywheel catches those. Indian-company caveat: many use
   Darwinbox/Zoho Recruit/custom portals — needs dedicated adapters (backlog).

## Sync semantics (per company, per run)

- Upsert by `(companyId, externalId)` — recrawl updates, never duplicates.
- Jobs present in the fetch: bump `lastSeenAt`, status `ACTIVE`.
- Jobs in DB but missing from fetch: mark `REMOVED` (never delete — history + "position filled"
  signal for the application tracker).
- Every run writes a `CrawlRun` row (found/new/removed counts, error) — admin observability.
- Failures: BullMQ retry with exponential backoff; a failing company never blocks others.

## Data-quality features (from product discussion 2026-07-06)

- **Freshness priority**: postedAt/firstSeenAt drive "apply now" ranking — applying within
  24–48h of posting measurably raises response rates.
- **Ghost-job detection** (backlog): 90+ day postings / endless reposts get deprioritized.
- **Removed-job signal**: job you applied to disappears → surfaced in tracker.
- **Salary**: stored when the source provides it; estimation for missing salaries is a Phase 5
  AI feature (comparable jobs in DB + LLM estimate labeled as estimate with confidence).
- **Skill-demand analytics, per-job interview prep, recruiter/referral messaging, per-job resume
  tailoring**: Phase 5 — they consume this pipeline's output.

## Architecture

```
API (NestJS)                          Workers (Node)                 Redis/BullMQ
  POST /crawl/trigger ──enqueue──►  refresh-all (repeatable 24h)
  GET  /internal/companies/due ◄──  crawl-company × N (concurrency 5)
  POST /internal/companies/:id/jobs/sync ◄── normalized jobs batch
  POST /internal/boards/ingest  ◄──  crawl-board (RemoteOK...) — flywheel entry
```

Workers never touch Postgres — they fetch + normalize, then POST to token-guarded internal
endpoints (`x-internal-token`). The API owns all writes, dedupe, and CrawlRun accounting.
The internal token is a shared secret in both `.env` files (`INTERNAL_API_TOKEN`).
