-- One active resume version per resume.
--
-- The previous migration activated every version that had produced matches,
-- which was true of both v1 and v2 — so the UI honestly showed two ACTIVE
-- resumes. Only the newest activated version may drive recommendations.
UPDATE "resume_versions" rv
SET "activatedAt" = NULL
WHERE rv."activatedAt" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "resume_versions" newer
    WHERE newer."resumeId" = rv."resumeId"
      AND newer."activatedAt" IS NOT NULL
      AND newer."versionNumber" > rv."versionNumber"
  );

-- Skill provenance. A skill the user typed in is legitimate profile data, but
-- CareerOS must never claim the submitted PDF contains it — that distinction
-- decides what resume tailoring and ATS claims are allowed to say.
ALTER TABLE "resume_versions" ADD COLUMN "manuallyAddedSkills" TEXT[] DEFAULT ARRAY[]::TEXT[];
