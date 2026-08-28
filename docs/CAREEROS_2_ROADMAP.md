# CareerOS 2.0 — Roadmap

> Adopted 2026-08-13. Supersedes `docs/ROADMAP.md` as the forward plan; that
> document remains the record of how v0.1–v0.3 were built.
>
> **North star:** maximize **interview probability ÷ user time**. Not job count.
> A feed of 20,000 irrelevant jobs is a failure. So is a curated list of one.

## The loop we are building

```
DISCOVER → VERIFY → DEDUP → UNDERSTAND → MATCH → RANK → DECIDE
   → TAILOR → FIND REFERRAL → GET SEEN → APPLY → TRACK → FOLLOW UP
   → INTERVIEW → PREPARE → OFFER → LEARN ↺
```

The moat is the last step. Anyone can scrape jobs; almost nobody has a dataset
of *which recommendations actually produced interviews for this person*.

## Standing principles

1. **UNKNOWN ≠ LOW.** Absence of evidence drops a scoring module and
   renormalizes. Only evidence of absence scores low.
2. **Never loosen the gate to inflate the dashboard.** Recall is raised *before*
   the gate, never by weakening it.
3. **Never invent resume content.** Rephrasing truthful experience is allowed;
   metrics, employers, titles, technologies, certifications are not.
4. **LinkedIn via email alerts only.** No scraping, stealth browsers, proxy
   rotation, or CAPTCHA evasion. ADR-8 already sanctions the email path.
5. **Static fetch → deterministic extractor → browser render → LLM last.**
   One pipeline. New sources normalize into `BoardJob`; they never fork it.
6. **Measure before asserting.** A claimed magnitude that was never computed is
   a guess wearing a number.

---

## PHASE 0 — Validate what exists  *(current)*

**Problem:** we keep discovering that measured behaviour differs from assumed
behaviour. Two real defects surfaced in one afternoon.

| Item | Status |
|---|---|
| Queue starvation (gate refusals never recorded) | ✅ fixed, 9 regression tests |
| RemoteOK ingesting non-jobs | ✅ fixed, 33 regression tests, 96% of feed rejected |
| Company aliases defeating fingerprint dedup | ✅ fixed, 18 regression tests |
| UNKNOWN ≠ LOW in `companyQuality` / `hiringVelocity` | ✅ fixed and verified |
| Full module audit against the invariant | ✅ done 2026-08-13 — see below |
| Evaluation-latency measurement | ✅ done — cap is NOT the bottleneck |
| Blind judging — 6,907 ACTIVE jobs with no description | ✅ fixed 2026-08-23 — `descriptionSource` + `INSUFFICIENT_EVIDENCE` guard |
| Description repair (5,270 recovered) + re-judge | ✅ measured 2026-08-23 — **0** of 223 escaped `NOT_DEVELOPMENT` |
| Embedding staleness (changed body kept a stale vector) | ✅ fixed 2026-08-23 — invariant + regression tests |
| Workers killed by one malformed HTTP response | ✅ fixed 2026-08-23 — 592-minute silent outage; process guard |
| Embedding sweeper / reconciliation | ✅ shipped 2026-08-23 — 30m tick, 30m grace window; verified live: found 7 stranded, re-enqueued, all embedded |
| Two competing Opportunity Scores | ✅ resolved — reconciled 2026-08-23 on all three surfaces |
| Baseline collector | ✅ shipped 2026-08-23 — `scripts/phase0-baseline.sql` + `CareerOS-Phase0-Baseline` task, daily 23:45, idempotent per day |
| Surfaceable-APPLY gap (cosine caps the pool) | ⬜ open — measured daily, NOT fixed; a matching-path change needs BEFORE/AFTER |
| Daily-cycle baseline (≥5 days) | ✅ **CLOSED 2026-08-28** — 5 clean days, 2026-08-24 → 08-28. Frozen below as the BEFORE |

#### Baseline start — recorded 2026-08-23 18:45 IST

Day 1 is **2026-08-24**. State at the start, so a later failure can be told
apart from a pre-existing one:

| Check | State |
|---|---|
| API | HTTP 200 |
| Workers | 1 process, 9 schedulers registered |
| Containers | postgres / redis / minio healthy (restarted ~15:45) |
| Stranded embeddings | 0 |
| ACTIVE jobs | 37,863 · decided 10,140 · 234 decisions still open |
| Backup | `careeros_2026-08-23_020004.dump`, 384.56 MB, 16.7 h old |
| Scheduled tasks | Backup / Watchdog / Phase0-Baseline — all last result 0 |

**2026-08-23 is excluded from the five days** and its row is kept as the
counter-example: `crawls_failed = 2,870` against 2,095 succeeded, from a
592-minute worker outage and three hours of failed ingestion. A baseline day
must not look like that.

Do not intervene to make a day green. A genuine failure is a result, not a
problem to be tidied away before it is recorded.

#### ✅ PHASE 0 CLOSED — the five-day baseline, frozen 2026-08-28

The BEFORE state. Every later change to discovery, evaluation or surfacing is
measured against this table, not against memory.

| day | new India | judged that day | APPLY | reachable | crawls ok | failed | stranded |
|---|---|---|---|---|---|---|---|
| 08-24 | 1,441 | — | 59 | 3 | 11,144 | 0 | 0 |
| 08-25 | 1,712 | 828 | 61 | 3 | 7,514 | 0 | 0 |
| 08-26 | 1,462 | 909 | 61 | 4 | 11,398 | 0 | 0 |
| 08-27 | 1,793 | 761 | 59 | 3 | 10,666 | 0 | 0 |
| 08-28 | 1,298 | 588 | 60 | 3 | 11,468 | 0 | 0 |
| **avg** | **1,541** | **~770** | **60** | **3.2** | | **0** | **0** |

**52,190 crawls, zero failures, zero stranded embeddings on every single day.**

The four questions, answered:

| | Answer |
|---|---|
| **Supply** | ~1,541 new India/remote jobs/day entering |
| **Evaluation** | ~770/day judged; candidate backlog **flat** (1,514 → 1,504). NOT a bottleneck |
| **Decision** | ~60 APPLY and ~290 CONSIDER standing |
| **Surface** | **3.2 of 60 reachable — 5.3%.** This is the hole |

**Known limitation, recorded rather than silently fixed:** `/today` can reach
about 5% of the APPLY decisions the engine produces, stable across all five
days. Cause and remedy are measured in Phase 1 item 0. It is NOT fixed inside
this baseline, so the BEFORE stays honest.

**The days were not quiet, and that is the stronger result.** The window
survived a reboot (13 min, Day 4), a suspend that stranded 71 embeddings (Day 5,
recovered automatically by the sweeper), and a 66-minute power loss (Day 5,
12:00 IST hour missing entirely). Nothing failed, nothing corrupted, nothing
needed a human. Days 1–3 showed the system runs; Days 4–5 showed it recovers.

**Instrumentation gap, for later:** the collector records failures and stranded
jobs, not *absence of operation*. Day 5's 66-minute hole is invisible in its
row — it was found by inspecting hourly crawl counts. Adding hours-with-zero-
crawls would close that.

### Module audit vs UNKNOWN ≠ LOW (2026-08-13)

Every module classified by how it treats missing evidence:

| Module | Missing-data behaviour | Verdict |
|---|---|---|
| `resumeFit` | always present (LLM output) | ✅ n/a |
| `experienceFit` | always present | ✅ n/a |
| `remotePreference` | guarded on prefs **and** `job.workMode` | ✅ drops out |
| `salaryPreference` | guarded on `minSalary` **and** `salaryMax` | ✅ drops out |
| `companyQuality` | drops out when `lastProbedAt IS NULL` | ✅ fixed |
| `hiringVelocity` | drops out when observation window < 14d | ✅ fixed |
| `cityPreference` | **boost-only, never penalises** | ✅ exemplary |
| `sourceReliability` | guarded on `sourceTrust != null`, weight 0 | ✅ drops out |
| `freshness` | `postedAt ?? firstSeenAt` — **unknown date scores 100** | ⚠️ latent |
| `skillGap` | `gaps === 0 → 100` conflates "none missing" with "not assessed" | ⚠️ minor |

**`freshness` is the mirror image of the bug we fixed:** absence of evidence is
scored as *best* rather than worst. A job posted 3 months ago but first seen
today scores maximally fresh. Blast radius today is **zero** — only 74 of 20,630
active jobs lack `postedAt` (68 `career-page-deterministic-v1`, 6 `hn-hiring`)
and **no current match uses the fallback**. But that extractor is 100% date-less
and grows as career-page crawling scales, so exposure grows with Phase 1. Fix
when it starts mattering, not before; recorded here so it is not rediscovered
by accident a third time.

### Evaluation latency (2026-08-13) — why the 60-cap was NOT raised

```
supply     15,730 new jobs/day (5,300 India)
evaluated     768 classified/day
backlog     1,638 relevant unevaluated (862 still fresh)
latency       3.3 h discovery → classified (worst 0.5 d)
```

Classification is fast and the backlog is ~2 days of capacity. Raising the
classification cap would spend money speeding up a stage that is not binding.

### Embedding backlog — measured, then CLOSED (2026-08-13, same evening)

The first reading said "embedding coverage 61%, 8,040 jobs invisible to
retrieval — this is the real constraint." **That framing was wrong** and is
corrected here rather than quietly deleted.

Four measurements settled it:

| Evidence | Reading |
|---|---|
| Coverage over ~40 min | 61% → 68.2% → 68.8%, still climbing |
| Coverage by ingestion day | **2026-08-12 cohort = 100.0%**; only today's = 57% |
| Discovery → embedded latency | **p50 0.32 h**, p95 11.09 h, worst 0.47 d |
| Queue depth | 113 waiting × 100 jobIds/batch = **11,300 slots ≥ 6,429 unembedded** |

There is no chronic bottleneck and nothing is stranded. A single crawl landed
**15,220 jobs between 06:00 and 07:00**; the embedder drains it at ~5,300/h
(one 100-id batch/min, `enqueueEmbeddings`, `ingest.service.ts:396`). Every
unembedded job was first seen *today*. Yesterday's cohort is fully covered.

**Correct statement:** *6,429 jobs have not yet entered the decision pipeline* —
not "8,040 missed opportunities". They are not equivalent, and 4,749 of them are
postings already older than 14 days (greenhouse avg 137 d, breezy 209 d), which
will mostly fail the freshness window anyway. How many mattered is knowable only
after they are embedded and judged.

**Action taken: none.** Per the pre-agreed decision rule — coverage climbing
toward 90% means the system is self-healing faster than intake, so worker
concurrency, batch size and provider limits are *not* touched. Re-run
`scripts/pipeline-health.sql` to re-check; do not re-litigate from a single
coverage percentage again.

#### ⛔ CORRECTED 2026-08-23 — "nothing is stranded" was wrong

> The paragraph above says *"There is no chronic bottleneck and nothing is
> stranded."* That is **false**, and it is corrected here rather than quietly
> deleted, per this file's own convention.

**What the 2026-08-13 analysis could not see.** It segmented coverage by
*ingestion day* and found yesterday's cohort at 100%. A cohort measurement
cannot distinguish a job that is **in flight** from one that is **permanently
stranded** — both look like "not embedded yet", and the stranded ones are
invisible the moment their cohort is no longer today's.

**Measured 2026-08-23:**

| Evidence | Reading |
|---|---|
| ACTIVE jobs with no vector | **1,673**, none of them in flight |
| Newly stranded during one repair episode | **79**, inside two hours |
| Embed batches failed and discarded | 10 (`job stalled more than allowable limit`) |
| Queue state while 79 sat stranded | `active:0 waiting:0 failed:0` — **clean** |

**Mechanism.** `enqueueEmbeddings` is the only producer and it runs once, at
ingest. Nothing sweeps behind it. Any id lost between ingest and embed is lost
permanently: the job stays ACTIVE, looks healthy in every count, and can never
be retrieved because the candidate query INNER JOINs `job_embeddings`. The
queue options set `removeOnFail: true`, so the failed batch — the only record
that those ids still needed embedding — was destroyed on the way out.

This is a **recurrence**. `cc1ccd8` repaired 1,780 stranded jobs on 2026-08-21
and concluded they were "a stranded remnant and not an ongoing leak". That
conclusion was wrong by the same reasoning error as above.

**Fixed:** the embedding invariant (a changed description clears its vector and
re-enqueues it), `repairDescriptions` now enqueues what it clears, and failures
are retained instead of discarded.

**Closed 2026-08-23.** A 30-minute sweep now re-enqueues ACTIVE jobs that are
vector-less past a 30-minute grace window — the grace window being the whole
point, since only age distinguishes *stranded* from *in flight*. Verified on
live data the same day: it found 7 jobs whose enqueue was lost during an API
crash, logged them at WARN, and all 7 embedded. `repair-embeddings.ts` remains
for bulk recovery but is no longer the only mechanism.

The invariant now holds: *every job requiring an embedding is eventually either
embedded or explicitly observable as failed — never silently stranded.*

### ⛔ The scoreboard — `fresh actionable opportunities/day` — **INVALIDATED 2026-08-14**

> **Do not quote this number.** It counts `job_matches.verdict='APPLY'`, but
> `/today` and `/browse` do not read `job_matches` — see *Two competing
> Opportunity Scores* below. It therefore measures a surface the user does not
> use. Retained as evidence; superseded once the two layers are unified.

Adopted 2026-08-13 as the single operational number. **Not** jobs discovered,
embedded, classified, sources added, or Opportunity Score. Those are stage
diagnostics; this is the product.

```
fresh actionable opportunity =
    ACTIVE  +  target geography  +  target role  +  ≤ target experience
           +  current classifier version  +  verdict = APPLY
           +  posted within 14 days
```

Then the chain that actually matters:

```
fresh APPLYs/day → applications/day → interviews/month → offers
```

`verdict='APPLY'` and `opportunityScore>=70` are reported as **separate
columns, never summed** — conflating them has inflated this figure three times.

**Baseline 2026-08-13:** 8 fresh actionable · 31 scored ≥70 · 20 CONSIDER.

Measured by `scripts/pipeline-health.sql`, which is the permanent operational
metric: stage coverage, discovery→embedded p50/p95, throughput vs intake,
backlog age, and the scoreboard.

### Two competing Opportunity Scores (discovered 2026-08-14) — **RESOLVED 2026-08-23**

Found while verifying that `/today` analytics actually recorded anything. It is
a product-integrity problem, not an analytics bug.

| | Surface score | Deep score |
|---|---|---|
| Code | `browseByFit` ([matching.service.ts:964]) | deep-scoring path |
| Drives | **`/today` + `/browse`** — what the user acts on | `job_matches` |
| Inputs | 7; `resumeFit` = raw cosine × 100 | 10 modules; LLM fit/experience/skillGap |
| Verdict | none | APPLY / CONSIDER / SKIP + `decisionVersion` |
| Persisted | **never** — recomputed per request | yes |

Measured divergence — top 12 of the live feed: **0 APPLY · 6 SKIP · 1 CONSIDER
· 5 never scored**, all live 69–72.

- `/today` #1 "Apply to jobgether — **Opportunity 72**" → **no stored match**
- `/today` #2 "Apply to XO Health — **Opportunity 71**" → stored **SKIP, 16.9**
- The 9 stored-APPLY jobs score **74.6–92.1**, all ACTIVE, fresh (0–14 d),
  embedded, passing the India filter, similarity 0.76–0.83 (only 27 jobs in the
  corpus beat the best one) — yet **7 of 9 are absent from the top-100 feed**;
  the 2 present rank #24 and #66 at live 68 and 66.

The `today.service.ts:99` comment says the surface path is deliberate — *"not
the sparse LLM verdicts"* — so this may be an unfinished architecture rather
than a bug: **Browse/Today = candidate discovery, `job_matches` = evaluated
recommendation.** The open question is which layer is canonical, and it is not
answered by picking whichever score looks better.

**Consequences.** The scoreboard above is invalidated. Impression events were
snapshotting only the *stored* decision, so a click on "Opportunity 72" recorded
`verdict=NULL` — five days of conversion data would have been confidently wrong.

**Done:** analytics now records `displayedScore`/`displayedVerdict` alongside
the stored pair, neither overwriting the other (migration
`20260814000000_opportunity_event_displayed_score`, 5 regression tests).

**Not done, deliberately:** nothing in discovery, retrieval, scoring, gating or
thresholds. The canonical-layer decision comes after a module-by-module audit of
why the two paths diverge.

**A likely resolution to design toward** (not yet agreed): the surface should
consume the canonical decision rather than invent a second score, while still
showing unevaluated jobs — as an explicit *state*, not a fabricated number.

```
Evaluated            Opportunity 89 · APPLY
Pending evaluation   Potential match · similarity high · evaluation pending
```

That preserves recall without implying an unscored job carries a trustworthy
score.

#### Reconciliation, 2026-08-23 — what cleared and what did not

The history above stands as written; the bug was real. Verified against the
live code and data before clearing the marker:

| Surface | Derives state from | Verified |
|---|---|---|
| `/browse` | `recommendationState(verdict, verdictCode, decidedAt)` + `byRecommendation` | ✅ |
| `/today` | the same, via `browseByFit`; unevaluated render as `POTENTIAL` with **no score** | ✅ |
| Telegram | stored `m.verdict IN ('APPLY','CONSIDER')` | ✅ |

`recommendationState` treats a verdict without `decidedAt` as undecided, maps
every gate-refusal code to REFUSED, and `browseByFit` drops REFUSED before
sorting. `opportunity` is `null` for POTENTIAL, never 0. So the original
violation — a refused job displayed as "Apply — Opportunity 71", and confident
numbers on jobs that were never judged — cannot recur. Also confirmed: §6 of
`recommendation-integrity.sql` (unnormalized country) returns 0 rows.

**A DIFFERENT defect was found while verifying this, and it is still open.**

`browseByFit` builds its pool with

```sql
ORDER BY (m."decidedAt" IS NOT NULL) DESC, je.vector <=> re.vector LIMIT 72
```

Evaluated jobs come first, which is the 2026-08-15 fix. But with 8,743 evaluated
jobs the pool fills entirely from them **ordered by cosine**, so similarity still
decides which APPLYs are *eligible to be displayed* — and similarity is not the
decision. Measured 2026-08-23 against the live corpus:

| | APPLY jobs | best opportunity | avg opportunity |
|---|---|---|---|
| inside `/today`'s pool (72) | **4** | 84.5 | 79.4 |
| outside it | **56** | **94.5** | 83.6 |

The best opportunity in the corpus cannot reach `/today`, and the jobs outside
the pool score *higher* on average than those inside. This is not the old
two-scores bug — nothing fabricates a score any more — it is a recall ceiling in
how the pool is built.

**Not fixed here, deliberately.** Changing pool construction is a change to the
matching path and must be measured BEFORE/AFTER like any scoring change. It is
now tracked instead: `phase0_daily_baseline` records `decided_apply` and
`surfaceable_apply` as separate columns every day.

**Therefore §5 of `pipeline-health.sql` is un-invalidated, with one condition:**
"fresh actionable opportunities/day" counts *decisions*, not what the user can
see. The two numbers must be reported side by side and never summed or
substituted — the same rule that already applies to `verdict='APPLY'` versus
`opportunityScore >= 70`.

**Success metric:** a stable daily funnel — new → India → SWE → stack → ≤3 YOE →
eligible → scored → APPLY → applied — measured across ≥5 consecutive days.

**Exit criteria:** we can state relevant-jobs/day with a real denominator, no
scoring module treats missing data as bad data, **and one canonical decision
layer drives every surface.**

[matching.service.ts:964]: ../apps/api/src/modules/matching/matching.service.ts

---

## PHASE 1 — Universal Discovery

**Problem:** supply is 70% Senior/Lead/Staff and US-startup-shaped. Junior
Indian roles live on channels we don't touch.

| Work | Why | Cost | Risk |
|---|---|---|---|
| **`ADZUNA_APP_ID`** | one missing credential unlocks India aggregation | 2 min | none |
| **Gmail connector (OAuth)** | the single biggest missing channel | high | token handling |
| **LinkedIn job-alert parser** | ADR-8's sanctioned path; where junior India roles are | med | none if email-only |
| Naukri / Indeed alert parsers | same mechanism, more supply | low after Gmail | none |
| Darwinbox / Zoho Recruit / freshteam | `ROADMAP.md:44` estimates ~2× India supply | med | none (public boards) |
| RSS / sitemap / JSON-LD ingestion | Google documents `JobPosting` structured data | low | none |
| `DiscoverySource` plugin contract | stop each source touching the core | med | refactor risk |

### Verified status — 2026-08-23

Checked against the code, not reconstructed from conversation.

| # | Item | Status |
|---|---|---|
| 1 | `ADZUNA_APP_ID` | 🔴 **credential only** — adapter `adzuna.ts` + spec exist; `APP_ID` is a 2-char placeholder, `APP_KEY` is real |
| 2 | Gmail connector (OAuth) | 🔴 not built — 0 files |
| 3 | LinkedIn job-alert parser | 🔴 not built |
| 4 | Naukri / Indeed alert parsers | 🔴 not built |
| 5 | Darwinbox / Zoho Recruit / freshteam | ⚫ Darwinbox **blocked** (ADR-8 + TLS-fingerprint WAF, investigation closed); Zoho/freshteam unevaluated |
| 6 | RSS / sitemap / JSON-LD ingestion | 🟡 partial — JSON-LD parsed inside `breezy.ts` only; no `rss.ts`, no `sitemap.ts` |
| 7 | `DiscoverySource` plugin contract | 🔴 not built |
| **0** | **Surface recall + age fairness** | ✅ **CLOSED 2026-08-29** — Q2 shipped (APPLY 3→47); Q1 measured, fresh-first retained |
| **8** | **Classification-cost optimization** | 🟡 **NEW 2026-08-28 — before scaling supply, see below** |

Also shipped under item 5: **Workday** — `CRAWLABLE_PROVIDERS` 8 → 9, plus a
registry-integrity test asserting `ADAPTERS === CRAWLABLE_PROVIDERS` (an adapter
had shipped enabled nowhere for two days).

**Why more raw ATS volume is not progress** — actionable rate per source,
measured 2026-08-23:

| Source | ACTIVE | Actionable | Rate |
|---|---|---|---|
| jooble | 94 | 12 | **12.8%** |
| freehire | 1,854 | 200 | **10.8%** |
| workday | 4,966 | 46 | 0.93% |
| greenhouse | 11,846 | 7 | **0.06%** |
| ashby | 4,220 | 5 | 0.12% |

Greenhouse carries 6× freehire's volume and yields 3.5% of its actionable jobs.
Of all judged jobs, `NOT_DEVELOPMENT` is 51.0% and `TARGET_ROLE_TOO_SENIOR` is
24.2% — about half of everything that *is* a development role is too senior.
That is this phase's problem statement, measured. The gate is not the lever:
loosening it is already in *Deliberately rejected*.

**Company universe / city seeding is background infrastructure, not a phase
item.** The persistent Bengaluru universe stays — companies survive with zero
jobs so a future opening is caught — but it is not the next feature. Company
targeting cannot move either dominant loss bucket: a well-chosen company posting
only senior roles still yields nothing, and the `NOT_DEVELOPMENT` half was
re-judged on full descriptions and stayed refused.

### Sequencing — decided 2026-08-28, before Day 5 closed

**Two tracks, kept separate.** Adding sources and reaching what we already found
are different problems, and conflating them is how a pipeline ends up looking
powerful while the user sees less:

```
DISCOVERY  sources -> ingestion -> classification -> eligibility -> judging
           (gets us MORE good jobs)

POLICY     freshness priority · age starvation · candidate selection ·
           surface recall · LLM cost
           (makes sure the good jobs we ALREADY found reach the user)
```

Right now the hole is in the second track: `/today` is discarding 56 of 59 APPLY
decisions before ranking. Adding a source would not move that number by one.

The original list is unchanged; the ORDER is. Two bottlenecks showed up in the
baseline itself, and adding supply on top of either would make the product look
more capable while making opportunities harder to reach.

```
Day 5 closes -> review the 5 days
  -> 0. evaluation throughput + surface recall   <- NEW, first
  -> 8. classification-cost optimization         <- NEW, before scaling
  -> 1. Adzuna -> 2. Gmail -> 3. LinkedIn -> 4. Naukri/Indeed -> ...
```

**Why not Adzuna first.** Measured across Days 1-4: intake is **2,000-2,500 new
jobs/day** against **700-900 evaluated/day**, so the unevaluated pool grows every
day. And of ~60 APPLY decisions, **3-4 reach `/today`** — about 5%. Another
source multiplies the numerator of a funnel whose two narrowest points are
already downstream of ingestion.

The goal is not to collect the most jobs. It is to reach the good ones before
they go stale.

### 0. Surface recall + age fairness — NEW, do first

**Measured 2026-08-28 (read-only, during Day 5). This section replaces an
earlier claim in this file that "intake outruns evaluation" — that was wrong,
and the correction is the useful part.**

#### The wrong diagnosis, and why

It compared RAW intake (2,000–2,500 jobs/day) against evaluation (700–900/day)
and concluded the pool was growing. But only ~32% of intake is ever eligible:

```
ACTIVE         39,909
embedded       39,909   100%  (the sweeper is holding)
India/remote   18,542
fresh <=45d    12,859
sim >= 0.45    12,859   <- MIN_SIMILARITY filters NOTHING. Do not tune it.
undecided       1,514   <- the actual backlog
```

Eligible inflow is **~770/day** against **760–920/day judged**. Judging capacity
is healthy and the backlog is NOT growing. Comparing a funnel's top to its
bottom is how you invent a bottleneck that isn't there.

#### The real finding: age starvation

The 1,514 undecided are not a fresh buffer:

| tier | age | undecided | share |
|---|---|---|---|
| 0 | 0–7d — judged first | 332 | 21.9% |
| 1 | 8–14d | 265 | 17.5% |
| 2 | 15–30d | 538 | 35.5% |
| 3 | 31–45d — **expires unjudged** | 379 | 25.0% |

Tier-0 inflow alone (~770/day) consumes essentially the whole belt, so tiers 1–3
are starved and **379 jobs will reach the 45-day cutoff having never been
judged**. This is the fresh-first ordering working exactly as designed; the side
effect was simply never measured.

**This is a POLICY question, not a capacity bug**, and it is deliberately left
open: should CareerOS ever judge a 30-day-old Indian backend role, or is that
genuinely stale? Decide it AFTER the surface fix below, with numbers rather than
instinct. Do not "fix" it by raising the cap — capacity is not the constraint.

#### ✅ Q1 CLOSED 2026-08-29 — fresh-first RETAINED, on evidence

Measured read-only before any code was considered. Age genuinely predicts worse
outcomes, among jobs that were actually judged:

| age when judged | judged | APPLY | actionable % |
|---|---|---|---|
| 0–7d | 9,109 | **59** | **3.05%** |
| 8–14d | 2,056 | 9 | 2.63% |
| 15–30d | 2,466 | 8 | 1.62% |
| 31–45d | 1,289 | **0** | **1.16%** |

**Zero APPLY from 1,289 jobs judged at 31–45 days.** Every current APPLY came
from the 0–7d bucket. Not a sampling artifact: those judgements are spread over
many days (142, 69, 32, 459, …) and every one of them returned 0 APPLY.

Similarity is **identical across tiers (0.737)**, so this is not a retrieval
effect — old jobs look just as relevant and judge far worse.

Counterfactual policies, all net losses:

| policy | actionable gained | fresh actionable lost | net |
|---|---|---|---|
| **A — current fresh-first** | — | — | **baseline** |
| B — reserve 10% for 31–45d | +0.89/day | −2.35/day | −1.46/day, −0.5 APPLY |
| C — reserve 20% | +1.79/day | −4.70/day | −2.91/day, −1.0 APPLY |
| D — aging boost | — | — | strictly worse than A |

Letting the 365 currently-expiring jobs age out costs ~4 CONSIDER and 0 APPLY.
Even at the statistical upper bound (rule of three on 0/1,289 → ≤0.23%), those
365 would yield **less than one APPLY**.

**Fresh-first is no longer a convenient default; it is evidence-supported.**
Reserving capacity would directly reduce *relevant new jobs/day*, which is the
roadmap's own success metric.

**Recorded caveat, not blocking:** the belt's inspection/throughput accounting is
not fully reconciled — reconcile logs show ~100 inspected per tick across ~144
ticks/day, which does not obviously square with ~770 judged/day. Most
inspections are free gate refusals, but the exact accounting was not traced.
This does NOT affect the analysis above, which rests on observed yield RATES
rather than absolute capacity. **Do not attempt to raise throughput until that
accounting is understood** — it would be tuning something not yet measured.

#### The immediate win: candidate selection is ordered by the wrong thing

`browseByFit` builds its pool with `ORDER BY (decidedAt IS NOT NULL) DESC,
cosine LIMIT 72`. So similarity decides which decisions are ELIGIBLE TO BE SEEN,
and similarity is not the decision. Measured against the live corpus:

| pool construction | APPLY | CONSIDER |
|---|---|---|
| **A — current: cosine, LIMIT 72** | **3** | 20 |
| **B — opportunityScore, LIMIT 72** | **47** | 25 |
| C — cosine, LIMIT 200 | 9 | 40 |
| D — total available | 59 | 286 |

**One ORDER BY clause takes APPLY from 3 to 47 at the same pool size and the
same cost.** Enlarging the pool to 200 only reaches 9, so the problem is
ordering, not size — throwing capacity at it barely helps.

Sharpest statement of the loss: `/today` renders the top 2 APPLY cards. It
currently picks the best of **3** when it should pick the best of **59** — which
is why the corpus's best job (opportunity 94.5) cannot appear while an 84.5
does.

**This changes SELECTION, not JUDGMENT.** No scoring module, threshold,
eligibility rule or verdict cutoff is touched. Required before it ships:
BEFORE/AFTER (the table above is the BEFORE), affected jobs, verdict changes
(expected: none), and a regression test pinning selection-by-decision so it
cannot silently revert to cosine.

### Delhi NCR probe — LIVE experiment, registered 2026-08-29 BEFORE any result

**Pre-registered so the interpretation cannot be chosen after seeing the
numbers.** 100 companies drawn deterministically from the 463-company
delhistartupmap extraction (salt `delhi-probe-2026-08-29`, checksum
`5131e169af17e0f1`), frozen in `_delhi_sample100`. 94 inserted as new, 4 already
existed by domain, 2 skipped because their NAME matched an existing company
under a different domain — inserting those would have split one company's jobs
across two rows, the alias-dedup failure already on record.

Population: **98 bound companies**, `discoverySource='delhistartupmap'`,
`city='Delhi NCR'` (the source is NCR-scoped; city is re-derived downstream from
the postings themselves). They are the only never-probed DISCOVERED companies,
and `probeDue` orders `lastProbedAt NULLS FIRST`, so the existing 10-minute
fanout drains them without intervention. No LLM cost — probing is HTTP.

**Report the WHOLE funnel, not just the last number:**

| stage | Bengaluru | Delhi NCR |
|---|---|---|
| companies | 736 | 98 |
| career page found | 468 (64%) | ? |
| ATS identified | 736 | ? |
| MONITORED | 92 (12.5%) | ? |
| jobs discovered | — | ? |
| India/remote · SWE · ≤3 YOE | — | ? |
| APPLY | — | ? |
| **actionable/company** | **0.167** | **?** |

Because "2 actionable" means opposite things depending on where it narrows:

```
98 -> 10 career pages -> 2 monitored -> 2 jobs -> 2 actionable
   the UNIVERSE is small; more Delhi companies would not help

98 -> 70 career pages -> 40 monitored -> 2,000 jobs -> 2 actionable
   the universe is fine; DOWNSTREAM TARGETING is the problem
```

Those lead to different next moves, so the funnel is the deliverable.

**Decision rule, fixed in advance.** This is a GO/NO-GO SCREEN, not an estimate:
0–2 actionable is strong evidence against expanding to the remaining 363; 20+ is
strong evidence for; anything between is **inconclusive** and must be reported
as such rather than argued either way. n=100 cannot resolve 8 vs 12.

**Hold while it runs.** Do not add the other 363, enable Adzuna, build the title
pre-filter, or touch discovery, scoring or freshness policy until this reports.
Changing the system mid-experiment is how a controlled result becomes an
anecdote.

### Google Places is NOT a substitute for a curated city map — measured 2026-08-29

Recorded so this is not re-proposed. Places was tried as a licensing-clean
replacement for startup-map seeding (it returns name + website + location under
a paid Google API, so no per-site terms review). **It does not work**, for a
reason no amount of key configuration fixes.

Places ranks **Maps business listings by local-SEO relevance**, not by being a
real tech employer. Running this file's own query templates against Hyderabad:

```
"tech startup in Hyderabad"       Rational Technologies · Access Info Sources ·
                                  NowFloats · T-Hub Phase 2 · Deeploop
"SaaS company in Hyderabad"       ONE result: "SaaS SoftPro Leaders Pvt. Ltd."
"software product company in …"   mTouch Labs · Conquerors · Accellor · Softpal
```

Of ~30 results across four queries, **2** appeared in a 263-company curated list
of the same city. Places surfaced none of Darwinbox, HighRadius, Skyroot,
NxtWave, Keka, Zenoti, Zomato or Zuddl — the actual engineering employers —
while returning firms with "Best Software Company in Hyderabad" in their trading
name. A company that does not need Maps SEO does not rank on Maps.

**The curation is the value.** This is the Bengaluru lesson one level up: more
companies is not more relevant companies, and Places would have supplied
hundreds of small IT-services shops at real classification cost.

`PLACES_API_KEY` is deliberately left EMPTY; `places-city-discovery` skips
silently without it, so the weekly sweep cannot fire. Do not wire it back in
expecting a company universe.

(The legacy Places API also returns no `website` field — it needs a second Place
Details call per result — so the fallback is worse, not just older.)

### 8. Classification-cost optimization — NEW, before scaling supply

**Not urgent, and recorded so it is not rediscovered.** The `$8/day` budget cap
is NOT binding (actual: $5.26-$5.86/day), and credit runs to 2026-11-25. This
becomes the constraint only once Adzuna/Gmail/Naukri multiply intake.

**Correcting an earlier claim in this file's own spirit:** the eligibility gate
is *deterministic and free* — a refusal costs no LLM call, verified live
(`recorded 2 gate refusals as decided SKIPs`, zero AI calls). The cost sits one
step EARLIER, in classification, which must run on every job before the gate can
use its output:

```
new job -> LLM CLASSIFICATION (paid) -> eligibility gate (free) -> verdict
```

Measured 2026-08-27, 805 classifications:

| primaryFunction | jobs | share |
|---|---|---|
| SOFTWARE_ENGINEERING | 186 | **23.1%** |
| everything else (OTHER, Sales, Support, PM, Design, QA, Data...) | 619 | **76.9%** |

So ~77% of LLM spend establishes that a job was never software engineering.

**a. Batch utilization — lowest risk, do first.** `CLASSIFY_BATCH = 5` but the
measured average is **1.54 jobs per call**, because jobs arrive in dribs and
batches never fill. The fixed prompt overhead is therefore paid ~3x more often
than necessary. Buffer arrivals up to a bounded wait, then classify. No quality
risk, no recall risk.

**b. Deterministic title pre-filter — biggest lever, must be EARNED.** Only for
titles proven safe to exclude. The danger is not the obvious cases:

```
almost certainly NOT SWE     Sales Executive · Recruiter · HR Manager ·
                             Accountant · Customer Success · Graphic Designer

MUST STILL GO TO THE LLM     QA Engineer · DevOps · SRE · Data Engineer ·
                             ML Engineer · Solutions Engineer ·
                             Security Engineer · Technical Consultant ·
                             Platform Engineer
```

That second row is where a naive blacklist destroys recall, and CareerOS has not
yet decided how it treats those roles for this profile.

**c. Shadow mode is mandatory.** The filter must run alongside the LLM without
suppressing anything until measured:

```
prefilter NO + LLM NO    -> safe agreement
prefilter NO + LLM YES   -> FALSE NEGATIVE, a silently lost opportunity
```

The second number must be **zero** on a large held-out sample before the rule is
allowed to skip a single call. This is the same failure class as the 6,907
blind-judged jobs and the 1,673 stranded embeddings: cheap to cause, invisible
once caused.

**d. REJECTED: shrinking `JD_CHARS` (6,000).** Saving tokens by sending less of
the description recreates the blind-judging bug this phase exists to close. Do
not save money by making the classifier blind. Save it by not asking questions
answerable without the LLM.

**Every source must emit provenance:** `source`, `sourceType`, `sourceUrl`,
`retrievedAt`, `publishedAt`, `lastSeenAt`, `extractorVersion`, `confidence`,
`externalId`.

**Success metric:** **junior-role share** and **relevant new jobs/day**, not
total jobs. A source that adds 5,000 senior US roles has failed.

---

## PHASE 2 — Career Truth Graph + Resume Intelligence

**Problem:** tailoring without provenance eventually fabricates. The Quality
Gate is deterministic but has no evidence graph behind it.

- Structured master profile: experience → project → technology → responsibility
  → outcome → metric → **evidence**
- Every generated resume bullet references a claim ID that resolves to evidence
- JD → resume diff with per-skill coverage
- Resume variants generated from one truth source (never 20 hand-maintained files)
- Application-answer generation showing *which evidence was used*

**Success metric:** 100% of generated bullets trace to a verifiable claim; zero
fabricated metrics in audit.

---

## PHASE 3 — Get Seen

Referral/recruiter discovery already exists. Extend to contact ranking, outreach
drafting, follow-up tracking. **Draft and assist — the user sends.** No spam, no
impersonation.

**Success metric:** referral-assisted application → interview rate vs cold
application → interview rate, measured on real outcomes.

---

## PHASE 4 — Application OS

`Job → prepare → review → apply → track → confirm`, with **human confirmation
before every submission**. No auto-apply. Ever.

---

## PHASE 5 — Interview OS

Triggered when an application reaches INTERVIEW: company briefing, JD skill map,
technical/DSA/system-design/behavioural prep, STAR stories, weak-area tracking.

**Do not build before the application funnel produces enough interviews to
justify it** — but design the data model now so it plugs in.

---

## PHASE 6 — Learning OS

Market skill demand → user's gaps → prioritized learning plan. Recommendations
derive from *the user's actual target jobs*, never generic trends.

---

## PHASE 7 — Personal Career Intelligence

`OpportunityEvent` already logs shown/clicked/dismissed/applied. Accumulate
until the dataset supports: source → interview rate, referral → interview rate,
freshness → interview rate, resume variant → interview rate.

Then the score stops predicting *fit* and starts predicting:

> "If you spend 25 minutes applying to this today, how likely is an interview?"

**Do not auto-retrain early.** Collect first.

---

## PHASE 8 — Business

**Not before CareerOS demonstrably helps Suyash get interviews.** No billing, no
multi-tenancy, no admin panel until then. The moat is outcome intelligence, not
scraping volume.

---

## Deliberately rejected (with reasons)

| Idea | Why not |
|---|---|
| Classify all 4,120 jobs (~$78) | measured: bands beyond rank 100 are 0% stack-relevant |
| Multi-lane retrieval | the failure it guards against does not appear in this corpus |
| Freshness re-ranking in retrieval | fresh jobs spread evenly across bands; would surface fresh *irrelevant* jobs |
| LinkedIn scraping | ToS; brittle; ADR-8 red line |
| Crawl4AI now | renderer boundary already exists; benchmark before adopting |
| Loosening the seniority gate | destroys the product's reason to exist |
