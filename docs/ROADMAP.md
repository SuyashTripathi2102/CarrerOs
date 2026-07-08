# CareerOS Roadmap — from AI crawler to AI recruiter

> Adopted 2026-07-08 after product review (Suyash + two AI reviews, merged).
> Supersedes the Phase D scope in the PROJECT_LOG handoff brief. The
> infrastructure era is over; every feature now answers ONE question:
> **"Does this help me get interviews faster?"**

## North star — the five questions

Every opportunity CareerOS surfaces must answer:

1. **Should I apply?** (verdict, not a bare score)
2. **How likely am I to get an interview?** (honest bands until outcome data exists)
3. **What is stopping me?** (explicit gaps, scannable)
4. **Can I improve before applying?** (strategy: apply now vs. learn X first)
5. **Who can help me?** (referral/contact paths from public sources)

The JOB is evidence. The OPPORTUNITY — with a decision attached — is the product.

## Releases, not phases (adopted 2026-07-08)

Ship usable improvements, validate by USING the product, let real job hunting
drive the roadmap. **4 perfect notifications beat 48 mediocre ones** — quality
per recommendation over crawler breadth. Enough supply exists once India
sources convert; the crawler expands only when quality features starve for data.

**THE North Star Metric: Qualified Opportunities Applied** — a high-quality
recommendation that the user actually applied to, tracked in-system. Jobs
crawled / companies found are engineering metrics; they never appear as
success numbers again. Success = interviews generated.

| Release | Contents | Status |
|---|---|---|
| v0.1 | crawler, ATS flywheel, matching, Telegram | ✅ shipped |
| v0.2 | Vertex, India-first, decision engine, context-aware freshness, usage ledger | ✅ shipped 2026-07-08 |
| v0.3 | **⭐ Daily Brief** (the morning homepage: must-apply-today, new-companies-hiring, applications-waiting, top missing skill, trending companies) · **Dashboard as Mission Control** — every screen answers "what should I do next?" · **Company Reports** (hiring score/velocity by function, locations, tech stack, difficulty, referral candidates — the research assistant) · **Referral discovery** (public sources; likely the killer feature: best person → reason → draft message) · **Intelligent tracker** (status flow + follow-up intelligence: "no response in 7d — send follow-up?", drafted) · **Dream-company watchlist** (instant-notify tier, bypasses digest) | next |
| v0.4 | resume tailoring, cover letters, interview prep, application strategy | |
| v1.0 | learning engine, **resume heatmap** (skill % vs market + "+X% if learned"), browser extension, analytics; auto-apply ONLY after decision→tailor→referral→report chain is proven (intelligence before automation, or it's spam) | |

Fix queued for v0.3: `recentJobs14d` uses firstSeenAt, so a company's first
crawl looks like a hiring spree — switch to postedAt when available.

**2026-07-09 review additions (build order for next sessions):**
1. **Indian ATS adapters** — Darwinbox, Zoho Recruit, Keka, freshteam (public
   career boards, same pattern as Lever/Workable). Expected to ~double Indian
   supply. Instahyre/portals stay excluded unless a public feed provably exists.
2. **Contact subsystem is classify-and-rank, not collect** (D-3 spec upgrade):
   role classification (recruiter/EM/HRBP/founder/TA) + best-contact
   recommendation with reason, from public sources only.
3. **ATS Resume Validator** — score any uploaded resume: text extractable,
   reading order, headings, sections, keyword coverage → "ATS Score 97/100".
   We already own the parsing machinery; genuinely differentiating feature
   (born from the Canva-PDF incident).
4. **Daily rhythm** — evening "you didn't apply to these N" nudge, weekly
   report, quiet hours, dream-company instant tier (watchlist).
5. Dashboard nav growth: Jobs / Companies / Applications / Analytics / Settings.
6. Rejected (no-fabrication principle): competition estimates and funding data
   without a real source — parked until the learning engine can back them.

**Funnel the dashboard must show:**
`crawled → matched → recommended → high-priority → applied → interviews → offers`

**Validation protocol:** Suyash uses CareerOS as his ONLY job-search tool for
7–10 days — morning dashboard review, apply to high-priority, track every
application in-system, note every point of confusion. Daily friction beats
feature brainstorms.

## Non-negotiable principles

- **Decisions over information.** A notification must be actionable in <10s.
- **Never fabricate numbers.** No invented salaries, no fake "78% interview
  probability". Qualitative bands + visible reasoning until the tracker
  provides real outcome data (Phase F unlocks honest percentages).
- **Public information only for people.** LinkedIn/Indeed scraping is
  permanently out of scope (ToS — day-one decision). Contact discovery uses
  harvested public emails, team pages, GitHub, blogs.
- **Individually-reviewed only, never bulk.** Applies to outreach AND future
  auto-apply (assistive drafting, human sends).
- **Geography-aware, India-first (current user preference).** Supply must
  match: decisions over a US-heavy pool don't fill an Indian funnel.

## Phase D — Decision Engine & Reach

1. **Decision layer + notification redesign** — APPLY / CONSIDER / SKIP verdict
   (rule-based over existing scores; LLM `reasoning` as explanation), visual
   score (🟢/🟡/🔴 NN/100), strengths ✔ / missing ❌ lists, freshness tiers
   (🔥 today / 🟡 this week / ⚪ stale), salary shown only when listed (with
   source), twin-posting hint (Brigit "66×2" lesson), geography tiers
   (India city > India remote > hidden), URL buttons (Apply, Careers page).
2. **India-first discovery sources** — city-based company discovery
   (Indore/Pune/Bangalore/Hyderabad/NCR), Indian companies' ATS boards.
   Fixes the supply problem (only ~250/5,291 jobs India-relevant today).
3. **Contact & referral subsystem** (public sources) — prober harvests
   mailto:/jobs@/careers@ (already approved), team pages, GitHub org members,
   engineering-blog authors → `Company.contactEmails` + contacts surface in
   notifications ("Referral path: 2 public contacts").
4. **Bot interactivity + Company Report** — Telegram callback buttons
   (Skip/Save/Report; needs bot update polling), `/report` = company overview,
   **hiring timeline** (firstSeenAt/lastSeenAt/REMOVED analytics — the
   already-approved timeline item), crawl-health-as-confidence explained in
   words, tech stack from job_skills, openings by function.
5. **Application strategy** — "Apply today + referral recommended" vs.
   "Learn Docker first (~2 days), then apply" — rule-based v1 from skill-gap
   + freshness + competition signals.
6. **Applications tracker** (moved UP from Phase E — it is the data collector
   the learning engine depends on; schema has existed since Phase 2) —
   create-from-job, status transitions, ApplicationEvent timeline, stats.
7. Small fixes: POST /auth/change-password; findOrCreateFromBoard stamps
   discoverySource; scheduled rescore sweep (threshold changes must not
   strand qualifying matches).

### Context-aware freshness (shipped v1, 2026-07-08 — evolves in F)

Age is read in context, recruiter-style: curated big-tech tier = evergreen
(2× notify window, softened verdicts), live hiring activity (jobs added last
14d) rescues unknown-but-active companies, everyone else gets the strict
curve. **Phase F upgrade:** learned per-company posting lifetime from
firstSeenAt/lastSeenAt/REMOVED history (needs weeks of observation — DB
started 2026-07-07) replaces the static tier list as the evergreen signal.
Also deferred to F: user-configurable boost values, preferredCompanies
preference (schema addition), star-weighted city preferences.

## Phase E — Apply Better

0. **Dashboard v1** (pulled forward deliberately): today's high-priority
   opportunities, hiring-velocity movers, top missing skill, referral
   opportunities, applications awaiting follow-up, funnel stats. Doubles as
   ops visibility (crawler/matcher health).
1. Resume versioning UX + tailored resume per application (Phase 5.5 items).
2. Cover letter drafts (individually reviewed, never auto-sent).
3. Interview prep per company (from job description + company intelligence).

## Phase F — Learning Engine (unlocked by tracker data)

- Outcome learning: which resume versions / strategies convert to interviews.
- **Skill intelligence**: "Docker: 183 companies, 2,918 jobs, +11% median
  opportunity score if learned" — demand counts are SQL over job_skills;
  score uplift is the approved "+X%" recompute; study-time stays a rough
  heuristic, honestly labeled.
- Honest interview-probability percentages (now backed by data).
- Hiring/company/resume analytics.

## Phase G — Reach & Automation (ethos-guarded)

- Browser extension: autofill applications (assistive), page-context
  company reports.
- Email scanner: application status detection → tracker auto-updates.
- Auto-apply = **draft-and-review**, never fire-and-forget.

## Phase H — CareerOS beyond one user

- Multi-resume, multi-user, teams; recruiter-side CRM; premium tiers.

## Explicitly rejected / deferred

- LinkedIn/Indeed scraping & connection graphs — permanent ToS exclusion.
- Salary *estimation* without data — show listed or "Not listed".
- Fake interview percentages before Phase F.
- Per-field job-change events (needs ingest job_events table — deferred,
  batched upsert makes old-vs-new comparison nontrivial).
