-- PIPELINE HEALTH — the permanent operational metric.
--
--   docker exec -i careeros-postgres-1 psql -U careeros -d careeros -f - \
--     < scripts/pipeline-health.sql
--
-- Answers one question: **how quickly does a newly discovered job become a
-- ranked opportunity?** Every stage below is a place a job can stall.
--
--     discovered -> embedded -> retrieved -> classified -> scored -> APPLY
--
-- Read it top-down. The first stage whose backlog is growing is the
-- bottleneck; every stage after it is being starved, and speeding those up
-- spends money without moving the north star.
--
-- HONEST FRAMING: an unembedded job is NOT a missed opportunity. It is a job
-- that has not yet entered the decision pipeline. Some fraction are senior,
-- non-engineering, wrong geography, or stale. We learn how many mattered only
-- after they are embedded and judged. Never report the backlog as "lost jobs".

\echo '=== 1. STAGE COVERAGE — where the corpus actually sits ==='
SELECT
  count(*)                                                          AS active_jobs,
  count(e."jobId")                                                  AS embedded,
  round(100.0 * count(e."jobId") / NULLIF(count(*), 0), 1)          AS pct_embedded,
  count(*) - count(e."jobId")                                       AS awaiting_embedding,
  count(c."jobId")                                                  AS classified,
  round(100.0 * count(c."jobId") / NULLIF(count(*), 0), 1)          AS pct_classified
FROM jobs j
LEFT JOIN job_embeddings e     ON e."jobId" = j.id
LEFT JOIN job_classifications c ON c."jobId" = j.id
WHERE j.status = 'ACTIVE';

\echo ''
\echo '=== 2. DISCOVERY -> EMBEDDED LATENCY (p50 / p95) ==='
-- The stage the 2026-08-13 audit identified as binding. p95 matters more than
-- the mean: a good average hides a tail of jobs that never get judged while
-- they are still open.
SELECT
  count(*)                                                                    AS embedded_last_7d,
  round((percentile_cont(0.50) WITHIN GROUP (
    ORDER BY EXTRACT(epoch FROM e."createdAt" - j."firstSeenAt") / 3600))::numeric, 2) AS p50_hours,
  round((percentile_cont(0.95) WITHIN GROUP (
    ORDER BY EXTRACT(epoch FROM e."createdAt" - j."firstSeenAt") / 3600))::numeric, 2) AS p95_hours,
  round((max(EXTRACT(epoch FROM e."createdAt" - j."firstSeenAt")) / 86400)::numeric, 2) AS worst_days
FROM job_embeddings e
JOIN jobs j ON j.id = e."jobId"
WHERE e."createdAt" > now() - interval '7 days';

\echo ''
\echo '=== 3. EMBEDDING THROUGHPUT vs INTAKE — is the gap closing? ==='
-- The decisive comparison for the 24h experiment. produced >= arrived means
-- the backlog drains on its own and needs no intervention.
WITH arrived AS (
  SELECT date_trunc('hour', "firstSeenAt") AS h, count(*) AS n
  FROM jobs WHERE "firstSeenAt" > now() - interval '24 hours' GROUP BY 1
), produced AS (
  SELECT date_trunc('hour', "createdAt") AS h, count(*) AS n
  FROM job_embeddings WHERE "createdAt" > now() - interval '24 hours' GROUP BY 1
)
SELECT
  COALESCE(a.h, p.h) AS hour,
  COALESCE(a.n, 0)   AS jobs_arrived,
  COALESCE(p.n, 0)   AS embeddings_produced,
  COALESCE(p.n, 0) - COALESCE(a.n, 0) AS net_drain
FROM arrived a FULL OUTER JOIN produced p ON a.h = p.h
ORDER BY 1 DESC LIMIT 24;

\echo ''
\echo '=== 4. BACKLOG AGE — are unembedded jobs still worth embedding? ==='
-- A backlog of jobs already past their freshness window is not urgent; a
-- backlog of jobs posted today is.
SELECT
  count(*) AS awaiting_embedding,
  count(*) FILTER (WHERE now()::date - COALESCE(j."postedAt", j."firstSeenAt")::date <=  7) AS age_0_7d,
  count(*) FILTER (WHERE now()::date - COALESCE(j."postedAt", j."firstSeenAt")::date BETWEEN 8 AND 14) AS age_8_14d,
  count(*) FILTER (WHERE now()::date - COALESCE(j."postedAt", j."firstSeenAt")::date > 14) AS age_over_14d,
  round(avg(now()::date - COALESCE(j."postedAt", j."firstSeenAt")::date)::numeric, 1) AS avg_age_days
FROM jobs j
LEFT JOIN job_embeddings e ON e."jobId" = j.id
WHERE j.status = 'ACTIVE' AND e."jobId" IS NULL;

\echo ''
\echo '=== 5. fresh actionable opportunities/day (UN-INVALIDATED 2026-08-23) ==='
-- UN-INVALIDATED 2026-08-23. The two-competing-scores bug that invalidated
-- this number is fixed: /browse, /today and Telegram all derive state from the
-- persisted decision, refused jobs are filtered before sorting, and an
-- unevaluated job renders as a pending STATE with no score. Evidence in
-- docs/CAREEROS_2_ROADMAP.md, 'Reconciliation, 2026-08-23'.
--
-- CONDITION: this counts DECISIONS, not what the user can see. browseByFit's
-- pool is capped at 72 and ordered by cosine WITHIN evaluated jobs, so on
-- 2026-08-23 only 4 of 60 APPLY jobs could reach /today -- and the 56 outside
-- averaged a HIGHER opportunity score. Report this beside
-- phase0_daily_baseline.surfaceable_apply. Never substitute one for the other.
-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ INVALIDATED — score/surface divergence. Do NOT quote as the KPI.         │
-- └──────────────────────────────────────────────────────────────────────────┘
-- This counts job_matches.verdict='APPLY' — the persisted deep decision. But
-- /today and /browse do not read job_matches; they render `browseByFit`'s live
-- 7-input score. Measured 2026-08-14: 7 of the 9 stored-APPLY jobs (78.3–92.1)
-- were absent from the top-100 surface feed, while /today's #2 card
-- ("Apply — Opportunity 71") held a stored verdict of SKIP at 16.9.
--
-- So this query describes jobs the user largely never sees. It is retained as
-- evidence, not deleted, and stays invalid as the operational KPI until the
-- surface and decision layers are unified. The eventual metric is a staged
-- funnel (discovered → eligible → evaluated → APPLY surfaced → clicked →
-- tailored → applied → interview), not a single number.
-- NOT jobs discovered, embedded, classified, or scored. The only number that
-- tracks the product goal: opportunities the user could act on today.
--
--   ACTIVE + current classifier + APPLY verdict + posted within 14 days
--
-- verdict='APPLY' and opportunityScore>=70 are DIFFERENT metrics and are
-- reported separately here on purpose — conflating them has inflated this
-- figure three times already.
-- TIME-ANCHORING: freshness is measured against `decidedAt`, NOT now(). A
-- past day's number must never change when this is re-run later. Anchoring on
-- now() would silently shrink every historical day as jobs age, and the
-- `status='ACTIVE'` join would retroactively erase days when a job is later
-- marked REMOVED — making a 5-day baseline drift underneath us.
SELECT
  date_trunc('day', m."decidedAt")::date AS day,
  count(*) FILTER (WHERE m.verdict = 'APPLY')            AS apply_verdicts,
  count(*) FILTER (WHERE m."opportunityScore" >= 70)     AS score_70_plus,
  count(*) FILTER (WHERE m.verdict = 'APPLY'
                     AND m."decidedAt"::date
                         - COALESCE(j."postedAt", j."firstSeenAt")::date <= 14)
                                                          AS fresh_actionable
FROM job_matches m
JOIN jobs j ON j.id = m."jobId"
WHERE m."decidedAt" > now() - interval '14 days'
GROUP BY 1 ORDER BY 1 DESC;

\echo ''
\echo '=== 6. ACTIONABLE RIGHT NOW — what /today should be showing ==='
SELECT
  count(*) FILTER (WHERE m.verdict = 'APPLY')        AS apply_total,
  count(*) FILTER (WHERE m.verdict = 'APPLY'
                     AND now()::date - COALESCE(j."postedAt", j."firstSeenAt")::date <= 14)
                                                      AS apply_fresh,
  count(*) FILTER (WHERE m.verdict = 'CONSIDER')     AS consider_total
FROM job_matches m
JOIN jobs j ON j.id = m."jobId"
WHERE j.status = 'ACTIVE';
