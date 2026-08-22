-- Provenance for job descriptions.
--
-- WHY (measured 2026-08-23): 6,907 ACTIVE jobs held NO description — lever
-- 3,993/5,493 (73%), breezy 2,914/2,914 (100%) — because both adapters read the
-- body from the LIST endpoint and silently defaulted to ''. The gate then
-- refused them NOT_DEVELOPMENT for "no coding responsibility stated", and every
-- source-quality figure was contaminated: breezy measured 0.2% actionable when
-- its jobs were simply unread.
--
-- Without this column "short description" and "body never fetched" are the same
-- row, and that distinction cannot be reconstructed later.
--
-- NULLABLE on purpose: rows written before today genuinely have unknown
-- provenance. Backfilling them to LIST would invent a fact — the same
-- absence-of-evidence error this whole change exists to fix.

CREATE TYPE "DescriptionSource" AS ENUM ('LIST', 'DETAIL', 'MISSING');

ALTER TABLE "jobs" ADD COLUMN "descriptionSource" "DescriptionSource";

-- Partial index: the hot query is "which jobs still need hydration", which only
-- ever looks at MISSING and NULL rows. Indexing the whole column would be
-- mostly LIST/DETAIL rows nothing scans by.
CREATE INDEX "jobs_descriptionSource_pending_idx"
  ON "jobs" ("descriptionSource")
  WHERE "descriptionSource" IS DISTINCT FROM 'DETAIL'
    AND "descriptionSource" IS DISTINCT FROM 'LIST';
