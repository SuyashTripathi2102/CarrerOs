-- Career-page deterministic extractor bookkeeping: when a company's career page
-- was last claimed for extraction, so runs rotate through the corpus instead of
-- re-fetching the same pages, and priority ordering has a recency signal.
ALTER TABLE "companies" ADD COLUMN "lastExtractedAt" TIMESTAMP(3);
CREATE INDEX "companies_lastExtractedAt_idx" ON "companies"("lastExtractedAt");
