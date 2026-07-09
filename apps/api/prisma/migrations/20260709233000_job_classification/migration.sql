-- Objective, versioned job classification.
--
-- On 2026-07-09 every one of nine live recommendations was a false positive:
-- a digital-marketing analytics role reached APPLY 77 on the strength of the
-- word "JavaScript", and a technical-PM role reached APPLY 84 on the strength
-- of the words "Full Stack" in its title. Scores were computed correctly on
-- jobs that were never eligible.
--
-- This table stores what a job IS, never what it means for a given user.
-- Personal fit (target / adjacent / needs-review) is derived per user at read
-- time from their role profile, so one user's preferences can never rewrite
-- another user's facts.
CREATE TABLE "job_classifications" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "classifierVersion" INTEGER NOT NULL,
    "primaryFunction" TEXT NOT NULL,
    "roleFamily" TEXT NOT NULL,
    "specializations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "codingIntensity" TEXT NOT NULL,
    "developmentConfidence" INTEGER NOT NULL,
    "seniority" TEXT NOT NULL,
    "minimumYears" INTEGER,
    "maximumYears" INTEGER,
    "requiredSkills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "preferredSkills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "responsibilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "developmentEvidence" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "nonDevelopmentEvidence" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "classificationReason" TEXT NOT NULL,
    "classifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_classifications_pkey" PRIMARY KEY ("id")
);

-- One row per (job, classifier version): a prompt change is auditable, and
-- reclassification is selective rather than a full re-spend.
CREATE UNIQUE INDEX "job_classifications_jobId_classifierVersion_key"
  ON "job_classifications"("jobId", "classifierVersion");

CREATE INDEX "job_classifications_classifierVersion_idx"
  ON "job_classifications"("classifierVersion");

CREATE INDEX "job_classifications_primaryFunction_roleFamily_idx"
  ON "job_classifications"("primaryFunction", "roleFamily");

ALTER TABLE "job_classifications"
  ADD CONSTRAINT "job_classifications_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
