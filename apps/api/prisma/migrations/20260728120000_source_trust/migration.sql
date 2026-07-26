-- Per-source trust: a curated baseline nudged by observed listing quality
-- (freshness up, staleness down). Recomputed daily; feeds a bounded adjustment
-- into the Opportunity Score and the source-yield dashboard.
CREATE TABLE "source_trust" (
    "source" TEXT NOT NULL,
    "baseline" INTEGER NOT NULL DEFAULT 85,
    "trustScore" INTEGER NOT NULL DEFAULT 85,
    "jobsSeen" INTEGER NOT NULL DEFAULT 0,
    "jobsActive" INTEGER NOT NULL DEFAULT 0,
    "jobsRemoved" INTEGER NOT NULL DEFAULT 0,
    "jobsStale" INTEGER NOT NULL DEFAULT 0,
    "jobsFresh" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "source_trust_pkey" PRIMARY KEY ("source")
);
