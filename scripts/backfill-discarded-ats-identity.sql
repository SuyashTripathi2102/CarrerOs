-- Restore ATS identities that applyResult proved and then discarded.
--
-- Until 2026-08-22 the ATS identity was written ONLY when the provider was
-- CRAWLABLE, so a probe that logged "ATS from career page: DARWINBOX/clevertap"
-- still left atsProvider=UNKNOWN. The evidence survives in
-- confidenceSignals.probeLog, so it is recoverable.
--
-- SCOPE: only rows at CAREER_PAGE_FOUND. The UNRESOLVABLE ones reached that
-- stage through the duplicate-claim path — their board belongs to another
-- company row — and must NOT be given an identity that would collide.
--
-- Rappi is excluded by the validation gate below: its logged identifier is the
-- legacy two-part Workday form (`rappi/es`), which predates the tenant/dc/site
-- fix and cannot be parsed. It is left for the 7-day re-probe to resolve
-- correctly rather than restored wrong.
--
-- Reversible via _discovery_source_backup-style snapshot below.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS _ats_identity_backup (
  company_id text PRIMARY KEY,
  old_provider text,
  old_identifier text,
  new_provider text,
  new_identifier text,
  backed_up_at timestamptz NOT NULL DEFAULT now()
);

CREATE TEMP TABLE _recover ON COMMIT DROP AS
SELECT id,
       substring("confidenceSignals"->>'probeLog' from 'ATS from [^:]+: ([A-Z_]+)/')   AS prov,
       substring("confidenceSignals"->>'probeLog' from 'ATS from [^:]+: [A-Z_]+/([^"]+)') AS ident
FROM companies
WHERE "aliasOfId" IS NULL
  AND "atsProvider" = 'UNKNOWN'
  AND "discoveryStage" = 'CAREER_PAGE_FOUND'
  AND "confidenceSignals"::text LIKE '%ATS from%';

-- Validation gate: drop anything whose identifier is malformed, and any Workday
-- id not in the tenant/dc/site form. A wrong identifier is worse than UNKNOWN —
-- it produces confident crawls against a board that does not exist.
DELETE FROM _recover
WHERE prov IS NULL OR ident IS NULL OR ident = '' OR ident LIKE '% %'
   OR (prov = 'WORKDAY' AND ident !~ '^[^/]+/wd[0-9]+/[^/]+');

\echo '--- what will be restored ---'
SELECT c.name, r.prov AS provider, r.ident AS identifier
FROM _recover r JOIN companies c ON c.id = r.id ORDER BY r.prov, c.name;

INSERT INTO _ats_identity_backup (company_id, old_provider, old_identifier, new_provider, new_identifier)
SELECT r.id, 'UNKNOWN', NULL, r.prov, r.ident FROM _recover r
ON CONFLICT (company_id) DO NOTHING;

UPDATE companies c
SET "atsProvider" = r.prov::"AtsProvider", "atsIdentifier" = r.ident
FROM _recover r
WHERE c.id = r.id
  -- Never claim a board another company already owns.
  AND NOT EXISTS (
    SELECT 1 FROM companies o
    WHERE o."atsProvider" = r.prov::"AtsProvider" AND o."atsIdentifier" = r.ident AND o.id <> c.id
  );

COMMIT;

\echo ''
\echo '--- after ---'
SELECT name, "atsProvider", "atsIdentifier", "discoveryStage"
FROM companies WHERE id IN (SELECT company_id FROM _ats_identity_backup) ORDER BY name;
