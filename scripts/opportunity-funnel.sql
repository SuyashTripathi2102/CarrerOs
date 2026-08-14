-- THE OPPORTUNITY FUNNEL — where do 20,671 jobs become 7?
--
--   docker exec -i careeros-postgres-1 psql -U careeros -d careeros -f - \
--     < scripts/opportunity-funnel.sql
--
-- Every stage is a STRICT SUBSET of the one above it, so each drop is a real
-- loss with a real cause. Run it whenever "why so few jobs?" comes up again;
-- it answers with a number instead of a theory.
--
-- Pipeline constants it mirrors (matching.service.ts):
--   MIN_SIMILARITY          0.45   below this, no LLM spend
--   RECONCILE_MAX_AGE_DAYS  45     older listings are overwhelmingly zombies
--   SIMILARITY_TOP_K        40     candidates pulled per matching run
--   LLM_SCORE_TOP_N         15     deeply scored per matching run

\set rv '\'cmsq6ub49000jf5bwdz8dgwpu\''

\echo '=== THE FUNNEL — each stage a strict subset of the one above ==='
WITH re AS (SELECT vector FROM resume_embeddings WHERE "resumeVersionId" = :rv),
base AS (
  SELECT j.id, j.status, j.country, j."workMode",
         COALESCE(j."postedAt", j."firstSeenAt") AS effective_date,
         e."jobId" IS NOT NULL AS embedded,
         CASE WHEN e."jobId" IS NOT NULL
              THEN 1 - (e.vector <=> (SELECT vector FROM re)) END AS similarity,
         c."jobId" IS NOT NULL AS classified,
         m."decidedAt" IS NOT NULL AS decided,
         m.verdict, m."verdictCode"
  FROM jobs j
  LEFT JOIN job_embeddings e ON e."jobId" = j.id
  LEFT JOIN job_classifications c ON c."jobId" = j.id
  LEFT JOIN job_matches m ON m."jobId" = j.id AND m."resumeVersionId" = :rv
),
f AS (
  SELECT
    count(*)                                                              AS s1_discovered,
    count(*) FILTER (WHERE status = 'ACTIVE')                             AS s2_active,
    count(*) FILTER (WHERE status = 'ACTIVE'
                       AND (country = 'IN' OR "workMode" = 'REMOTE'))     AS s3_target_market,
    count(*) FILTER (WHERE status = 'ACTIVE'
                       AND (country = 'IN' OR "workMode" = 'REMOTE')
                       AND now()::date - effective_date::date <= 45)      AS s4_fresh,
    count(*) FILTER (WHERE status = 'ACTIVE'
                       AND (country = 'IN' OR "workMode" = 'REMOTE')
                       AND now()::date - effective_date::date <= 45
                       AND embedded)                                      AS s5_embedded,
    count(*) FILTER (WHERE status = 'ACTIVE'
                       AND (country = 'IN' OR "workMode" = 'REMOTE')
                       AND now()::date - effective_date::date <= 45
                       AND embedded AND similarity >= 0.45)               AS s6_retrievable,
    count(*) FILTER (WHERE status = 'ACTIVE'
                       AND (country = 'IN' OR "workMode" = 'REMOTE')
                       AND now()::date - effective_date::date <= 45
                       AND embedded AND similarity >= 0.45
                       AND classified)                                    AS s7_classified,
    count(*) FILTER (WHERE status = 'ACTIVE'
                       AND (country = 'IN' OR "workMode" = 'REMOTE')
                       AND now()::date - effective_date::date <= 45
                       AND embedded AND similarity >= 0.45
                       AND decided)                                       AS s8_deep_scored,
    count(*) FILTER (WHERE status = 'ACTIVE' AND decided AND verdict = 'CONSIDER') AS s9_consider,
    count(*) FILTER (WHERE status = 'ACTIVE' AND decided AND verdict = 'APPLY')    AS s10_apply
  FROM base
)
SELECT stage, jobs, lost_here, pct_of_previous FROM (
  SELECT 1 AS n, '1. discovered (all time)'      AS stage, s1_discovered AS jobs, NULL::bigint AS lost_here, NULL::numeric AS pct_of_previous FROM f
  UNION ALL SELECT 2, '2. status = ACTIVE',        s2_active,       s1_discovered - s2_active,   round(100.0*s2_active/NULLIF(s1_discovered,0),1) FROM f
  UNION ALL SELECT 3, '3. India or remote',        s3_target_market,s2_active - s3_target_market,round(100.0*s3_target_market/NULLIF(s2_active,0),1) FROM f
  UNION ALL SELECT 4, '4. fresh (<= 45 days)',     s4_fresh,        s3_target_market - s4_fresh, round(100.0*s4_fresh/NULLIF(s3_target_market,0),1) FROM f
  UNION ALL SELECT 5, '5. embedded',               s5_embedded,     s4_fresh - s5_embedded,      round(100.0*s5_embedded/NULLIF(s4_fresh,0),1) FROM f
  UNION ALL SELECT 6, '6. similarity >= 0.45',     s6_retrievable,  s5_embedded - s6_retrievable,round(100.0*s6_retrievable/NULLIF(s5_embedded,0),1) FROM f
  UNION ALL SELECT 7, '7. role classified',        s7_classified,   s6_retrievable - s7_classified, round(100.0*s7_classified/NULLIF(s6_retrievable,0),1) FROM f
  UNION ALL SELECT 8, '8. deep scored (decided)',  s8_deep_scored,  s7_classified - s8_deep_scored, round(100.0*s8_deep_scored/NULLIF(s7_classified,0),1) FROM f
  UNION ALL SELECT 9, '9. verdict CONSIDER',       s9_consider,     NULL,                        NULL FROM f
  UNION ALL SELECT 10,'10. verdict APPLY',         s10_apply,       NULL,                        NULL FROM f
) x ORDER BY n;

\echo ''
\echo '=== THE DECISIVE SPLIT — of everything eligible, what was ever LOOKED AT? ==='
-- This separates "we judged it and said no" from "we never got to it".
-- The second is not a rejection; it is an unopened envelope.
WITH re AS (SELECT vector FROM resume_embeddings WHERE "resumeVersionId" = :rv)
SELECT
  count(*)                                                     AS eligible_pool,
  count(*) FILTER (WHERE m."decidedAt" IS NOT NULL)            AS judged,
  count(*) FILTER (WHERE m."decidedAt" IS NULL)                AS never_looked_at,
  round(100.0 * count(*) FILTER (WHERE m."decidedAt" IS NULL) / NULLIF(count(*),0), 1)
                                                               AS pct_never_looked_at
FROM jobs j
JOIN job_embeddings e ON e."jobId" = j.id
CROSS JOIN re
LEFT JOIN job_matches m ON m."jobId" = j.id AND m."resumeVersionId" = :rv
WHERE j.status = 'ACTIVE'
  AND (j.country = 'IN' OR j."workMode" = 'REMOTE')
  AND now()::date - COALESCE(j."postedAt", j."firstSeenAt")::date <= 45
  AND 1 - (e.vector <=> re.vector) >= 0.45;

\echo ''
\echo '=== WHY jobs were rejected (of those actually judged) ==='
SELECT COALESCE("verdictCode",'(no code)') AS reason, count(*),
       round(avg("opportunityScore")::numeric,1) AS avg_score
FROM job_matches WHERE "resumeVersionId" = :rv AND "decidedAt" IS NOT NULL
GROUP BY 1 ORDER BY 2 DESC;

\echo ''
\echo '=== EVALUATION CADENCE — when did judging actually happen? ==='
-- Discovery has repeatable jobs (refresh-all 15m, discovery-fanout 10m,
-- jooble-daily). If this shows sporadic bursts rather than a steady rate,
-- evaluation is running on manual triggers, not on a schedule.
SELECT date_trunc('hour', "decidedAt") AS hour, count(*) AS decided
FROM job_matches WHERE "decidedAt" > now() - interval '7 days'
GROUP BY 1 ORDER BY 1 DESC LIMIT 15;

\echo ''
\echo '=== CONVERSION (Track A) — only real once you start using /today ==='
SELECT
  count(*) FILTER (WHERE type='SHOWN')    AS shown,
  count(*) FILTER (WHERE type='CLICKED')  AS clicked,
  count(*) FILTER (WHERE type='APPLIED')  AS applied,
  count(*) FILTER (WHERE type='DISMISSED')AS dismissed
FROM opportunity_events;
