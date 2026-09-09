-- Classification freshness provenance.
--
-- A description has three downstream consumers. The embedding was rebuilt when
-- it changed and the decision was re-opened, but the classification was cached
-- per (jobId, classifierVersion) and never revisited -- so a job that gained a
-- real body was re-judged against a classification whose own reasoning said the
-- description was "completely empty".
--
-- Recording what a classification was computed FROM makes that detectable
-- instead of inferable from prose.
ALTER TABLE "job_classifications" ADD COLUMN "evidenceFingerprint" TEXT;
ALTER TABLE "job_classifications" ADD COLUMN "evidenceLength" INTEGER;
