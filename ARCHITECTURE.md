# JobIntel — Architecture (Phase 1)

AI-powered job search & career intelligence platform. This document covers the system design
decided in Phase 1. Nothing here implements business logic yet — that starts in Phase 2 (Database)
and Phase 3 (Backend).

## 1. Service map

```
                                   ┌─────────────────┐
                                   │   apps/web       │  Next.js (App Router)
                                   │   Dashboard, UI   │  TypeScript, Tailwind, Shadcn
                                   └────────┬─────────┘
                                            │ REST (JSON)
                                            ▼
                                   ┌─────────────────┐
                     ┌─────────── │   apps/api        │  NestJS
                     │             │   Auth, domain    │  Prisma ORM, class-validator
                     │             │   logic, REST API │  Owns the DB schema — single
                     │             └────────┬─────────┘  source of truth for writes
                     │                      │
                     │           enqueues jobs via BullMQ
                     │                      │
                     ▼                      ▼
          ┌────────────────────┐  ┌──────────────────────┐
          │  PostgreSQL         │  │   Redis                │
          │  + pgvector          │  │   (BullMQ queues)       │
          └────────────────────┘  └──────────┬───────────┘
                                              │
                        ┌─────────────────────┼─────────────────────┐
                        ▼                                           ▼
             ┌─────────────────────┐                     ┌──────────────────────┐
             │  apps/workers         │                     │  apps/scraper          │
             │  Node + BullMQ         │                     │  Python (FastAPI +     │
             │  - Greenhouse/Lever/   │                     │   Playwright)           │
             │    Ashby JSON APIs     │                     │  - JS-heavy career      │
             │  - orchestration,      │                     │    pages, anti-bot      │
             │    scheduling          │                     │    targets              │
             └─────────────────────┘                     └──────────────────────┘
                        │                                           │
                        └──────────────► apps/api internal API ◄────┘
                               (both write back through NestJS/Prisma,
                                never directly to Postgres)

          ┌────────────────────┐
          │  MinIO (S3-compat)   │  Resume file storage
          └────────────────────┘
```

## 2. Why this stack

**Next.js over plain React (apps/web).** Same mental model as React — components, hooks — plus
file-based routing, layouts, and API routes built in. Low learning cost coming from a React
background, and it's what most companies mean today when they say "React role," which matters
for a portfolio piece.

**NestJS over plain Express (apps/api).** This is the deliberate trade: NestJS costs real ramp-up
time (modules, dependency injection, decorators) versus staying in Express. But the project's
explicit goal is to demonstrate Clean Architecture / DDD / SOLID — and NestJS enforces those
boundaries structurally (modules, providers, guards) instead of relying on developer discipline to
maintain them by hand as the codebase grows across auth, crawlers, matching, notifications, and
admin. For a project meant to *show* architecture ability, "designed with NestJS's DI/module
system" is a stronger artifact than "organized Express folders carefully."

**PostgreSQL + pgvector over MongoDB (data layer).** Resume-to-job matching needs embedding
similarity search. Postgres + pgvector keeps relational data (users, applications, companies) and
vector search in one database — one thing to run, one ORM (Prisma), no second vector store to
operate. MongoDB Atlas Vector Search is an alternative but ties you to Atlas specifically and is a
less mature vector-search story than pgvector.

**BullMQ + Redis for orchestration.** Standard Node job-queue choice: retries, backoff, rate
limiting, delayed/repeatable jobs (the "every 24 hours" crawl requirement), and a dashboard
(Bull Board) for observability almost for free.

**A separate Python service for hard-to-scrape targets (apps/scraper).** Node can call
Greenhouse/Lever/Ashby's public JSON APIs directly — that's just HTTP, no scraping needed. But
JS-rendered career pages, anti-bot pages, and messy HTML fallback parsing are better served by
Python's ecosystem (Playwright-stealth, Scrapy, BeautifulSoup) than anything comparable in Node.
The Python service consumes jobs from the *same* Redis instance via the `bullmq` PyPI package,
which speaks the identical wire protocol as the Node `bullmq` package — so `apps/workers` can
enqueue a job once and either a Node or Python worker can pick it up, without a bespoke bridge.

Scraper results are written back through `apps/api`'s internal HTTP API, not directly to Postgres.
Prisma/NestJS stays the single owner of the schema; letting a second service (SQLAlchemy or raw
psycopg2) write to the same tables independently is how schemas drift out of sync over time.

**npm workspaces + Turborepo over a polyrepo.** One repo, one CI pipeline, and `packages/shared`
keeps cross-cutting types (enums, DTOs) from drifting between `apps/web` and `apps/api` — worth it
for a solo-maintained project; polyrepo overhead (versioning a shared package across repos,
multiple CI configs) only pays off at team scale.

## 3. Repo layout

```
JobIntel/
  apps/
    web/          Next.js frontend
    api/           NestJS backend (owns Prisma schema + DB writes)
    workers/       Node BullMQ processors — orchestration + easy-API crawlers
    scraper/       Python FastAPI + Playwright — hard-to-scrape targets
  packages/
    shared/        Cross-cutting Zod schemas/types, imported by web + api
  docker-compose.yml   Local infra only: Postgres+pgvector, Redis, MinIO
                        (app services run natively via `npm run dev` / venv —
                        containerizing them is a Phase 8 concern)
```

Inside `apps/api/src`, domain logic is organized as one NestJS module per feature
(`modules/auth`, `modules/resumes`, `modules/jobs`, ...), each layered
controller → service → repository, added as its phase starts. See
`apps/api/src/modules/README.md`.

## 4. Scope call for Phase 1: MVP-first

The full feature spec covers ~15 domains (auth, resume AI, multi-ATS crawling, matching, referral
intel, interview prep, dashboard, admin panel, notifications...). Building all of it before
anything runs would mean months with nothing demoable. Sequencing instead:

1. **Now — Phase 1 (this doc):** architecture + scaffolding, nothing functional yet.
2. **Phase 2:** database schema (users, resumes, companies, jobs, applications, embeddings).
3. **Phase 3:** backend — auth, resume upload/parsing, core REST API.
4. **Phase 4:** crawler — Greenhouse/Lever/Ashby (public JSON APIs, no ToS risk) first; Workday
   and custom career pages (via the Python scraper) after those are working end-to-end.
5. **Phase 5:** AI matching engine (embeddings, match scoring).
6. **Phase 6:** dashboard.
7. **Phase 7:** testing.
8. **Phase 8:** deployment (this is also where app services get Dockerized).

Deliberately deferred past MVP: **direct LinkedIn/Indeed scraping** (both explicitly prohibit
scraping in their ToS — building against them isn't something I'll implement; if this project
needs those sources later, the honest options are their official (limited) partner APIs, or
manually-entered job links), and **referral contact discovery** beyond publicly listed
recruiter/TA contact info. Both are called out again when their phases come up.

## 5. Local dev prerequisites

- Node.js 22+, npm
- Python 3.10+
- Docker Desktop (for Postgres/Redis/MinIO — not installed in this environment; install it
  yourself and run `npm run docker:up` before starting `apps/api`)

## 6. Status

**Phase 2 (Database) complete — 2026-07-06.** Schema at `apps/api/prisma/schema.prisma`:
17 models (identity, resumes+versions+embeddings, canonical skills, companies/jobs, matching,
application tracking, notifications, crawl observability). Two migrations applied against live
Postgres 17 + pgvector 0.8.4: `init` (Prisma-generated) and `add_hnsw_vector_indexes`
(hand-written SQL — Prisma's DSL can't express pgvector HNSW indexes; note this pattern for any
future vector-index change). API verified booting against the live DB. Local infra (Docker
Desktop + WSL2) installed and `docker compose up -d` verified healthy.

Awaiting approval to proceed to **Phase 3: Backend (auth, resume upload/parsing, core API)**.

Phase 1 scaffolding is complete and verified:
- `apps/web` — Next.js app builds.
- `apps/api` — NestJS app builds, boots, and serves `GET /api/health`; correctly imports
  `@jobintel/shared`; correctly fails fast with a clear error when Postgres isn't reachable
  (expected — Docker isn't available in this sandbox, verify locally with `npm run docker:up`).
- `apps/workers` — type-checks clean, BullMQ wiring against the exact `ioredis` version BullMQ
  itself depends on (avoids a duplicate-package type conflict).
- `apps/scraper` — Python venv installs clean; all modules import without error.
- `packages/shared` — builds to real JS/d.ts, correctly consumed by both `apps/api` (verified at
  runtime) and available to `apps/web`.

Awaiting approval to proceed to **Phase 2: Database schema design**.
