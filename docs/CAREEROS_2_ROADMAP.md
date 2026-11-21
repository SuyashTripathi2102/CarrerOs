# CareerOS 2.0 — Roadmap

> Adopted 2026-08-13. Supersedes `docs/ROADMAP.md` as the forward plan; that document remains the record of
> how v0.1–v0.3 were built.
>
> This is the public version: product direction, principles and decisions. Detailed measurements,
> experiment logs and operational history are kept in the maintainer's private notes.
>
> **North star:** maximize **interview probability ÷ user time**. Not job count. A feed of 20,000 irrelevant
> jobs is a failure. So is a curated list of one.

## The loop we are building

```
DISCOVER → VERIFY → DEDUP → UNDERSTAND → MATCH → RANK → DECIDE
   → TAILOR → FIND REFERRAL → GET SEEN → APPLY → TRACK → FOLLOW UP
   → INTERVIEW → PREPARE → OFFER → LEARN ↺
```

The moat is the last step. Anyone can scrape jobs; almost nobody has a dataset of *which recommendations
actually produced interviews for this person*.

## Standing principles

1. **UNKNOWN ≠ LOW.** Absence of evidence drops a scoring module and renormalizes. Only evidence of absence
   scores low.
2. **Never loosen the gate to inflate the dashboard.** Recall is raised *before* the gate, never by
   weakening it.
3. **Never invent resume content.** Rephrasing truthful experience is allowed; metrics, employers, titles,
   technologies and certifications are not.
4. **LinkedIn via email alerts only.** No scraping, stealth browsers, proxy rotation or CAPTCHA evasion.
   ADR-8 sanctions the email path.
5. **Static fetch → deterministic extractor → browser render → LLM last.** One pipeline. New sources
   normalize into `BoardJob`; they never fork it.
6. **Measure before asserting.** A claimed magnitude that was never computed is a guess wearing a number.

## Phases at a glance

| Phase | Goal | Status |
|---|---|---|
| 0. Validate what exists | prove measured behaviour matches assumed behaviour before adding anything | closed 2026-08-28 after a five-day clean baseline |
| 1. Universal discovery | reach the channels where relevant roles actually live | in progress |
| 2. Career Truth Graph | every generated claim traces to evidence | planned |
| 3. Get seen | referrals and outreach the user sends | planned |
| 4. Application OS | prepare, review, apply, track, with human confirmation | planned |
| 5. Interview OS | preparation triggered by real interviews | planned |
| 6. Learning OS | skill gaps from the user's actual target jobs | planned |
| 7. Personal career intelligence | learn which strategies produce interviews | collecting data |
| 8. Business | only after CareerOS demonstrably works for its first user | not started |

---

## PHASE 0 — Validate what exists (closed 2026-08-28)

**Problem:** measured behaviour kept differing from assumed behaviour.

Phase 0 fixed what that found and froze a five-day baseline, which every later change is measured against.
- Decisions that were computed but never stored, so they kept being recomputed.
- Non-job pages ingested as jobs.
- Company aliases defeating duplicate detection.
- Unknown signals scored as low.
- Jobs judged without a description.
- Stale embeddings.
- A worker crash on malformed input.
- Two competing scores reconciled into one canonical verdict.

**Open from Phase 0:** some APPLY decisions cannot reach the Today view, because its candidate pool is built
by similarity. Changing that is a matching-path change, so it needs a before/after measurement.

## PHASE 1 — Universal Discovery (in progress)

**Problem:** supply from startup ATS boards skews senior and US-centric. Junior Indian roles live on
channels CareerOS did not touch.

| Work | Why | Status |
|---|---|---|
| Surface recall and age fairness | good jobs already found must reach the user | done |
| Workday adapter | first-party access to a major ATS | done |
| FreeHire aggregator | broad multi-ATS coverage | done |
| Source registry and source-health monitoring | notice when a source silently stops; measure dependence | specified |
| Classification-cost optimization | keep LLM cost proportional before scaling supply | parked: the measured levers (a title pre-filter, batching) were not worth it |
| Gmail connector (OAuth, read-only) and LinkedIn alert parser | the sanctioned route to LinkedIn and portal roles | partly built |
| Naukri, Indeed and other portal alert parsers | same mechanism, more supply | planned |
| Adzuna | aggregator API | inactive by choice |
| RSS / sitemap / JSON-LD ingestion | Google documents `JobPosting` structured data | partial |
| `DiscoverySource` plugin contract | stop each source touching the core | planned |
| Darwinbox | not pursued: access would require bypassing bot protection, which CareerOS never does | closed |

**Sequencing principle: two tracks, kept separate.**

```
DISCOVERY  sources -> ingestion -> classification -> eligibility -> judging
           (gets us MORE good jobs)

POLICY     freshness priority · age starvation · candidate selection ·
           surface recall · LLM cost
           (makes sure the good jobs we ALREADY found reach the user)
```

Adding a source multiplies the top of a funnel. If the narrowest points are downstream, the product looks
more capable while the user sees less. The goal is not to collect the most jobs; it is to reach the good ones
before they go stale.

**Why more raw ATS volume is not progress:** sources differ by orders of magnitude in how many of their jobs
are relevant, so sources are judged by relevant new jobs per day, never by volume. The persistent city company
universe is background infrastructure, not a phase item. Company targeting cannot fix a supply that is mostly
senior or non-development.

---

## PHASE 2 — Career Truth Graph + Resume Intelligence

**Problem:** tailoring without provenance eventually fabricates. The Quality Gate is deterministic but has no
evidence graph behind it.

- A structured master profile: experience → project → technology → responsibility → outcome → metric →
  **evidence**.
- Every generated resume bullet references a claim ID that resolves to evidence.
- A JD → resume diff with per-skill coverage.
- Resume variants generated from one truth source, never 20 hand-maintained files.
- Application-answer generation that shows *which evidence was used*.

**Success metric:** 100% of generated bullets trace to a verifiable claim; zero fabricated metrics in audit.

---

## PHASE 3 — Get Seen

Referral and recruiter discovery already exists. Extend it to contact ranking, outreach drafting and follow-up
tracking. **Draft and assist: the user sends.** No spam, no impersonation.

**Success metric:** referral-assisted application → interview rate versus cold application → interview rate,
measured on real outcomes.

---

## PHASE 4 — Application OS

`Job → prepare → review → apply → track → confirm`, with **human confirmation before every submission**. No
auto-apply. Ever.

---

## PHASE 5 — Interview OS

Triggered when an application reaches INTERVIEW: company briefing, JD skill map, technical, DSA,
system-design and behavioural prep, STAR stories, weak-area tracking.

**Do not build before the application funnel produces enough interviews to justify it**, but design the data
model now so it plugs in.

---

## PHASE 6 — Learning OS

Market skill demand → the user's gaps → a prioritized learning plan. Recommendations derive from *the user's
actual target jobs*, never generic trends.

---

## PHASE 7 — Personal Career Intelligence

`OpportunityEvent` logs shown, clicked, dismissed and applied. Accumulate until the dataset supports: source →
interview rate, referral → interview rate, freshness → interview rate, resume variant → interview rate.

Then the score stops predicting *fit* and starts predicting:

> "If you spend 25 minutes applying to this today, how likely is an interview?"

**Do not auto-retrain early.** Collect first.

---

## PHASE 8 — Business

**Not before CareerOS demonstrably helps its first user get interviews.** No billing, no multi-tenancy, no
admin panel until then. The moat is outcome intelligence, not scraping volume.

---

## Technology decisions

- **One writer.** The NestJS API (Prisma) is the only database writer. Workers (BullMQ) reach the database
  through internal API endpoints, so schema and invariants live in one place.
- **Storage.** PostgreSQL with pgvector for job and resume embeddings, Redis for queues, S3-compatible object
  storage for resume files.
- **AI.** Gemini models through Vertex AI for classification and scoring, and one fixed embedding model.
  Changing the embedding model requires a full re-embed.
- **Spend control.** AI spend is enforced by a policy checked before every provider call.
- **Extraction.** Tier order is official API, static HTML, JSON-LD, deterministic DOM, browser render, and LLM
  last.
- **Sources.** Each source is an adapter feeding the single `BoardJob` spine. LinkedIn and job portals are
  reached only through the user's own alert emails.
- **Decisions.** Every decision is persisted and versioned. A computed decision that is not stored will be
  recomputed forever.
- **Human approval.** Every external action (submit, send) requires it.
- **ADRs.** `docs/DECISIONS.md` holds the architecture decision records. `CLAUDE.md` holds the engineering
  contract.

## Deliberately rejected (with reasons)

| Idea | Why not |
|---|---|
| Classify every job with the LLM | measured: low-ranked bands contained no stack-relevant jobs; the cost buys nothing |
| Multi-lane retrieval | the failure it guards against does not appear in this corpus |
| Freshness re-ranking in retrieval | fresh jobs are spread evenly across bands; it would surface fresh *irrelevant* jobs |
| LinkedIn scraping | terms of service; brittle; ADR-8 red line |
| Crawl4AI now | the renderer boundary already exists; benchmark before adopting |
| Loosening the seniority gate | destroys the product's reason to exist |
| Relative-URL "fix" in the career extractor | retracted: misdiagnosed. Relative links already resolved, and the rejected entries were not jobs. Loosening the filter would have ingested shop listings as jobs |
