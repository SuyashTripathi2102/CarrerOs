# JobIntel — Product Vision

*Captured 2026-07-06 from product direction discussion. This supersedes any earlier framing of
the project as a "job scraper" or job board.*

## The one-line goal

**Never miss an opportunity that matches me.**

Not "find jobs" — a personal AI recruiter that continuously watches the entire hiring landscape
for one person, from 5-employee agencies in Indore to 100,000-employee enterprises, and surfaces
only what matters.

## Pillars

### 1. Company Discovery Engine (grows itself, no manual input)

The company database must grow continuously and automatically:

- **Flywheel (built, Phase 4):** every job seen on any board → auto-create company → detect ATS
  from apply URL → crawl directly forever.
- **Directory sweeps:** YC directory, startup directories, GitHub orgs, curated public ATS-token
  datasets.
- **City-wise discovery:** software companies in Bangalore, Pune, Hyderabad, Chennai, Delhi/NCR,
  Ahmedabad, Indore, Mumbai... via Google Places API (needs key). Discover website → find career
  page → detect ATS → monitor forever.
- **Search-based discovery** through *APIs* (Google Custom Search / Bing API), never raw SERP
  scraping (ToS).
- Priority order always: official ATS API → official feed/RSS → structured endpoints → HTML
  scraping only as a last resort (Python service), robots.txt respected.

### 2. Continuous monitoring

Daily (and eventually tiered — companies I applied to or follow get crawled more often):
new companies, new career pages, ATS changes, new/removed/updated jobs, historical snapshots.
Duplicate jobs across sources are merged; the official company apply link always wins.

### 3. AI Job Intelligence (Phase 5)

Per job: match score vs my resume, reasoning, missing skills, interview difficulty estimate,
learning priorities, tailored resume, cover letter, recruiter outreach message, interview prep.
Salary estimate when unlisted (comparables in DB + LLM, always labeled as estimate).
**LLM abstraction layer** — provider (OpenAI/Gemini/Claude) switchable by config, never
hardcoded into features.

### 4. Company Intelligence

Per company: overview, products, tech stack (public sources), funding, size, hiring trend,
recent news, engineering blog, open-source repos, office locations.

### 5. Hiring Signals Engine (the differentiator)

Watch for signals that hiring is *about to happen*, before the postings appear: funding
announcements, new office openings, careers-page changes, new ATS setup, posting-velocity
spikes, product launches. Signals precede dozens of roles.

### 6. Referral & Outreach (public info only, ToS-respecting)

Identify publicly visible recruiters/TA/hiring managers/engineers/alumni per company; generate
personalized outreach; track who was contacted, follow-ups, and responses. No private-data
collection, no platform-rule violations.

### 7. One-click Application Assistant (NOT auto-apply)

Auto-apply is explicitly out: many portals prohibit it, and blast-applying lowers response
quality. Instead: prepare tailored resume + cover letter, open the official application page,
pre-fill where permitted (user-controlled browser automation), **user reviews and submits**.

### 8. Application Analytics (closes the loop)

Per application: date, source, resume version used, cover-letter version, referral y/n,
response time, outcome. After 100–200 applications the system answers: which resume version
gets callbacks, which sources convert to interviews, which titles convert best, which skills
correlate with callbacks. Continuous optimization, not just search.

### 9. Alerts & Dashboard

Near real-time alerts on new matches (bounded by crawl cadence; tiered crawling makes it
tighter for followed companies). Dashboard answers: who hired today, who started hiring this
week, trending skills, hiring by city, best-matching companies, roles opened in last 24h,
companies that ignored my applications.

## Additions agreed 2026-07-06 (post architecture review)

- **Roadmap order is A → B → B.5 → C** (see ARCHITECTURE_REVIEW.md): data-platform hardening →
  Company Discovery Engine → **Company Intelligence Layer** (rich per-company metadata:
  locations, hiring history/frequency, tech stack, engineering blog, funding, open source,
  interview difficulty) → incremental matching + real-time notifications. Referrals and
  dashboard deliberately postponed until the data engine is mature.
- **Opportunity Score** replaces plain match %: combines resume fit, hiring freshness (posted
  20 min ago ≫ 45 days ago), experience fit, remote/salary preference fit, company response
  signals, referral availability → one actionable 0-100 number with visible sub-factors.
- **Learning Intelligence**: analyze the live job corpus ("of 2,500 backend jobs this month:
  docker 68%, redis 61%, aws 58%...") and quantify: "learning Docker + Redis raises your match
  rate from 74% → 89%." Live hiring demand, not generic advice. Builds after C (needs corpus +
  matching history).
- **Browser extension** (later): on any job page — detect company, show match score, missing
  skills, right resume version, one-click save to tracker.
- **Three deployable units, no microservices** (frontend, API, workers) — modular monolith,
  scale 1k → 100k companies via infrastructure (VPS, proxies, paid LLM), never via rewrite.
  Budget constraint: $0-10/month initially.

## Honest constraints (agreed)

- LinkedIn/Indeed: never scraped; covered via their official alert emails + the fact that most
  postings originate on ATS boards we already crawl.
- "Which companies hired people at my level" — not reliably knowable from legal public data;
  dashboard promises only what our own data can answer.
- Internal-hiring visibility — not possible from outside; referral workflow is the substitute.
- Government business registries — low signal for job hunting; skipped.
