# CareerOS — Discovery & Scraping Strategy

> Written 2026-08-13 after reviewing 25 external repositories.
> Companion to `docs/CAREEROS_2_ROADMAP.md`. Read `CLAUDE.md` first.

## The problem this document solves

Measured 2026-08-13: of **105 classified software-engineering jobs**, only **2
were JUNIOR**. 70% were Senior/Lead/Staff/Principal. The dominant gate rejection
is `TARGET_ROLE_TOO_SENIOR`.

The cause is source composition, not code. India supply arrives from
greenhouse 136 / lever 83 / jooble 59 / ashby 32 / keka 6 / workable 5 — all
YC-style startup ATS boards, which skew senior and US-centric. **Junior Indian
roles live on channels CareerOS does not touch.**

Every source below is judged on one metric: **relevant new jobs/day for a
2-YOE Node/React developer targeting India**. Not total jobs.

## The four ingestion channels

```
1. OFFICIAL APIs / ATS FEEDS   ← strongest, have 8, missing 3
2. AGGREGATOR APIs             ← have 1 of 3 working
3. CAREER PAGES                ← have extractor + renderer tier
4. EMAIL (job alerts)          ← NOT IMPLEMENTED — biggest gap
```

Everything normalizes into `BoardJob` and flows through the one spine. A new
source is an adapter, never a new pipeline.

---

## Channel 1 — Official APIs / ATS feeds

| Adapter | State |
|---|---|
| Greenhouse · Lever · Ashby · Workable · SmartRecruiters · Recruitee · Breezy | ✅ shipped |
| Keka (Indian ATS) | ✅ shipped |
| **Darwinbox · Zoho Recruit · freshteam** | 🔴 **never built** |

`docs/ROADMAP.md:44` estimates the three missing Indian ATS adapters would
**~double Indian supply**. Same pattern as the existing Lever/Workable adapters —
public career boards, no ToS question.

**Priority: P1.** Cheap, safe, on-target.

---

## Channel 2 — Aggregator APIs

| Source | State | Note |
|---|---|---|
| Jooble | ✅ working | 91 India dev jobs/run; 500-request default quota |
| **Adzuna** | 🔴 **`ADZUNA_APP_ID` missing** | Key present, ID absent. Two-minute fix. |
| Google Places (company discovery) | 🔴 `PLACES_API_KEY` unset | Powers city-based company discovery |
| **freehire.me** | 🆕 **candidate — P0** | Public API aggregating **~50 ATS platforms** |

**freehire.me is the highest-value unexplored source.** Found in
`MadsLorentzen/ai-job-search`. If its India coverage is real, it may substitute
for building three ATS adapters by hand. **Test volume before building anything.**

---

## Channel 3 — Career pages

Already built and working:

```
static fetch → deterministic extractor → validate → snapshot (replayable)
   → if JS-only → renderer tier (services/renderer, Playwright) → same extractor
```

Plus: cross-source fingerprint dedup, source trust, adaptive crawl frequency,
extraction telemetry, replay queue.

**What's missing: drift detection.** When a company redesigns its careers page,
the extractor silently returns zero — indistinguishable from a company that
stopped hiring.

**Candidate fix — adaptive selector relocation** (idea from `D4Vinci/Scrapling`,
installed in `apps/scraper/.venv`): fingerprint each extracted element (tag,
attributes, position, siblings, text) into SQLite; when a selector returns
nothing, score candidate nodes by similarity and relocate. CareerOS already
stores `extraction_snapshots`, so the raw material exists.

**Implement in TypeScript inside the existing extractor** — do not bolt a Python
dependency onto the Node crawl path.

### Renderer engine — benchmark before switching

`firecrawl` and `crawl4ai` both fit behind the existing renderer HTTP contract.
Do not adopt on reputation. Measure: precision · recall · jobs/page · latency ·
RAM · CPU · failure rate · JS-success rate · cost.

**Only run this benchmark when JS-only career pages are a measured gap.**

---

## Channel 4 — Email (NOT IMPLEMENTED)

There is **zero email ingestion** in the codebase. This is the largest missing
channel and the one ADR-8 explicitly sanctions:

> *"No LinkedIn/Indeed scraping ever (**their alert emails** + the fact that
> postings originate on ATS boards cover the gap)"*

Parsing the user's own inbox is not scraping LinkedIn. Target architecture:

```
LinkedIn / Naukri / Indeed / recruiter job alerts
   → Gmail (OAuth, never a password)
   → email classifier
   → extract: title, company, location, URL, posted-at
   → BoardJob → fingerprint dedup → embed → match → Opportunity Score
```

Second prize, equally valuable: the same inbox carries **outcomes** —
application confirmations, rejections, interview invitations, assessments. That
closes the feedback loop Phase 7 depends on.

**Priority: P0 for supply, and strategically the most important build.**

---

## The LinkedIn question — needs an explicit decision

`MadsLorentzen/ai-job-search` uses LinkedIn's **public guest endpoints**:

```
https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search
https://www.linkedin.com/jobs-guest/jobs/api/jobPosting
```

No authentication, no cookies, no browser, no CAPTCHA solving, no proxies.
Honest UA, exponential backoff with jitter on 429/5xx.

This is materially different from what ADR-8 was written against — but it is
**still automated access to LinkedIn**, which their User Agreement prohibits
regardless of whether auth is required.

**Three options, all legitimate. Pick one deliberately:**

1. **Keep ADR-8 as written** → build email ingestion. Slower, zero risk.
2. **Amend ADR-8** to distinguish public guest endpoints from authenticated
   scraping. A documented decision, not a quiet drift.
3. **Take freehire.me only** → ~50 ATS platforms, no LinkedIn question at all.

Do not implement the guest endpoints under another name without amending ADR-8.

---

## Repository verdicts

| Repo | Score | Verdict | What we take |
|---|---|---|---|
| **MadsLorentzen/ai-job-search** | 9/10 | **P0** | freehire.me source; LinkedIn guest endpoints (pending ADR-8) |
| **garrytan/gstack** | 7/10 | ✅ installed | Engineering workflow: `/investigate` `/review` `/qa` `/ship` `/careful` |
| **firecrawl** | 7/10 | P1 | Renderer-tier benchmark candidate |
| **D4Vinci/Scrapling** | 7/10 | ✅ installed (base) | Adaptive selector relocation **concept**. `[fetchers]` extra REJECTED — TLS impersonation / fingerprint spoofing |
| **crawl4ai** | 6/10 | P1 | Benchmark against firecrawl |
| **gosom/google-maps-scraper** | 5/10 | P2 | Superseded — set `PLACES_API_KEY` instead |
| **ScrapeGraphAI/Scrapegraph-ai** | 3/10 | REJECT as engine | Violates tier order (LLM-last). Classification costs $0.019/job |
| **eracle/OpenOutreach** | 3/10 | P2 reference | CareerOS's referral/outreach module is ahead of it |
| **itshoax/career-ops-extension** | 2/10 | **REJECT** | Drives logged-in LinkedIn session + auto-fills Easy Apply. Breaks ADR-8 **and** the no-auto-apply rule |

Not scraping-related, reviewed and unused: `agent-zero` (framework-locked
skills), `PixelRAG`, `TencentDB-Agent-Memory` (4th/5th memory systems),
`open-pencil`, `graphify`, `meetily`, `VoxCPM` (speech model), `jcode`,
`repowise`, `agentmemory`, `strix`.

---

## Execution order

```
1. ADZUNA_APP_ID              two minutes, free, India aggregation
2. freehire.me volume test    may replace 3 hand-built adapters
3. ADR-8 decision             before any LinkedIn code exists
4. Gmail + job-alert parser   the real unlock, and it captures outcomes too
5. Darwinbox / Zoho / freshteam   only if freehire.me doesn't cover them
6. Adaptive selector relocation   stop silent extractor rot
7. Renderer benchmark         only when JS pages are a measured gap
```

**Success metric throughout: junior-role share and relevant new jobs/day.**
A source adding 5,000 senior US roles has failed.
