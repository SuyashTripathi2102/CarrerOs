-- ADR-11: company identity — names propose, ATS tenancy confirms.
--
-- Fingerprint dedup keys on companyId, so a company existing under two names
-- becomes two companies and its jobs, hiring velocity, referrals and outcomes
-- split between them. Measured 2026-08-15: 7 alias groups across 307 jobs, the
-- worst being even splits (Zensar 11/11, JPMorganChase 7/7) that halve every
-- company-level signal.
--
-- NON-DESTRUCTIVE BY DESIGN. jobs.companyId is never rewritten. A duplicate row
-- points at its canonical company through aliasOfId and consumers resolve
-- through it, so a merge is reversible — which matters because over-merging is
-- the unrecoverable failure this ADR exists to prevent.

ALTER TABLE "companies" ADD COLUMN "aliasOfId" TEXT;
ALTER TABLE "companies" ADD COLUMN "aliasConfidence" TEXT;
ALTER TABLE "companies" ADD COLUMN "identityToken" TEXT;
ALTER TABLE "companies" ADD COLUMN "sourceSlug" TEXT;

ALTER TABLE "companies"
  ADD CONSTRAINT "companies_aliasOfId_fkey"
  FOREIGN KEY ("aliasOfId") REFERENCES "companies"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "companies_aliasOfId_idx" ON "companies"("aliasOfId");
CREATE INDEX "companies_identityToken_idx" ON "companies"("identityToken");

-- A canonical company may not itself be an alias: one hop, no chains. Without
-- this, A->B->C lets a merge silently move a third company under a canonical it
-- was never evidenced against.
ALTER TABLE "companies"
  ADD CONSTRAINT "companies_alias_not_self" CHECK ("aliasOfId" IS NULL OR "aliasOfId" <> "id");
