# CareerOS — Ultimate Vision

> Canonical long-term specification. Adopted 2026-08-15.
> `CAREEROS_2_ROADMAP.md` remains the near-term phase plan; this is the target
> that plan is walking toward. `DECISIONS.md` holds the ADRs.
>
> Source: a long design conversation between Suyash and ChatGPT, reconciled
> against measured system state. Where the two disagreed, the measurement wins
> and the correction is marked **[MEASURED]**.

---

## 1. North star

CareerOS is **not** a job-search app and **not** a scraper collection.

> **A Personal Opportunity Operating System: maximize Suyash's probability of
> winning legitimate opportunities, while minimizing the time and effort he
> personally spends.**

"Automate everything" is the wrong goal. Sometimes the winning move is *not*
applying, *not* messaging, *not* taking a client. The system must be able to
recommend inaction.

An opportunity is not only a job:

```
              OPPORTUNITY
                   │
   ┌───────────────┼───────────────┐
   ↓               ↓               ↓
  JOBS          CLIENTS        LEARNING
   │               │               │
companies      businesses      skills the
recruiters      founders       market pays
startups       freelance          for
portals        projects
```

The moat is never the scraping. It is:

```
INFORMATION → INTELLIGENCE → DECISION → ACTION → OUTCOME → LEARNING
     ↑                                                        │
     └────────────────── better next decision ────────────────┘
```

Anyone can scrape jobs. Almost nobody has a dataset of *which recommendations
actually produced interviews for this specific person*.

---

## 2. Where we actually stand — 2026-08-15 **[MEASURED]**

Percentage-complete bars are guesses unless computed, so this table carries
numbers instead.

| Stage | State | Evidence |
|---|---|---|
| Active jobs | **20,671** | `jobs WHERE status='ACTIVE'` |
| India (`country='IN'`) | **4,142** | after the 2026-08-15 normalization fix |
| India **or** remote | **11,585** | the matching pool |
| Ingested last 48 h | **15,404** | supply is genuinely strong |
| Embedded | **18,718 (90.6%)** | ✅ self-healed from 61%, as predicted |
| **Evaluated (deep decision)** | **235 (1.14%)** | 🔴 **the binding constraint** |
| APPLY / CONSIDER / SKIP | 7 / 23 / 205 | for the active resume version |
| Conversion events | 0 | table cleared; experiment not yet started |
| Tests | 492 green | |

### The one number that should drive planning

```
              arrived    evaluated    ratio
2026-08-12      5,656          495     8.7%
2026-08-13     15,756        1,260     8.0%
2026-08-14      1,339          155    11.6%
```

**Evaluation runs at roughly 8–12% of intake.** ~90% of everything ingested
joins a pile that is never judged. Discovery is *not* the bottleneck; judgement
is. See §6, correction 1 — this reorders the roadmap.

### Fixed since the laptop change (all measured, all tested)

| Fix | Result | Commit |
|---|---|---|
| Stale checkout (105 commits behind) | reconciled | — |
| RemoteOK ingesting non-jobs | 96% of feed rejected, ~$1.82/crawl saved | — |
| Queue starvation (refusals never persisted) | 19 dead slots → 0 | `19f3f7a` |
| Company aliases defeating dedup | 18 regression tests | — |
| UNKNOWN ≠ LOW in scoring | verified across 10 modules | `19f3f7a` |
| Embedding "bottleneck" | proved transient, coverage now 90.6% | `8f195a7` |
| Analytics recorded the wrong score | displayed + stored both kept | `b391ed4` |
| **Two competing Opportunity Scores** | **decision engine is now canonical** | `a68b3ad` |
| **567 India jobs invisible** | `country='India'` → `'IN'` | `5df10f7` |

> **[MEASURED] correction:** earlier status summaries list "fix the two-score
> problem" and "Opportunity scoring 🟡 needs surface unification" as *pending*.
> Both shipped on 2026-08-15. Gate-refused jobs shown as "Apply" went **15 → 0**;
> hidden APPLY jobs went **6 of 7 → 0 of 7**.

---

## 3. Source coverage

| Source | State |
|---|---|
| Greenhouse · Lever · Ashby · Workable · SmartRecruiters · Recruitee · Breezy · Keka | ✅ live |
| Career pages (static + deterministic extractor + snapshot/replay) | ✅ live |
| Jooble · FreeHire | ✅ live |
| Adzuna | ⚠️ blocked — `ADZUNA_APP_ID` missing |
| JS-rendered career pages | 🟡 renderer built, not running at scale |
| Darwinbox · Zoho Recruit · Freshteam · Workday | 🔜 measure FreeHire overlap first |
| **Email ingestion (Gmail)** | 🔴 not built — the single biggest gap |
| LinkedIn (via email alerts only — ADR-8) | 🔴 not built |
| Naukri · Instahyre · Cutshort · Hirist · Wellfound · Uplers · Indeed | 🔴 not connected |

**Email is not just another source.** The same inbox carries the outcome
stream — *application received · recruiter viewed · assessment · interview ·
rejection · offer* — which is the dataset the entire learning layer depends on.
It is the highest-leverage single integration in the roadmap.

---

## 4. The phase roadmap

| Phase | Mission |
|---|---|
| **0** | 🔧 Make the current machine trustworthy — *nearly done; see §6* |
| **1** | 🌐 Universal Job Discovery |
| **2** | 🚀 Startup + Funding Intelligence (predict hiring **before** the posting) |
| **3** | 🧬 Career Truth Graph |
| **4** | 🤝 Referral + Get-Seen Engine |
| **5** | 📄 Application OS |
| **6** | 🎤 Interview OS |
| **7** | 📚 Learning OS |
| **8** | 🇮🇳 India Business / Client Radar |
| **9** | 🌎 Global Freelance Engine |
| **10** | 📞 Email + Voice + Follow-up Agents |
| **11** | 🧠 Personal Career Intelligence |
| **12** | 🤖 Autonomous Opportunity Agent |
| **13** | 💰 CareerOS as a business — *only after it demonstrably works for Suyash* |

### Phase 2 — predict hiring before the job exists

The strongest differentiator, and cheaper than it looks: `CompanyIntelligence`,
`hiringTrend`, `growthScore`, `CompanyWatch` and crawl tiers already exist.

```
funding ↑  +  engineering headcount ↑  +  new CTO  +  India expansion
                              ↓
              🔥 high probability of hiring in 30–90 days
                              ↓
        watch company → watch career page → alert on first posting
```

### Phase 8/9 — the client engine

```
business detected → problem detected (no site / outdated / no booking)
   → can Suyash solve it? → estimated value → personalized pitch
   → HE approves → send → track → follow up → client
```

Not "Hello sir, I am a developer." A specific observation, a specific fix.

---

## 5. Standing architectural principles

### 5.1 Autonomy levels — build the data model NOW

Every action carries a level. Cheap to add early, brutal to retrofit.

```
L0 observe     "Startup X raised funding."
L1 recommend   "This looks strong, here's why."
L2 draft       "I wrote the email."
L3 approve     "Send this?"
L4 auto        only where explicitly allowed
L5 autonomous  discover → act → monitor → follow up, inside hard bounds
```

| Action | Default |
|---|---|
| Find jobs / companies / analyze JDs / monitor funding | ✅ automatic |
| Tailor resume draft · draft email · prepare application | ✅ automatic (draft only) |
| Send application · recruiter message · client proposal · phone call | 🟡 approval |
| Change resume **facts** · impersonate Suyash · spam · evade auth or platform controls | ❌ never |

### 5.2 The spine — never fork it

```
Discovery → BoardJob → validate → dedup → ingest → embed → retrieve
  → eligibility gate → deep evaluation → Opportunity Score → surfaces
  → action → outcome events → learning
```

**A new source is an adapter, not a new architecture.** Proven twice on
2026-08-15: normalization at the single ingest choke point fixed 567 jobs
across every surface at once, and the decision engine became canonical for
every surface in one change.

### 5.3 One canonical decision

There must be exactly **one** Opportunity Score: the persisted, gated,
10-module decision. Surfaces *consume* it, never invent a parallel one. Two
scorers sharing a name is what produced "Apply — Opportunity 71" for a job
recorded `TARGET_ROLE_TOO_SENIOR`.

Unevaluated is a **state**, not a low score:

```
APPLY / CONSIDER   evaluated — carries a real score
POTENTIAL          similar, not yet judged — carries NO score
REFUSED            judged and rejected — never surfaced as actionable
```

### 5.4 Source registry — measure before adding

Every source reports: jobs found · new · duplicates · rejected garbage · India
share · fresh share · **APPLY share** · cost · health.

The verdict is **fresh actionable jobs/day per source**, never "the scraper
works". A source adding 5,000 senior US roles has failed.

### 5.5 Red lines

LinkedIn via email alerts only (ADR-8). No scraping, stealth browsers, proxy
rotation, CAPTCHA or anti-bot evasion. Never invent resume content. Never
loosen the gate to fill a screen. Persist every decision.

---

## 6. Engineering corrections to the plan

Marked separately because they change *ordering*, not ambition.

### Correction 1 — Phase 1 before evaluation throughput makes things worse

**This is the most important item in this document.**

Discovery is at ~15,400 jobs/48 h; evaluation absorbs 8–12% of it. Coverage is
**1.14%**. Ten more sources multiply intake, not judgement:

```
   20,671 jobs × 1.14% evaluated  →  7 APPLY
  100,000 jobs × 1.14% evaluated  →  ~7 APPLY, and a far larger pile
```

More supply cannot produce more recommendations while the evaluator is the
constraint. **Phase 1 needs an evaluation-throughput workstream beside it** —
cheap pre-filters before the LLM, batching, a coarse eligibility pass that
rejects obvious misses for free, or accepting that only a ranked slice is ever
deeply evaluated (which is defensible, but must then be *stated*, since
"1.14% evaluated" and "we evaluate the top slice" are different products).

### Correction 2 — email ingestion outranks portal scrapers

Portals need a scraper each, break independently, and carry ToS risk. Email
covers LinkedIn/Naukri/Indeed through one sanctioned integration **and** is the
only channel that returns outcomes. Highest value, lowest risk, one build.

### Correction 3 — start the interview-question log now

Phase 6 is far away, but the dataset is only collectable in real time. A table
of *company · role · round · question · how it went* costs almost nothing today
and cannot be reconstructed later.

### Correction 4 — the client engine has a compliance surface

Cold B2B outreach touches India's DPDP Act, GDPR for international contacts,
and CAN-SPAM. Not a blocker, but it needs consent/suppression handling designed
in from the first version — retrofitting it means rebuilding the outreach layer.

### Correction 5 — deprioritize the voice agent

Highest risk, most failure modes, least near-term value versus email and
referrals. If built, restrict to bounded inbound qualification and scheduling —
never open-ended conversation that could be taken as Suyash speaking.

### Correction 6 — replace the progress bars with the funnel

`DISCOVERY ~70% / MATCHING ~90%` was never computed. Track this instead:

```
discovered → embedded → eligible → evaluated → APPLY surfaced
   → shown → clicked → tailored → applied → response → interview → offer
```

Each stage a real count, per day, per source. That is the honest scoreboard,
and it names the constraint automatically.

---

## 7. The Capability Gate — the definition of "no gaps left"

The standard is deliberately higher than "it works":

> **For Suyash's current career situation, no important capability gap remains.
> Anything further is optimization, not a missing capability.**

A phase does not close until **every** item in its checklist is in one of four
states — and the last two are first-class outcomes, not excuses:

| State | Meaning | Evidence required |
|---|---|---|
| 🟢 **BUILT** | shipped + tested | passing tests, named |
| 🟢 **MEASURED** | working in real life | a number, dated |
| ⚪ **INTENTIONALLY UNSUPPORTED** | decided against | ADR with the reason |
| 🟡 **PROVEN UNNECESSARY** | measured, found not to be the bottleneck | the measurement |

### 7.1 Rules that make this a gate and not a wish list

**Every checklist item needs a metric and a query.** "Source health ✅" is an
opinion. `source_health: 8/8 adapters reporting, 0 stale > 48h` is a gate. If an
item cannot be expressed as something re-runnable, it is not a gate item — it is
a feeling.

**The gate is re-runnable, not one-time.** Capabilities silently regress:
`country='India'` was green until it wasn't, and 567 India jobs went missing for
weeks with every test still passing. Gates run continuously (`scripts/*.sql`),
and a green item that turns red is a P0.

**"Proven unnecessary" must be recorded with its evidence.** Four rebuilds have
already been correctly rejected on measurement (see the roadmap's Deliberately
Rejected table). Those are *wins* and must be logged as loudly as builds —
otherwise the next session rebuilds them.

**Every source and feature needs kill criteria.** The plan says when to build;
nothing says when to *stop*. A source producing 500 jobs and 0 applications in
30 days should be turned off, and that threshold is decided in advance.

**State the cost ceiling before the work, not after.** Classification is
~$0.019/job; evaluating the current corpus is ~$390. Without a stated monthly
budget, throughput gets decided by accident.

### 7.2 GATE 0 — Durability *(unlisted everywhere, highest severity)*

**[MEASURED 2026-08-15] There are zero backups.** No dump, no cron, no script.
The whole corpus — jobs, evaluations, resume, company intelligence, and every
future outcome event — lives in one Docker volume on one laptop. Production data
was already destroyed once this month; the backups lived on the same disk.

Every phase below is built on this data, and Phase 11 (self-improving CareerOS)
is valuable *only* because of accumulated outcome history. Losing it does not
cost a rebuild; it costs the moat.

- [x] Automated `pg_dump` on a schedule — `scripts/backup.ps1`, Windows task
      `CareerOS-Backup`, nightly 02:00
- [x] Stored **off** the machine that runs Postgres — OneDrive, size-verified
      after copy (local copy also lands on `D:`, a different physical drive from
      Docker's WSL2 vhdx on `C:`)
- [x] A restore actually **tested**, not assumed — `scripts/verify-restore.ps1`
      restores into a throwaway DB and compares every table.
      **2026-08-15: 30/30 tables match, pgvector usable, 20,645 embeddings**
- [x] Resume + `confirmedProfile` exported separately — `profile_*.json`,
      readable without a running Postgres
- [x] Outcome events covered — `opportunity_events` is asserted by the verifier,
      so the moat is checked on every run

**Status: PASSING as of 2026-08-15** (174 MB dump, both copies byte-identical).

Two traps this hit, worth remembering:
- Piping `pg_dump -Fc` through a PowerShell pipeline **corrupts the archive** —
  PowerShell reinterprets the byte stream as text. Dump inside the container and
  `docker cp` it out. The corrupt version looks fine and cannot be restored.
- The verifier exercises **pgvector specifically**. `job_embeddings` restores as
  rows but is worthless if the `vector` type did not come with it, and a plain
  row-count check would call that a success.

Re-run `verify-restore.ps1` after any schema change. This gate outranks every
feature in this document.

### 7.3 The full checklist

**Discovery** — jobs · ATS · aggregators · career pages · email alerts · startup
sources · funding signals · company signals · India-specific · international ·
source health · dedup · freshness · **extraction drift detection**

**Intelligence** — personal career graph · company intelligence · recruiter
intelligence · funding intelligence · opportunity prediction · market trends

**Job winning** — matching · ranking · resume tailoring · cover letters · ATS
optimization · referral discovery · outreach · applications · follow-ups ·
tracking

**Interview** — job-specific · company-specific questions · technical · DSA ·
system design · behavioural · mock interviews · weakness tracking · learning
recommendations

**Business** — freelance opportunities · client discovery · new-business
detection · startup intelligence · website opportunities · international leads ·
outreach · proposals · follow-up · CRM

**Automation** — daily intelligence · alerts · email processing · automatic
research · automatic preparation · approval workflows · safe autonomous actions ·
outcome feedback · self-improvement

**Trust** — no fabricated resume claims · no fake outreach · source provenance ·
audit trail · consent · unsubscribe/suppression · rate limiting · account
protection · privacy/security · compliance review · human approval for risky
actions · **durability (Gate 0)**

> **Resume truth needs an automated audit, not a promise.** "No fabricated
> claims" is only a gate when every generated bullet carries a claim ID
> resolving to real career evidence, and a test fails when one does not.

### 7.4 The permanent rule — optimize for outcomes, not features

| Never say | Say |
|---|---|
| "We have 50 scrapers" | "40 relevant opportunities → 12 worth applying → 8 applied → 3 interviews → 1 offer" |
| "We generated 500 resumes" | "Tailored resume B raised interview rate 6% → 15%" |
| "We sent 2,000 emails" | "20 targeted messages produced 6 conversations" |

Completeness is judged by whether CareerOS has exhausted the *meaningful* ways
it can create opportunities — never by lines of code or count of integrations.

---

## 8. What happens next — both tracks, in parallel

Two different questions, and waiting on one to answer the other wastes time:

```
                         NOW
                          │
          ┌───────────────┴───────────────┐
          ↓                               ↓
   5-day real usage              Evaluation-throughput
          │                        design + Gate 0
          ↓                               ↓
  Does it pick good jobs?         Is 1.14% enough?
   (quality of the 7)              (coverage of 20,671)
          └───────────────┬───────────────┘
                          ↓
                  Phase 1 decision
```

**Track A — baseline (needs Suyash, not code).** SEE → CLICK → TAILOR → APPLY →
RESPONSE → INTERVIEW. Measures recommendation *quality*, which is independent of
coverage — the 7 APPLY jobs are either good or they are not.

**Track B — evaluation throughput + Gate 0 (engineering).** Coverage is 1.14%
and evaluation absorbs 8–12% of intake (§2). Gate 0 first: no amount of
capability survives losing the disk.

Phase 1 opens only when both have answered.

---

## 9. The Command Center — what "done" looks like

```
🔥 DO THESE TODAY
1. APPLY      Netomi · Opportunity 90 · fresh · referral available
2. APPLY      Company X · Opportunity 91 · recruiter identified
3. CONTACT    Startup Y · raised $8M yesterday · hiring likely
4. CLIENT     Business Z · website opportunity · ₹50k–₹80k est.
5. INTERVIEW  Company A · tomorrow · 14 questions predicted
6. LEARN      System Design · in 68% of your target jobs · weak area
```

One screen. Not ten tabs. CareerOS says what matters, Suyash decides.
