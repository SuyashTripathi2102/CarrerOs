-- Cross-source job identity + provenance.
--   source      — the ingest source of record, for source-trust scoring + metrics
--   fingerprint — sha256(companyId + normalized title + location + workMode), so the
--                 same opening from Adzuna/Jooble/career-page collapses onto one row
-- Both nullable + backfilled forward: existing rows acquire them on the next crawl
-- update (ON CONFLICT sets fingerprint/source), no heavy backfill needed.
ALTER TABLE "jobs" ADD COLUMN "source" TEXT;
ALTER TABLE "jobs" ADD COLUMN "fingerprint" TEXT;

-- The pre-insert collapse query: "does this company already hold this fingerprint
-- under a different externalId?"
CREATE INDEX "jobs_companyId_fingerprint_idx" ON "jobs"("companyId", "fingerprint");
