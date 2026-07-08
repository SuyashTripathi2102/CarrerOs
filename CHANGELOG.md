# CareerOS Changelog

User-perspective changes per release — what got better for the job hunt, not
what changed in the code (that's git log). Newest first.

## v0.2 — 2026-07-08 · "The recruiter learns judgment"

- **Notifications now decide, not just inform**: every alert leads with
  🟢/🟡/🔴 score and an APPLY / CONSIDER / SKIP verdict with reasons —
  readable in under 10 seconds, with tappable Apply buttons.
- **India-first**: only jobs in India (your preference) reach your phone;
  preferred cities (Indore, Bangalore, Pune, Hyderabad) boost ranking.
  Indian job supply grew 2.5× after seeding 139 Indian companies and fixing
  a crawler gap that ignored Workable-based employers (most Indian startups).
- **No more zombie jobs**: postings older than 30 days never ping you
  (60 for big-tech/actively-hiring companies, with honest "open 72d but they
  hire continuously" context). A 70-day-old role will never read "High" again.
- **Freshness matters**: brand-new postings are prioritized aggressively —
  applying within 48h measurably raises response rates.
- **Better resume understanding**: parsing now extracts 26 skills from your
  resume (was 15) — every match score benefits.
- **You can change your password** (POST /auth/change-password) — and AI
  costs are now tracked per call with a live usage/cost endpoint.
- Under the hood: AI moved to Vertex AI — paid by trial credits (₹0 out of
  pocket until October), ~40× faster embedding, no daily quota stalls.

## v0.1 — 2026-07-07 · "The pipeline lives"

- CareerOS runs autonomously on a VPS: discovers companies, detects their
  ATS boards, crawls jobs every 15 minutes, matches them against your resume
  with AI, and sends Telegram alerts — no human input required.
- Discovery flywheel: a job board mention becomes a directly-monitored
  company automatically (399 YC companies converted on day one).
- Resume upload with versioning; AI parsing with vision fallback for
  design-tool PDFs.
