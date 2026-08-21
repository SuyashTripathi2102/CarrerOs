-- Resolve companies.discoverySource from the collapsed 'board' into the board
-- that ACTUALLY introduced the company.
--
-- WHY (measured 2026-08-21):
--   FreeHire share of actionable, by job source     67.1%
--   FreeHire share of actionable, by DISCOVERY      92.7%
--
-- Those are 25.6 points apart, and only the second is the real dependency. The
-- first flatters us because a company FreeHire introduced can later have its
-- jobs acquired from Greenhouse or Workday — which reads as diversification
-- while the underlying reliance is unchanged. Every source decision made on
-- the 67.1% figure was made on the wrong number.
--
-- THE EVIDENCE USED: the earliest job at a company is the crawl that first
-- brought it in. All 868 'board' companies resolve unambiguously:
--   freehire 705 · remoteok 102 · jooble 50 · hn-hiring 11
-- 'yc' rows are left alone — they are already correct, and their first job's
-- ATS source is the ACQUISITION channel, not the discovery one. That pair is
-- the distinction this whole backfill exists to preserve.
--
-- Reversible: _discovery_source_backup holds the prior value.
-- Idempotent: after a successful run no 'board' rows remain.
--
-- Usage:
--   dry run   psql -v apply=0 -f scripts/backfill-discovery-source.sql
--   apply     psql -v apply=1 -f scripts/backfill-discovery-source.sql

\set ON_ERROR_STOP on
\if :{?apply} \else \set apply 0 \endif

BEGIN;

CREATE TABLE IF NOT EXISTS _discovery_source_backup (
  company_id text PRIMARY KEY,
  old_value  text,
  new_value  text,
  backed_up_at timestamptz NOT NULL DEFAULT now()
);

CREATE TEMP TABLE _resolve ON COMMIT DROP AS
WITH first_job AS (
  SELECT DISTINCT ON (j."companyId") j."companyId" AS company_id, j.source
  FROM jobs j
  ORDER BY j."companyId", j."firstSeenAt" ASC
)
SELECT c.id AS company_id, c."discoverySource" AS old_value, f.source AS new_value
FROM companies c
JOIN first_job f ON f.company_id = c.id
WHERE c."aliasOfId" IS NULL
  AND c."discoverySource" = 'board'
  AND f.source IS NOT NULL
  AND f.source <> '';

\echo ''
\echo '--- what would change ---'
SELECT new_value AS resolved_to, count(*) AS companies FROM _resolve GROUP BY 1 ORDER BY 2 DESC;

\echo ''
\echo '--- SAFETY: any board company we could NOT resolve? (must be 0) ---'
SELECT count(*) AS unresolved
FROM companies c
WHERE c."aliasOfId" IS NULL AND c."discoverySource" = 'board'
  AND c.id NOT IN (SELECT company_id FROM _resolve);

\if :apply
  INSERT INTO _discovery_source_backup (company_id, old_value, new_value)
  SELECT company_id, old_value, new_value FROM _resolve
  ON CONFLICT (company_id) DO NOTHING;

  UPDATE companies c
  SET "discoverySource" = r.new_value
  FROM _resolve r
  WHERE c.id = r.company_id;

  \echo ''
  \echo '--- APPLIED ---'
  SELECT "discoverySource", count(*) AS companies
  FROM companies WHERE "aliasOfId" IS NULL GROUP BY 1 ORDER BY 2 DESC;
  COMMIT;
\else
  \echo ''
  \echo '--- DRY RUN, nothing written. Re-run with -v apply=1 to apply. ---'
  ROLLBACK;
\endif
