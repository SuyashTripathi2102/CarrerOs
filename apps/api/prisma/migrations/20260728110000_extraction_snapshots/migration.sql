-- HTML snapshots make the deterministic extraction pipeline REPLAYABLE: store the
-- preprocessed career-page HTML once per company, then re-run improved extractor
-- versions over it with no re-crawl. One latest snapshot per company (unique
-- companyId, replaced on each real extraction) bounds storage to ~corpus size.
CREATE TABLE "extraction_snapshots" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "extractorVersion" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL DEFAULT 0,
    "jobsAccepted" INTEGER NOT NULL DEFAULT 0,
    "candidateCount" INTEGER NOT NULL DEFAULT 0,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "replayedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "extraction_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "extraction_snapshots_companyId_key" ON "extraction_snapshots"("companyId");
CREATE INDEX "extraction_snapshots_extractorVersion_idx" ON "extraction_snapshots"("extractorVersion");
CREATE INDEX "extraction_snapshots_replayedAt_idx" ON "extraction_snapshots"("replayedAt");

ALTER TABLE "extraction_snapshots" ADD CONSTRAINT "extraction_snapshots_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
