-- Source independence (gap A-02). READ-ONLY. Re-run after any discovery change and compare.
--
--   docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' careeros-postgres-1 \
--     psql -U careeros -d careeros -X -P pager=off < scripts/source-independence.sql
--
-- The script also guards itself: it stops at the first error (ON_ERROR_STOP), and every query runs in
-- one READ ONLY transaction that it rolls back at the end. The read-only session above is a second guard.
--
-- The question: if one source stopped tomorrow, how much of what matters would CareerOS lose?
-- Not "which source has the most rows".
--
-- Definitions
--   relevant    live + posted (or first seen) <= 30 days ago + in India + engineering title.
--               The India, title and 30-day rules are the ones /dashboard/supply uses
--               (dashboard.controller.ts). The 7-day live rule is this script's own: the dashboard
--               counts every ACTIVE row. Needs no AI.
--   live        ACTIVE and seen by a crawl in the last 7 days. "ACTIVE" alone overstates: boards never
--               retire jobs, and a page-capped ATS walk retires nothing (ingest.service.ts).
--   actionable  decided match for the active resume version with verdict APPLY or CONSIDER.
--               Depends on the AI budget, so it trails supply.
--   direct      the employer's own hiring system (an ATS crawl of that company succeeded in the last
--               7 days) or its career page.
--
-- Source groups. Every source is named; the same lists appear in sections 0b, 2 and 4.
--   direct_ats    greenhouse, lever, ashby, workday, smartrecruiters, recruitee, workable, breezy, keka
--                 (the source of each ATS adapter in apps/workers/src/adapters)
--   freehire      freehire
--   other_boards  jooble, remoteok, hn-hiring, adzuna
--   career_pages  career-page-deterministic-v1
--   aggregators   freehire + other_boards (section 2)
--   unclassified  any other source, or none. It is never counted as direct. A new source (for example
--                 Gmail alerts, A-03) stays here, listed by section 0b, until its group is decided.
--
-- Limit: ingest stores a job found by two sources ONCE, under the first source. Overlap is therefore
-- measured per employer ("is this employer also crawled directly?"). That is an upper bound on what a
-- direct crawl would recover, so "only via aggregators" is the firm part of the exposure.
--
-- Single-user: the active resume version is the primary resume's latest activated version.
\set ON_ERROR_STOP on
\pset footer off
BEGIN TRANSACTION READ ONLY;

\echo '=== 0. SNAPSHOT'
SELECT now()::timestamp(0) AS measured_at_utc,
       (SELECT rv.id FROM resume_versions rv JOIN resumes r ON r.id = rv."resumeId"
         WHERE r."isPrimary" AND rv."activatedAt" IS NOT NULL
         ORDER BY rv."versionNumber" DESC LIMIT 1) AS active_resume_version,
       (SELECT count(*) FROM jobs WHERE status = 'ACTIVE') AS active_jobs,
       (SELECT count(*) FROM jobs WHERE status = 'ACTIVE' AND "lastSeenAt" >= now() - interval '7 days') AS live_jobs;

\echo ''
\echo '=== 0b. UNCLASSIFIED SOURCES: job sources this script does not name (0 = every source is classified)'
WITH u AS (
  SELECT COALESCE(source, '(no source)') AS source, count(*) AS n,
         count(*) FILTER (WHERE status = 'ACTIVE' AND "lastSeenAt" >= now() - interval '7 days') AS live
  FROM jobs
  WHERE source IS NULL
     OR source NOT IN ('greenhouse','lever','ashby','workday','smartrecruiters','recruitee','workable','breezy','keka',
                       'freehire','jooble','remoteok','hn-hiring','adzuna','career-page-deterministic-v1')
  GROUP BY 1
)
SELECT count(*) AS unclassified_sources,
       COALESCE(sum(n), 0) AS rows,
       COALESCE(sum(live), 0) AS live_rows,
       COALESCE(string_agg(source || ' (' || n || ' rows, ' || live || ' live)', '; ' ORDER BY n DESC), 'none') AS sources
FROM u;

\echo ''
\echo '=== 1. RELEVANT SUPPLY BY SOURCE (no AI involved)'
WITH arv AS (
  SELECT rv.id FROM resume_versions rv JOIN resumes r ON r.id = rv."resumeId"
  WHERE r."isPrimary" AND rv."activatedAt" IS NOT NULL ORDER BY rv."versionNumber" DESC LIMIT 1
), judged AS (
  SELECT "jobId" FROM job_matches WHERE "resumeVersionId" = (SELECT id FROM arv) AND "decidedAt" IS NOT NULL
), rel AS (
  SELECT j.source, (jd."jobId" IS NOT NULL) AS is_judged
  FROM jobs j LEFT JOIN judged jd ON jd."jobId" = j.id
  WHERE j.status = 'ACTIVE' AND j."lastSeenAt" >= now() - interval '7 days'
    AND now()::date - COALESCE(j."postedAt", j."firstSeenAt")::date <= 30
    AND (j.country = 'IN' OR j.location ~* 'india|bengaluru|bangalore|mumbai|pune|delhi|hyderabad|chennai|noida|gurgaon|gurugram|indore|ahmedabad|kolkata')
    AND j.title ~* 'engineer|developer|sde|full.?stack|backend|node|react|software'
)
SELECT source,
       count(*) AS relevant_jobs,
       round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct_of_relevant,
       round(100.0 * count(*) FILTER (WHERE is_judged) / count(*), 0) AS pct_judged_by_ai
FROM rel GROUP BY source ORDER BY relevant_jobs DESC;

\echo ''
\echo '=== 2. EXPOSURE: relevant jobs that only an aggregator reaches'
WITH rel AS (
  SELECT j.source, COALESCE(c."aliasOfId", c.id) AS company
  FROM jobs j JOIN companies c ON c.id = j."companyId"
  WHERE j.status = 'ACTIVE' AND j."lastSeenAt" >= now() - interval '7 days'
    AND now()::date - COALESCE(j."postedAt", j."firstSeenAt")::date <= 30
    AND (j.country = 'IN' OR j.location ~* 'india|bengaluru|bangalore|mumbai|pune|delhi|hyderabad|chennai|noida|gurgaon|gurugram|indore|ahmedabad|kolkata')
    AND j.title ~* 'engineer|developer|sde|full.?stack|backend|node|react|software'
), direct_cov AS (
  SELECT DISTINCT COALESCE(c."aliasOfId", c.id) AS company
  FROM crawl_runs cr JOIN companies c ON c.id = cr."companyId"
  WHERE cr.status = 'SUCCEEDED' AND cr."startedAt" >= now() - interval '7 days'
  UNION
  SELECT DISTINCT COALESCE(c."aliasOfId", c.id)
  FROM jobs j JOIN companies c ON c.id = j."companyId"
  WHERE j.source = 'career-page-deterministic-v1' AND j.status = 'ACTIVE'
    AND j."lastSeenAt" >= now() - interval '7 days'
), tagged AS (
  SELECT r.source, r.company, (dc.company IS NOT NULL) AS direct
  FROM rel r LEFT JOIN direct_cov dc ON dc.company = r.company
)
SELECT source,
       count(*) AS relevant,
       count(*) FILTER (WHERE direct) AS employer_also_crawled_directly,
       count(*) FILTER (WHERE NOT direct) AS only_via_aggregators,
       round(100.0 * count(*) FILTER (WHERE NOT direct) / (SELECT count(*) FROM rel), 1) AS pct_of_all_relevant,
       count(DISTINCT company) AS employers,
       count(DISTINCT company) FILTER (WHERE NOT direct) AS employers_only_via_aggregators
FROM tagged
WHERE source IN ('freehire','jooble','remoteok','hn-hiring','adzuna')
GROUP BY source ORDER BY relevant DESC;

\echo ''
\echo '=== 3. WHERE FREEHIRE-ONLY RELEVANT JOBS ARE POSTED (domain of the job link), top 15'
WITH rel AS (
  SELECT j.url, COALESCE(c."aliasOfId", c.id) AS company
  FROM jobs j JOIN companies c ON c.id = j."companyId"
  WHERE j.source = 'freehire' AND j.status = 'ACTIVE' AND j."lastSeenAt" >= now() - interval '7 days'
    AND now()::date - COALESCE(j."postedAt", j."firstSeenAt")::date <= 30
    AND (j.country = 'IN' OR j.location ~* 'india|bengaluru|bangalore|mumbai|pune|delhi|hyderabad|chennai|noida|gurgaon|gurugram|indore|ahmedabad|kolkata')
    AND j.title ~* 'engineer|developer|sde|full.?stack|backend|node|react|software'
), direct_cov AS (
  SELECT DISTINCT COALESCE(c."aliasOfId", c.id) AS company
  FROM crawl_runs cr JOIN companies c ON c.id = cr."companyId"
  WHERE cr.status = 'SUCCEEDED' AND cr."startedAt" >= now() - interval '7 days'
  UNION
  SELECT DISTINCT COALESCE(c."aliasOfId", c.id)
  FROM jobs j JOIN companies c ON c.id = j."companyId"
  WHERE j.source = 'career-page-deterministic-v1' AND j.status = 'ACTIVE'
    AND j."lastSeenAt" >= now() - interval '7 days'
), h AS (
  SELECT lower(substring(r.url from '^https?://([^/:?#]+)')) AS host
  FROM rel r LEFT JOIN direct_cov dc ON dc.company = r.company WHERE dc.company IS NULL
)
SELECT CASE WHEN host ~ '\.(co|com|net|org|gov|ac)\.[a-z]{2}$' THEN substring(host from '([^.]+\.[^.]+\.[^.]+)$')
            ELSE substring(host from '([^.]+\.[^.]+)$') END AS posted_on,
       count(*) AS jobs,
       round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct
FROM h GROUP BY 1 ORDER BY 2 DESC LIMIT 15;

\echo ''
\echo '=== 4. FLOW: new actionable jobs per week by source group (first seen since Mon 2026-08-17, any status; unclassified: see 0b)'
WITH arv AS (
  SELECT rv.id FROM resume_versions rv JOIN resumes r ON r.id = rv."resumeId"
  WHERE r."isPrimary" AND rv."activatedAt" IS NOT NULL ORDER BY rv."versionNumber" DESC LIMIT 1
), act AS (
  SELECT "jobId" FROM job_matches
  WHERE "resumeVersionId" = (SELECT id FROM arv) AND "decidedAt" IS NOT NULL AND verdict IN ('APPLY','CONSIDER')
), g AS (
  SELECT date_trunc('week', j."firstSeenAt")::date AS week,
         CASE WHEN j.source IN ('greenhouse','lever','ashby','workday','smartrecruiters','recruitee','workable','breezy','keka') THEN 'direct_ats'
              WHEN j.source = 'freehire' THEN 'freehire'
              WHEN j.source IN ('jooble','remoteok','hn-hiring','adzuna') THEN 'other_boards'
              WHEN j.source = 'career-page-deterministic-v1' THEN 'career_pages'
              ELSE 'unclassified' END AS grp
  FROM jobs j JOIN act ON act."jobId" = j.id
  WHERE j."firstSeenAt" >= '2026-08-17'
)
SELECT week,
       count(*) FILTER (WHERE grp = 'freehire') AS freehire,
       count(*) FILTER (WHERE grp = 'direct_ats') AS direct_ats,
       count(*) FILTER (WHERE grp = 'career_pages') AS career_pages,
       count(*) FILTER (WHERE grp = 'other_boards') AS other_boards,
       count(*) FILTER (WHERE grp = 'unclassified') AS unclassified,
       count(*) AS total,
       round(100.0 * count(*) FILTER (WHERE grp = 'freehire') / count(*), 1) AS freehire_pct
FROM g GROUP BY week ORDER BY week;

\echo ''
\echo '=== 5. THE 2026-08-20 METHOD (share of APPLY+CONSIDER among ALL ACTIVE rows). Kept for comparison only:'
\echo '    it counts board jobs that are no longer listed, so it overstates boards.'
WITH arv AS (
  SELECT rv.id FROM resume_versions rv JOIN resumes r ON r.id = rv."resumeId"
  WHERE r."isPrimary" AND rv."activatedAt" IS NOT NULL ORDER BY rv."versionNumber" DESC LIMIT 1
), jm AS (
  SELECT "jobId", verdict FROM job_matches
  WHERE "resumeVersionId" = (SELECT id FROM arv) AND "decidedAt" IS NOT NULL
)
SELECT j.source,
       count(*) AS active_rows,
       round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct_of_rows,
       count(*) FILTER (WHERE jm.verdict IN ('APPLY','CONSIDER')) AS actionable,
       round(100.0 * count(*) FILTER (WHERE jm.verdict IN ('APPLY','CONSIDER'))
             / NULLIF(sum(count(*) FILTER (WHERE jm.verdict IN ('APPLY','CONSIDER'))) OVER (), 0), 1) AS pct_of_actionable
FROM jobs j LEFT JOIN jm ON jm."jobId" = j.id
WHERE j.status = 'ACTIVE'
GROUP BY j.source ORDER BY actionable DESC, active_rows DESC;

\echo ''
\echo '=== 6. LIVE ACTIONABLE: judged worth applying AND still listed (seen in the last 7 days)'
WITH arv AS (
  SELECT rv.id FROM resume_versions rv JOIN resumes r ON r.id = rv."resumeId"
  WHERE r."isPrimary" AND rv."activatedAt" IS NOT NULL ORDER BY rv."versionNumber" DESC LIMIT 1
)
SELECT j.source,
       count(*) AS live_actionable,
       count(*) FILTER (WHERE m.verdict = 'APPLY') AS apply,
       round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct
FROM jobs j JOIN job_matches m ON m."jobId" = j.id
WHERE m."resumeVersionId" = (SELECT id FROM arv) AND m."decidedAt" IS NOT NULL
  AND m.verdict IN ('APPLY','CONSIDER')
  AND j.status = 'ACTIVE' AND j."lastSeenAt" >= now() - interval '7 days'
GROUP BY j.source ORDER BY live_actionable DESC;

\echo ''
\echo '=== 7. STALE "ACTIVE" ROWS: not seen by any crawl in the last 7 days'
SELECT source,
       count(*) AS active_rows,
       count(*) FILTER (WHERE "lastSeenAt" >= now() - interval '7 days') AS live,
       count(*) FILTER (WHERE "lastSeenAt" < now() - interval '7 days') AS not_seen_7d,
       round(100.0 * count(*) FILTER (WHERE "lastSeenAt" < now() - interval '7 days') / count(*), 0) AS pct_stale
FROM jobs WHERE status = 'ACTIVE'
GROUP BY source ORDER BY not_seen_7d DESC;

ROLLBACK;
