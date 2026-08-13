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
| UNKNOWN ≠ LOW in `companyQuality` / `hiringVelocity` | 🔴 audited, **not yet fixed** |
| Full module audit against the invariant | ⬜ |
| Daily-cycle baseline (several real days) | ⬜ |

**Success metric:** a stable daily funnel — new → India → SWE → stack → ≤3 YOE →
eligible → scored → APPLY → applied — measured across ≥5 consecutive days.

**Exit criteria:** we can state relevant-jobs/day with a real denominator, and
no scoring module treats missing data as bad data.

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
