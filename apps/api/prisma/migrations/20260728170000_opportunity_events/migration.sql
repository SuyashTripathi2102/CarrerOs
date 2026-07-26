-- Validation phase — append-only outcome/decision log. Snapshots the Opportunity
-- Score AND its breakdown at the moment a user acts on a recommendation
-- (viewed/clicked/dismissed/applied), so we can later correlate signals with
-- outcomes. This data cannot be backfilled — it starts accruing now.
CREATE TABLE "opportunity_events" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "surface" TEXT,
    "opportunityScore" DOUBLE PRECISION,
    "verdict" TEXT,
    "breakdown" JSONB,
    "decisionVersion" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "opportunity_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "opportunity_events_userId_jobId_idx" ON "opportunity_events"("userId", "jobId");
CREATE INDEX "opportunity_events_type_createdAt_idx" ON "opportunity_events"("type", "createdAt");

ALTER TABLE "opportunity_events" ADD CONSTRAINT "opportunity_events_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "opportunity_events" ADD CONSTRAINT "opportunity_events_jobId_fkey"
    FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
