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
| Daily-cycle baseline (≥5 days) | ⬜ **the remaining gate** |

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

### 🚨 Two competing Opportunity Scores (discovered 2026-08-14) — **BLOCKS the baseline**

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
