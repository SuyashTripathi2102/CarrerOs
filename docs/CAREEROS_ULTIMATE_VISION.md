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

## 7. The Command Center — what "done" looks like

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
