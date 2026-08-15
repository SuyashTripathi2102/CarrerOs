-- Source audit (Phase 1). Run BEFORE and AFTER any discovery scale-up.
--
-- The question is never "did job count go up". It is: did unique, fresh,
-- India-relevant, evaluable opportunities go up, without fragmenting company
-- identity or importing garbage — and what did that cost?
--
--   docker exec -i careeros-postgres-1 psql -U careeros -d careeros -f - < scripts/source-audit.sql
--
-- Resume version is the active one; update if a new resume is activated.
\set rv '''cmsq6ub49000jf5bwdz8dgwpu'''
\set india_re '''india|bengaluru|bangalore|mumbai|pune|new delhi|delhi ncr|delhi|hyderabad|chennai|noida|gurgaon|gurugram|indore|kolkata|ahmedabad|jaipur|kochi|trivandrum|chandigarh'''

\echo '=== 1. PER-SOURCE SCORECARD ==='
-- `companies` counts CANONICAL companies (ADR-11 aliases resolved), so a
-- fragmented employer is not counted twice as "breadth".
WITH re AS (SELECT vector FROM resume_embeddings WHERE "resumeVersionId" = :rv),
scored AS (
  SELECT j.source, j.id,
         COALESCE(c."aliasOfId", c.id) AS canonical_company,
         (je."jobId" IS NOT NULL) AS embedded,
         (now()::date - COALESCE(j."postedAt", j."firstSeenAt")::date <= 45) AS fresh,
         (j.country = 'IN' OR j.location ~* :india_re) AS india,
         (je."jobId" IS NOT NULL
          AND now()::date - COALESCE(j."postedAt", j."firstSeenAt")::date <= 45
          AND (j.country = 'IN' OR j.location ~* :india_re)
          AND 1 - (je.vector <=> (SELECT vector FROM re)) >= 0.45) AS reachable,
         m.verdict
  FROM jobs j
  JOIN companies c ON c.id = j."companyId"
  LEFT JOIN job_embeddings je ON je."jobId" = j.id
  LEFT JOIN job_matches m ON m."jobId" = j.id AND m."decidedAt" IS NOT NULL
  WHERE j.status = 'ACTIVE'
)
SELECT source,
       count(*) AS active,
       count(DISTINCT canonical_company) AS companies,
       round(count(*)::numeric / NULLIF(count(DISTINCT canonical_company), 0), 1) AS jobs_per_company,
       round(100.0 * count(*) FILTER (WHERE india) / count(*), 1) AS india_pct,
       round(100.0 * count(*) FILTER (WHERE fresh) / count(*), 1) AS fresh_pct,
       round(100.0 * count(*) FILTER (WHERE reachable) / count(*), 1) AS reachable_pct,
       count(*) FILTER (WHERE verdict = 'APPLY') AS apply,
       count(*) FILTER (WHERE verdict = 'CONSIDER') AS consider,
       count(*) FILTER (WHERE verdict = 'NEEDS_REVIEW') AS review,
       round(1000.0 * count(*) FILTER (WHERE verdict IN ('APPLY','CONSIDER')) / count(*), 2) AS ac_per_1k
FROM scored GROUP BY source ORDER BY active DESC;

\echo ''
\echo '=== 2. COMPANY EXCLUSIVITY - which sources reach employers nobody else does ==='
WITH per_company AS (
  SELECT COALESCE(c."aliasOfId", c.id) AS company_id,
         array_agg(DISTINCT j.source) AS sources
  FROM jobs j JOIN companies c ON c.id = j."companyId"
  WHERE j.status = 'ACTIVE'
  GROUP BY 1
)
SELECT s AS source,
       count(*) AS companies,
       count(*) FILTER (WHERE array_length(sources, 1) = 1) AS exclusive_to_this_source
FROM per_company, unnest(sources) AS s
GROUP BY s ORDER BY exclusive_to_this_source DESC;

\echo ''
\echo '=== 3. COMPANY IDENTITY HEALTH (ADR-11) ==='
SELECT
  (SELECT count(*) FROM companies WHERE "aliasOfId" IS NULL) AS canonical_companies,
  (SELECT count(*) FROM companies WHERE "aliasOfId" IS NOT NULL) AS merged_aliases,
  (SELECT count(*) FROM companies WHERE "identityToken" IS NOT NULL) AS with_identity_token,
  -- Any token shared by >2 companies is a red flag: it means a host is being
  -- treated as identity when it should not be (the apply.workable.com/j bug).
  (SELECT count(*) FROM (
     SELECT "identityToken" FROM companies
     WHERE "identityToken" IS NOT NULL AND "aliasOfId" IS NULL
     GROUP BY 1 HAVING count(*) > 2) t) AS over_shared_tokens;

\echo ''
\echo '=== 4. FRESHNESS BY SOURCE ==='
SELECT source, count(*) AS active,
       round(percentile_cont(0.5) WITHIN GROUP (
         ORDER BY now()::date - COALESCE("postedAt", "firstSeenAt")::date)::numeric, 0) AS age_p50,
       round(percentile_cont(0.9) WITHIN GROUP (
         ORDER BY now()::date - COALESCE("postedAt", "firstSeenAt")::date)::numeric, 0) AS age_p90
FROM jobs WHERE status = 'ACTIVE' GROUP BY 1 ORDER BY age_p50;

\echo ''
\echo '=== 5. COST (what the corpus actually cost to evaluate) ==='
SELECT
  (SELECT count(*) FROM job_matches WHERE "decidedAt" IS NOT NULL) AS decisions,
  (SELECT round(sum("costUsd")::numeric, 2) FROM ai_usage) AS spend_all_time,
  (SELECT round((sum("costUsd") / NULLIF(
     (SELECT count(*) FROM job_matches WHERE "decidedAt" IS NOT NULL), 0))::numeric, 5)
   FROM ai_usage) AS usd_per_decision,
  (SELECT round(sum("costUsd")::numeric, 2) FROM ai_usage
   WHERE "createdAt" >= date_trunc('day', now() AT TIME ZONE 'UTC')) AS spend_today;
