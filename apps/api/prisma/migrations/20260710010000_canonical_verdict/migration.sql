-- One canonical verdict per match.
--
-- Until now three consumers independently derived APPLY/CONSIDER:
--   Telegram   -> decide()          (had a title-based role guard)
--   Dashboard  -> raw SQL on opportunityScore >= 75
--   2 PM digest-> raw SQL on opportunityScore BETWEEN 60 AND 75
-- So a digital-marketing role appeared under "Apply today" on the dashboard
-- even though the notification path would have refused to send it.
--
-- After this migration the decision is computed once and stored. Every
-- consumer reads this column. roleRelevance ("is this the kind of work I
-- want?") is kept separate from overallScore ("does my resume resemble it?") —
-- the Paytm Tag Manager role was 1% relevant and 65% resume-matched, and
-- collapsing those two numbers into one score is what recommended it.
ALTER TABLE "job_matches" ADD COLUMN "verdict" TEXT;
ALTER TABLE "job_matches" ADD COLUMN "verdictReason" TEXT;
ALTER TABLE "job_matches" ADD COLUMN "verdictCode" TEXT;
ALTER TABLE "job_matches" ADD COLUMN "roleRelevance" INTEGER;
ALTER TABLE "job_matches" ADD COLUMN "decisionVersion" INTEGER;
ALTER TABLE "job_matches" ADD COLUMN "decidedAt" TIMESTAMP(3);

CREATE INDEX "job_matches_userId_verdict_idx" ON "job_matches"("userId", "verdict");

-- Existing rows carry no verdict: they were scored before role eligibility
-- existed and must not surface as recommendations. They stay in the table as
-- audit history — every one of them is inspectable — but a NULL verdict is
-- never APPLY, never CONSIDER, and never notified.
