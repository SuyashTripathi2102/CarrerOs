-- CreateEnum
CREATE TYPE "CrawlTier" AS ENUM ('HOT', 'WARM', 'COLD');

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "crawlTier" "CrawlTier" NOT NULL DEFAULT 'WARM',
ADD COLUMN     "nextCrawlAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Hand-edited (Prisma cannot express generated columns): full-text search
-- vector maintained by Postgres itself — no application code ever writes it.
ALTER TABLE "jobs" ADD COLUMN "search" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED;

CREATE INDEX "jobs_search_idx" ON "jobs" USING GIN ("search");

-- CreateIndex
CREATE INDEX "companies_nextCrawlAt_idx" ON "companies"("nextCrawlAt");
