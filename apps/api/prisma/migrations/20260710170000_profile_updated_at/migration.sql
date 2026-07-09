-- A resume version is not a profile.
--
-- reconcileForUser skipped any job that already had a match row for the active
-- resumeVersionId. That is correct when a NEW version is activated, and wrong
-- when the confirmed profile of an EXISTING version changes: on 2026-07-10 a
-- profile went from 14 skills to 28, activation ran, and reconciliation
-- finished in 286ms having inspected zero jobs and reported success.
--
-- Backfilled to activatedAt. A reconcile that genuinely ran leaves decidedAt
-- AFTER activatedAt, so healthy versions re-score nothing. The version this
-- migration ships to has decidedAt 19:41 and activatedAt 21:33 — evidence, in
-- the data itself, that its matches were never re-scored. They will be.
ALTER TABLE "resume_versions" ADD COLUMN "profileUpdatedAt" TIMESTAMP(3);

UPDATE "resume_versions" SET "profileUpdatedAt" = "activatedAt" WHERE "activatedAt" IS NOT NULL;
