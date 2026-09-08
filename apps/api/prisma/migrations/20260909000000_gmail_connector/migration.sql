-- Gmail job-alert connector (Phase 1, design doc docs/GMAIL_CONNECTOR_DESIGN.md).
-- Read-only user-authorised grant. Additive only: no existing table is altered
-- except User gaining a relation, which is not a column change.

CREATE TYPE "GmailConnectionStatus" AS ENUM ('ACTIVE', 'REVOKED', 'NEEDS_RECONSENT');

CREATE TABLE "gmail_connections" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emailAddress" TEXT NOT NULL,
    -- Encrypted at rest. Access tokens are never stored, only refreshed on
    -- demand and discarded, so a database leak cannot yield live mailbox access.
    "refreshTokenEnc" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    -- Incremental sync cursor, advanced ONLY after a batch is durably ingested.
    "historyId" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "status" "GmailConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gmail_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gmail_connections_userId_emailAddress_key"
    ON "gmail_connections"("userId", "emailAddress");
CREATE INDEX "gmail_connections_status_idx" ON "gmail_connections"("status");

ALTER TABLE "gmail_connections" ADD CONSTRAINT "gmail_connections_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Dedup layer 1 of 3: a message is parsed once, ever. Layers 2 and 3 are the
-- existing externalId and company+fingerprint dedup; no new dedup logic exists.
CREATE TABLE "gmail_messages_seen" (
    "messageId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "jobsParsed" INTEGER NOT NULL DEFAULT 0,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gmail_messages_seen_pkey" PRIMARY KEY ("messageId")
);

CREATE INDEX "gmail_messages_seen_connectionId_seenAt_idx"
    ON "gmail_messages_seen"("connectionId", "seenAt");
