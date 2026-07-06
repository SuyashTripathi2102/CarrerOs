# CareerOS

AI-powered job search & career intelligence platform — automatically discovers jobs across
company career pages and ATS systems, matches them against your resume, and tracks applications.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full system design, tech-stack rationale, and
phase roadmap. Built in phases (Architecture → Database → Backend → Crawler → AI → Dashboard →
Testing → Deployment); each phase is reviewed before the next starts. Currently: **Phase 1 done,
awaiting approval for Phase 2**.

## Prerequisites

- Node.js 22+
- Python 3.10+
- Docker Desktop (for local Postgres/Redis/MinIO)

## Setup

```bash
npm install

# start local infra (Postgres+pgvector, Redis, MinIO)
npm run docker:up

# build the shared package once before running api/web
npm run build --workspace=@careeros/shared

# api
cd apps/api && cp .env.example .env && npx prisma generate && npm run start:dev

# web
cd apps/web && npm run dev

# workers
cd apps/workers && cp .env.example .env && npm run dev

# scraper (Python)
cd apps/scraper
python -m venv .venv
./.venv/Scripts/activate   # or source .venv/bin/activate on macOS/Linux
pip install -r requirements.txt
cp .env.example .env
python -m app.worker        # BullMQ consumer
uvicorn app.main:app --reload --port 8000   # health/ops endpoints
```

## Monorepo layout

| Path | What |
|---|---|
| `apps/web` | Next.js frontend |
| `apps/api` | NestJS backend — owns the Prisma schema and all DB writes |
| `apps/workers` | Node BullMQ processors — orchestration + Greenhouse/Lever/Ashby JSON-API crawlers |
| `apps/scraper` | Python FastAPI + Playwright — JS-heavy/anti-bot career pages |
| `packages/shared` | Cross-cutting Zod schemas/types shared by `web` and `api` |
