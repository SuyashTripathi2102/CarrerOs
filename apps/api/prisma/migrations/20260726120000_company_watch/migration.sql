-- Dream Company Watchlist: companies the user actively monitors. Watching bumps
-- the company to HOT crawl tier and surfaces its open roles ranked by resume fit.
CREATE TABLE "company_watches" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_watches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "company_watches_userId_companyId_key" ON "company_watches"("userId", "companyId");
CREATE INDEX "company_watches_userId_idx" ON "company_watches"("userId");

ALTER TABLE "company_watches" ADD CONSTRAINT "company_watches_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "company_watches" ADD CONSTRAINT "company_watches_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
