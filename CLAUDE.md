# CareerOS — Master Engineering Instruction

> Loaded every session. Read `docs/CAREEROS_2_ROADMAP.md` for the phase plan and
> `docs/DECISIONS.md` for the ADRs before structural changes.

## North star

**Maximize the user's probability of getting interviews and offers, while
minimizing the user's time and effort.**

Not job count. A feed of 20,000 irrelevant jobs is a failure; so is a curated
list of one. The product is "dig the market for me, then rank it honestly" —
high recall first, ranking second.

Never optimize for vanity metrics ("4,120 jobs discovered"). The number that
matters is **relevant new jobs/day for this user's actual profile**.

## The spine — never fork it

```
Discovery → BoardJob → validate → fingerprint dedup → ingest → embed
  → vector retrieval → role classification / eligibility gate → deep scoring
  → Opportunity Score → Browse / Today / Telegram
  → application / referral / outreach → outcome events → analytics
```

**A new source is an adapter, not a new architecture.** Every source normalizes
into `BoardJob` and flows through the same validation, dedup, embedding and
scoring. Do not create a second pipeline for any reason.

Every source must carry provenance: `source`, `sourceType`, `sourceUrl`,
`retrievedAt`, `publishedAt`, `lastSeenAt`, `extractorVersion`, `confidence`,
`externalId`.

## Standing invariants

**1. UNKNOWN ≠ LOW.** Absence of evidence drops a scoring module and
renormalizes remaining weights. Only *evidence of absence* scores low.

```
company never observed      ≠ company is poor
observed 3 hours            ≠ no hiring velocity
salary undisclosed          ≠ low salary
referral unknown            ≠ no referral
```

A company watched 90 days with zero postings *is* a genuine quiet period —
score it low. A company known for 3 hours is not.

**2. Never loosen the gate to inflate the dashboard.** Raise recall *before* the
gate, never by weakening it. Converting CONSIDER/SKIP into APPLY to produce a
fuller screen destroys the product's reason to exist.

**3. Never invent resume content.** Rephrasing truthful experience is allowed.
Metrics, employers, titles, technologies, responsibilities, certifications are
not. Every generated claim must trace to real career evidence.

**4. LinkedIn via email alerts only.** ADR-8 red line. No scraping, stealth
browsers, proxy rotation, CAPTCHA or anti-bot evasion. Parsing the user's own
inbox is legitimate and is the sanctioned path.

**5. Persist every decision.** A decision computed but not stored will be
recomputed forever — this caused the 2026-08 queue-starvation bug where
gate-refused jobs permanently consumed 19 of 60 candidate slots. If code decides
something, write it down.

**6. Extraction tier order.** Official API → static HTML → JSON/JSON-LD →
deterministic DOM → browser render → LLM. Browser rendering is a fallback, never
the default. Never send thousands of pages to an LLM; classification costs
~$0.019/job and garbage ingestion has a direct dollar cost.

## Data quality

False positives are worse than missing a few jobs. Never ingest navigation
headings, blog posts, marketing pages, "how to apply" sections, error pages, or
directory entries. RemoteOK was shipping "Oops something happened" and "HOW
APPLY" as job postings — 96% of its feed — at $1.82/crawl in wasted
classification.

Every extractor needs positive signals, negative signals, validation,
explainable confidence, a rejection reason, metrics, and tests.

## Changing the Opportunity Score

Measure first. Any change ships with **BEFORE / AFTER / affected jobs / verdict
changes / regression tests**. Do not casually touch weights, thresholds,
eligibility rules, retrieval depth, or verdict cutoffs.

Report `verdict='APPLY'` and `opportunityScore >= 70` as **separate** numbers.
They are different metrics and conflating them misrepresents results.

## Reviewing an external repository

Do **not** copy code on sight. Produce first: what it does · architecture ·
discovery sources · scraping/browser techniques · extraction · access-control
handling · data model · dedup · scheduling · retries · quality controls · LLM
usage · cost · ideas CareerOS lacks · ideas CareerOS already does better ·
brittle ideas · integration design · tests required.

Then classify every idea:

```
P0     build immediately
P1     build after validation
P2     future
REJECT don't use
```

Separate **reusable engineering idea** from **risky/ToS-sensitive
implementation**. A technique can be worth understanding while its
implementation is worth refusing. Don't assume an external project is better
because it's new, or that CareerOS is better because it has more features.

## Before building any major feature

Answer: What problem does this solve? What evidence says this is the bottleneck?
What metric improves? What does it cost? What can go wrong? Can we measure the
result?

**If the evidence says the feature is unnecessary, say so.** Three rebuilds have
already been correctly rejected on measurement — see the roadmap's "Deliberately
rejected" table.

## Working style

Inspect → measure → explain → propose → implement → test → verify. Never claim
something is deployed without runtime verification. Never hide uncertainty.
Never silently change unrelated components. Distinguish *proven* from
*plausible* in the same breath.

Quantify before characterizing. A claimed magnitude that was never computed is a
guess wearing a number.
