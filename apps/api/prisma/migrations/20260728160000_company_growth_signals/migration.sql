-- Phase 5 — deterministic, corpus-wide company signals. Refreshed daily for
-- every monitored company (SQL only, no LLM), unlike the throttled LLM fields.
ALTER TABLE "company_intelligence" ADD COLUMN "growthScore" INTEGER;
ALTER TABLE "company_intelligence" ADD COLUMN "newRoles30d" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "company_intelligence" ADD COLUMN "referralContacts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "company_intelligence" ADD COLUMN "departmentsHiring" JSONB;
ALTER TABLE "company_intelligence" ADD COLUMN "lastJobAt" TIMESTAMP(3);
ALTER TABLE "company_intelligence" ADD COLUMN "signalsAt" TIMESTAMP(3);

CREATE INDEX "company_intelligence_growthScore_idx" ON "company_intelligence"("growthScore");
