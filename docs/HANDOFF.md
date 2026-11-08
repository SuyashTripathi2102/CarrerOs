# CareerOS handoff

For Claude Code picking this project up on a new laptop or after a long break. Written
2026-11-08. Everything here is a snapshot: confirm it against the running system before relying
on it. This repo is public: no secrets or private job-search notes belong in this file.

## Read in this order

1. `CLAUDE.md`: the engineering rules. Loaded automatically.
2. This file: where things stand.
3. `docs/CAREEROS_2_ROADMAP.md`: the live plan and every measured result, newest at the bottom.
4. `docs/DECISIONS.md`: the ADRs. Read before structural changes.
5. `docs/CAREEROS_ULTIMATE_VISION.md`: read before proposing a major feature.

`docs/ROADMAP.md`, `docs/PROJECT_LOG.md` and the README's numbers date from August or earlier.
Use them as history only.

## What this is

CareerOS is Suyash's personal AI recruiter. It finds companies, watches their career pages, scores
new jobs against the resume with reasons, and sends Telegram alerts. The goal is more interviews
and offers for less of Suyash's time, not more jobs on a screen.

```
Discovery -> BoardJob -> validate -> dedup -> ingest -> embed -> vector retrieval
  -> role classification / eligibility gate -> deep scoring -> Opportunity Score
  -> Browse / Today / Telegram -> application / outreach -> outcome events -> analytics
```

| Part | Where | Tech |
|---|---|---|
| API (owns the schema, runs AI processors) | `apps/api` | NestJS, Prisma |
| Workers (crawl, discovery, schedules) | `apps/workers` | Node, BullMQ |
| Web | `apps/web` | Next.js |
| Scraper | `apps/scraper` | Python 3.12 |
| Renderer | `services/renderer` | Playwright |
| Infrastructure | `docker-compose.yml` | Postgres 17 + pgvector, Redis, MinIO |

## State on 2026-11-08

- **Branch:** `foundation/attribution-and-outcomes`. All current work is here. Local `main` was 66
  commits behind `origin/main`, so do not assume `main` is the working line.
- **Product code last changed 2026-09-10.** Later work was resume editing and this laptop move.
- **The stack was off from 2026-09-22 to 2026-11-08.** Nothing was crawled or scored for about 47
  days, so the corpus is stale and every daily backup in that window failed.
- **Database:** about 2.4 GB live, 918 MB as a dump, fresh on 2026-11-08.
- **This laptop is the production host.** Closing the lid suspends everything. That is a known
  limitation, not a bug (roadmap, "Incident 2026-09-10").

## Where the work stopped

The newest roadmap entries are the source of truth. In short:

- **Telegram Applied button:** shipped 2026-09-10 to close the outcome loop. The period measuring
  it had only just started. Do not change power settings or hosting casually while measuring it.
- **Evidence Refresh experiment:** closed and parked. The next step before any scheduler is to
  sample the 241 `INSUFFICIENT_EVIDENCE` jobs stratified by source (lever, breezy, workday,
  freehire; 20-30 each). Do not hydrate all 241.
- **Phase 1 order:** classification-cost optimization, then Adzuna, Gmail, LinkedIn alerts,
  Naukri/Indeed alerts. `apps/api/src/modules/gmail` already has OAuth, crypto and sync logic, so
  the roadmap's 2026-08-23 "not built" table is out of date. Check the code.
- **Known recall limit:** `browseByFit` builds its pool by cosine similarity, so some APPLY
  decisions cannot reach `/today`. Changing it needs BEFORE/AFTER measurement.

## First session on a new laptop

Do these before starting new work, and report what you find.

1. Confirm the import printed `IMPORT VERIFIED`. If it did not, see `docs/NEW_MACHINE_SETUP.md`.
2. Confirm CareerOS is stopped on the old laptop. Two copies mean duplicate Telegram messages and
   double AI spend.
3. Run `scripts/ensure-stack.ps1`, then `curl http://localhost:3001/api/health`.
4. Check that Vertex still works before trusting the pipeline. The GCP credit was due to expire
   2026-10-07 and a move to another account was planned. Billing failure stops embedding AND
   judging, and it fails quietly.
5. Expect a burst on first start. After 47 days every board looks new, so crawling, embedding and
   judging will spike. Watch AI spend. A surge is expected; do not diagnose it as a defect.
6. If a stage looks silent, establish blast radius first: check ingest, crawl, worker and
   evaluation activity plus host uptime before examining one queue.
7. Run `scripts/backup.ps1` and confirm a new dump appears. Check the file, not the task state.
8. Telegram's webhook needs a public URL. How the old laptop exposed one is not recorded in the
   repo, so ask Suyash and register a new URL with `setWebhook` if the button is in use.

## Machine traps

| Trap | Rule |
|---|---|
| npm 11.16+ silently skips Prisma, bcrypt and sharp postinstalls | Install with `npx --yes npm@11.12.1 ci` |
| Python 3.14 cannot build `pydantic-core` | Use 3.12 for `apps/scraper` |
| `.env` is read once at boot; `tsx watch` does not watch it | Fully restart after credential changes |
| Stopping a shell can leave node children consuming jobs | Check `Win32_Process`, kill survivors |
| PowerShell pipes corrupt binary dumps | Dump inside the container, then `docker cp` |
| PowerShell 5.1 strips `"` from `docker exec psql -c` arguments | Pipe SQL over stdin |
| `pg_restore` before migrations, never after | Restore into an empty DB, then `migrate deploy` |
| `GEMINI_EMBEDDING_MODEL` must stay `gemini-embedding-001` | Another model silently corrupts similarity |

## Where the context lives

| What | Where | Note |
|---|---|---|
| Project memory, 34 notes | `~/.claude/projects/<path-slug>/memory/` | Many date from August. `MEMORY.md` marks some SUPERSEDED. Verify before citing. |
| Session history | `~/.claude/projects/<path-slug>/*.jsonl` | Restored by the import |
| Searchable past work | `~/.claude-mem/claude-mem.db` | Needs the claude-mem plugin; use its `mem-search` skill |
| Skills, 96 | `~/.claude/skills/` | Restored without builds. Run `gstack`'s `setup` before using it. |
| Global tool list | `~/.claude/INSTALLED_TOOLS.md` | Install commands for each CLI |

Not transferred, so re-authorize: Claude login, GitHub credentials, Claude connectors, and OneDrive.

## Working with Suyash

Suyash writes short, informal messages. Answer in plain English, lead with the result, and say
exactly what to do next. Cost is not a constraint on decisions (stated 2026-08-21), but Vertex
remains a single point of failure. Commit or push only when asked.
