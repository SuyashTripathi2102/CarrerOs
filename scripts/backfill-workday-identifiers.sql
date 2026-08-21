-- Backfill Workday atsIdentifier from tenant/site -> tenant/dc/site.
--
-- WHY: detectAts() used to drop the datacenter, so `abb/External_Career_Page`
-- cannot be rebuilt into abb.wd3.myworkdayjobs.com and is unusable for
-- crawling. The CXS endpoint needs all three parts. Recovered from each
-- company's own job URLs, which is proven to work for 104/104.
--
-- REVERSIBLE: the original value is kept in a backup table before any write.
-- Touches ONLY companies.atsIdentifier. No job, alias, company id, verdict or
-- source row is modified.
--
--   dry run:  psql -v apply=0 -f scripts/backfill-workday-identifiers.sql
--   apply:    psql -v apply=1 -f scripts/backfill-workday-identifiers.sql
--   revert:   UPDATE companies c SET "atsIdentifier" = b.old_identifier
--               FROM _workday_identifier_backup b WHERE b.id = c.id;

\echo '=== BEFORE ==='
SELECT count(*) AS workday_companies,
       count(*) FILTER (WHERE "atsIdentifier" ~ '^[^/]+/wd[0-9]+/[^/]+$') AS already_three_part,
       count(*) FILTER (WHERE "atsIdentifier" !~ '^[^/]+/wd[0-9]+/[^/]+$') AS needs_backfill
FROM companies WHERE "atsProvider" = 'WORKDAY' AND "aliasOfId" IS NULL;

-- Proposed new value, derived from the company's most recent Workday job URL.
DROP TABLE IF EXISTS _wd_fix;
CREATE TEMP TABLE _wd_fix AS
SELECT c.id,
       c.name,
       c."atsIdentifier" AS old_identifier,
       split_part(c."atsIdentifier", '/', 1) || '/' ||
       substring(u.url from '\.(wd[0-9]+)\.myworkdayjobs') || '/' ||
       split_part(c."atsIdentifier", '/', 2) AS new_identifier
FROM companies c
JOIN LATERAL (
  SELECT j.url FROM jobs j
  WHERE j."companyId" = c.id AND j.url ~ 'wd[0-9]+\.myworkdayjobs\.com'
  ORDER BY j."firstSeenAt" DESC LIMIT 1
) u ON true
WHERE c."atsProvider" = 'WORKDAY'
  AND c."aliasOfId" IS NULL
  AND c."atsIdentifier" !~ '^[^/]+/wd[0-9]+/[^/]+$';

\echo ''
\echo '=== PROPOSED CHANGES (sample 12) ==='
SELECT name, old_identifier, new_identifier FROM _wd_fix ORDER BY name LIMIT 12;

\echo ''
\echo '=== VALIDATION — every row must parse as tenant/wdN/site ==='
SELECT count(*) AS rows_to_change,
       count(*) FILTER (WHERE new_identifier ~ '^[^/]+/wd[0-9]+/[^/]+$') AS valid,
       count(*) FILTER (WHERE new_identifier !~ '^[^/]+/wd[0-9]+/[^/]+$') AS INVALID
FROM _wd_fix;

\echo ''
\echo '=== any invalid rows (must be zero) ==='
SELECT name, old_identifier, new_identifier FROM _wd_fix
WHERE new_identifier !~ '^[^/]+/wd[0-9]+/[^/]+$';

\if :apply
\echo ''
\echo '=== APPLYING (backup first) ==='
DROP TABLE IF EXISTS _workday_identifier_backup;
CREATE TABLE _workday_identifier_backup AS
SELECT id, name, old_identifier, new_identifier, now() AS backed_up_at FROM _wd_fix;

UPDATE companies c
SET "atsIdentifier" = f.new_identifier
FROM _wd_fix f
WHERE f.id = c.id
  -- refuse to write anything that does not parse
  AND f.new_identifier ~ '^[^/]+/wd[0-9]+/[^/]+$';

\echo '=== AFTER ==='
SELECT count(*) AS workday_companies,
       count(*) FILTER (WHERE "atsIdentifier" ~ '^[^/]+/wd[0-9]+/[^/]+$') AS three_part,
       count(*) FILTER (WHERE "atsIdentifier" !~ '^[^/]+/wd[0-9]+/[^/]+$') AS still_broken
FROM companies WHERE "atsProvider" = 'WORKDAY' AND "aliasOfId" IS NULL;

\echo '=== backup rows kept for revert ==='
SELECT count(*) AS backup_rows FROM _workday_identifier_backup;
\else
\echo ''
\echo '(dry run - nothing written; pass -v apply=1 to backfill)'
\endif
