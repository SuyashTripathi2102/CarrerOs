-- Per-run extraction telemetry: the Discovery Health funnel + quality panel.
CREATE TABLE "extraction_runs" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "extractorVersion" TEXT NOT NULL,
    "companiesQueued" INTEGER NOT NULL DEFAULT 0,
    "fetched" INTEGER NOT NULL DEFAULT 0,
    "fetchFailed" INTEGER NOT NULL DEFAULT 0,
    "pagesWithJobs" INTEGER NOT NULL DEFAULT 0,
    "jobsExtracted" INTEGER NOT NULL DEFAULT 0,
    "jobsIngested" INTEGER NOT NULL DEFAULT 0,
    "duplicates" INTEGER NOT NULL DEFAULT 0,
    "snapshotted" INTEGER NOT NULL DEFAULT 0,
    "avgConfidence" INTEGER NOT NULL DEFAULT 0,
    "avgFetchMs" INTEGER NOT NULL DEFAULT 0,
    "avgParseMs" INTEGER NOT NULL DEFAULT 0,
    "totalMs" INTEGER NOT NULL DEFAULT 0,
    "rejections" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "extraction_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "extraction_runs_kind_createdAt_idx" ON "extraction_runs"("kind", "createdAt");
