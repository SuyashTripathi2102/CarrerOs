-- Recover jobs retired by the pre-2026-08-16 reconciliation bug.
--
-- ATTRIBUTION IS PROVABLE, not inferred. `syncCompanyJobs` is the only code
-- path that sets REMOVED, and `ingestBoardJobs` has no removal detection at
-- all. So a board-sourced job (freehire/jooble/remoteok/hn-hiring/adzuna) can
-- ONLY have been retired by a company crawl belonging to a different source --
-- exactly what guard 2 of crawl-reconciliation.ts now forbids, and in most
-- cases by a crawl that found nothing at all (guard 1).
--
-- EXCLUDED from recovery: jobs whose apply URL is live under another source.
-- Those were genuinely superseded; restoring them would duplicate a live
-- posting rather than recover a lost one.
--
-- This does NOT touch scores, verdicts, embeddings, timestamps or provenance.
-- It flips status back to ACTIVE so a future LEGITIMATE crawl can decide their
-- real fate. Recovery is a correction of an erroneous system action, not a new
-- discovery.
--
--   dry run:  psql -v apply=0 -f scripts/recover-erroneous-removals.sql
--   apply:    psql -v apply=1 -f scripts/recover-erroneous-removals.sql

\set board_sources '''freehire'',''jooble'',''remoteok'',''hn-hiring'',''adzuna'''

CREATE TEMP TABLE recoverable AS
SELECT j.id, j.source, j.title, j.url, m.verdict,
       (now()::date - COALESCE(j."postedAt", j."firstSeenAt")::date) AS age_days
FROM jobs j
LEFT JOIN job_matches m ON m."jobId" = j.id AND m."decidedAt" IS NOT NULL
WHERE j.status = 'REMOVED'
  AND j.source IN (:board_sources)
  -- not superseded by a live copy under another source
  AND NOT EXISTS (
    SELECT 1 FROM jobs l
    WHERE l.status = 'ACTIVE'
      AND l.id <> j.id
      AND lower(regexp_replace(split_part(l.url, '?', 1), '/+$', ''))
        = lower(regexp_replace(split_part(j.url, '?', 1), '/+$', ''))
  );

\echo '=== RECOVERY SCOPE ==='
SELECT source,
       count(*) AS recoverable,
       count(*) FILTER (WHERE verdict = 'APPLY') AS apply,
       count(*) FILTER (WHERE verdict = 'CONSIDER') AS consider,
       count(*) FILTER (WHERE verdict = 'SKIP') AS skip,
       count(*) FILTER (WHERE verdict IS NULL) AS never_judged,
       count(*) FILTER (WHERE age_days <= 45) AS within_45d,
       count(*) FILTER (WHERE age_days > 45) AS outside_45d
FROM recoverable GROUP BY source ORDER BY 2 DESC;

\echo ''
\echo '=== THE ACTIONABLE ONES BEING RECOVERED ==='
SELECT verdict, source, left(title, 46) AS title, age_days
FROM recoverable WHERE verdict IN ('APPLY', 'CONSIDER')
ORDER BY verdict, age_days;

\echo ''
\echo '=== EXCLUDED: superseded by a live copy elsewhere (correctly removed) ==='
SELECT count(*) AS superseded_not_recovered
FROM jobs j
WHERE j.status = 'REMOVED' AND j.source IN (:board_sources)
  AND EXISTS (
    SELECT 1 FROM jobs l
    WHERE l.status = 'ACTIVE' AND l.id <> j.id
      AND lower(regexp_replace(split_part(l.url, '?', 1), '/+$', ''))
        = lower(regexp_replace(split_part(j.url, '?', 1), '/+$', ''))
  );

\if :apply
\echo ''
\echo '=== APPLYING RECOVERY ==='
UPDATE jobs SET status = 'ACTIVE'
WHERE id IN (SELECT id FROM recoverable);

\echo '=== AFTER ==='
SELECT source, count(*) FILTER (WHERE status = 'ACTIVE') AS active,
       count(*) FILTER (WHERE status = 'REMOVED') AS removed
FROM jobs WHERE source IN (:board_sources) GROUP BY source ORDER BY 2 DESC;
\else
\echo ''
\echo '(dry run - nothing written; pass -v apply=1 to recover)'
\endif
