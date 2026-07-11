-- Referral Engine: people who could refer the user into a company, discovered
-- from PUBLIC sources only (GitHub). publicEmail is stored only when the person
-- published it themselves. `draft` is user-reviewed-and-sent — never auto-sent,
-- never bulk. `status` is the seed of a referral CRM.
CREATE TABLE "referral_contacts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobId" TEXT,
    "companyId" TEXT,
    "companyName" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'GITHUB',
    "name" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "profileUrl" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "bio" TEXT,
    "location" TEXT,
    "publicEmail" TEXT,
    "blogUrl" TEXT,
    "twitter" TEXT,
    "role" TEXT NOT NULL,
    "signals" JSONB,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL,
    "draft" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SUGGESTED',
    "contactedAt" TIMESTAMP(3),
    "repliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_contacts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "referral_contacts_userId_companyName_handle_key" ON "referral_contacts"("userId", "companyName", "handle");
CREATE INDEX "referral_contacts_userId_companyName_idx" ON "referral_contacts"("userId", "companyName");
CREATE INDEX "referral_contacts_userId_status_idx" ON "referral_contacts"("userId", "status");

ALTER TABLE "referral_contacts" ADD CONSTRAINT "referral_contacts_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "referral_contacts" ADD CONSTRAINT "referral_contacts_jobId_fkey"
    FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
