-- City company-universe funnel. READ ONLY.
--
-- The measurement for the model where a COMPANY is the long-lived asset and its
-- jobs are ephemeral. Re-run this over days/weeks: the discovery fanout promotes
-- companies DISCOVERED -> WEBSITE_VERIFIED -> CAREER_PAGE_FOUND -> MONITORED on
-- a 10-minute tick, and companies that resolve to nothing are re-probed every 7
-- days rather than dropped.
--
-- Read it as a FUNNEL, not a scorecard. A city with many DISCOVERED and few
-- MONITORED has not failed — it has not been probed yet. Only compare the
-- actionable columns once `awaiting_probe` is small, or the denominator is a
-- company set the system has never actually looked at.
--
--   docker exec -i careeros-postgres-1 psql -U careeros -d careeros \
--     -f /dev/stdin < scripts/city-universe-funnel.sql
--
-- Seeded with: apps/workers/src/scripts/seed-city-universe.ts

\echo '=============== CITY UNIVERSE FUNNEL ==============='
\echo ''
\echo '--- stage distribution (where the fanout has got to) ---'
SELECT
  COALESCE(city, '(no city)')                                   AS city,
  count(*)                                                       AS companies,
  count(*) FILTER (WHERE "discoveryStage" = 'DISCOVERED')         AS awaiting_probe,
  count(*) FILTER (WHERE "discoveryStage" = 'WEBSITE_VERIFIED')   AS site_verified,
  count(*) FILTER (WHERE "discoveryStage" = 'CAREER_PAGE_FOUND')  AS career_page,
  count(*) FILTER (WHERE "discoveryStage" = 'MONITORED')          AS monitored,
  count(*) FILTER (WHERE "discoveryStage" = 'UNRESOLVABLE')       AS unresolvable
FROM companies
WHERE "discoverySource" LIKE 'city-%' AND "aliasOfId" IS NULL
GROUP BY 1 ORDER BY companies DESC;

\echo ''
\echo '--- conversion: company -> career page -> ATS -> jobs -> actionable ---'
WITH uni AS (
  SELECT c.id, c.city, c."atsProvider", c."careerPageUrl"
  FROM companies c
  WHERE c."discoverySource" LIKE 'city-%' AND c."aliasOfId" IS NULL
)
SELECT
  COALESCE(u.city, '(no city)')                                        AS city,
  count(DISTINCT u.id)                                                  AS companies,
  count(DISTINCT u.id) FILTER (WHERE u."careerPageUrl" IS NOT NULL)      AS career_page,
  count(DISTINCT u.id) FILTER (WHERE u."atsProvider" <> 'UNKNOWN')       AS ats_known,
  count(j.id) FILTER (WHERE j.status = 'ACTIVE')                         AS active_jobs,
  count(m.id)                                                            AS judged,
  count(m.id) FILTER (WHERE m.verdict IN ('APPLY', 'CONSIDER'))          AS actionable,
  -- Deliberately divided by companies WITH A BOARD, not by the whole universe:
  -- dividing by companies nothing has crawled yet measures the probe backlog,
  -- not the channel.
  round(
    count(m.id) FILTER (WHERE m.verdict IN ('APPLY', 'CONSIDER'))::numeric
    / NULLIF(count(DISTINCT u.id) FILTER (WHERE u."atsProvider" <> 'UNKNOWN'), 0),
    3
  ) AS actionable_per_crawlable_company
FROM uni u
LEFT JOIN jobs j ON j."companyId" = u.id
LEFT JOIN job_matches m ON m."jobId" = j.id
GROUP BY 1 ORDER BY companies DESC;

\echo ''
\echo '--- which ATS the universe actually runs on (adapter priority) ---'
SELECT COALESCE(c.city, '(no city)') AS city, c."atsProvider", count(*) AS companies
FROM companies c
WHERE c."discoverySource" LIKE 'city-%' AND c."aliasOfId" IS NULL
  AND c."atsProvider" <> 'UNKNOWN'
GROUP BY 1, 2 ORDER BY companies DESC;

\echo ''
\echo '--- why jobs are refused (the seed-quality signal) ---'
\echo '    NOT_DEVELOPMENT dominating = the seed is sector-diverse, not that the'
\echo '    gate is wrong. Fix by PRIORITISING companies, never by loosening it.'
SELECT m."verdictCode", count(*) AS jobs
FROM companies c
JOIN jobs j ON j."companyId" = c.id
JOIN job_matches m ON m."jobId" = j.id
WHERE c."discoverySource" LIKE 'city-%' AND c."aliasOfId" IS NULL
  AND m."verdictCode" IS NOT NULL
GROUP BY 1 ORDER BY jobs DESC;
