-- PHASE 0 DAILY BASELINE — the ≥5-day gate's collector.
--
--   docker exec -i careeros-postgres-1 psql -U careeros -d careeros -f - \
--     < scripts/phase0-baseline.sql
--
-- Appends ONE row per calendar day. Idempotent: re-running on the same day
-- overwrites that day's row rather than creating a second one, so an accidental
-- double-run cannot invent a sixth "day".
--
-- READ-ONLY over production. It creates and writes exactly one operational
-- table and touches nothing in ingestion, matching, judging or scoring.
--
-- WHY A TABLE AND NOT A PRINTOUT: five clean days have to be COMPARED. A script
-- that prints to stdout leaves the comparison to whoever remembers to run it,
-- which is how the last baseline attempt produced no baseline.
--
-- THE FUNNEL is the roadmap's, not a generic pipeline dashboard:
--   new → India → SWE → stack → ≤3 YOE → eligible → scored → APPLY → applied
--
-- decided_apply vs surfaceable_apply
-- ---------------------------------
-- These are reported SEPARATELY and must never be summed or conflated.
--   decided_apply     the decision engine said APPLY
--   surfaceable_apply of those, how many can actually reach /today
-- browseByFit builds its pool with `ORDER BY (decidedAt IS NOT NULL) DESC,
-- opportunityScore DESC NULLS LAST, cosine LIMIT 72`. BEFORE Q2 the second key
-- was cosine, so similarity decided which APPLYs were ELIGIBLE to
-- be displayed — and cosine is not the decision. Measured 2026-08-23: 4 of 60
-- APPLY jobs were reachable; the 56 outside the pool averaged a HIGHER
-- opportunity score (83.6 vs 79.4) and included the best job in the corpus at
-- 94.5. Tracking both columns makes that gap visible every day instead of
-- leaving it to be rediscovered.

-- CREATE TABLE IF NOT EXISTS emits a NOTICE on every run after the first.
-- Harmless, but it lands on stderr and clutters five days of collector logs
-- with a line that looks like a problem and is not.
SET client_min_messages = warning;

CREATE TABLE IF NOT EXISTS phase0_daily_baseline (
  day                 date PRIMARY KEY,
  collected_at        timestamptz NOT NULL,
  -- intake
  new_jobs            int,
  new_india           int,
  -- standing corpus
  active_jobs         int,
  evaluated           int,
  -- funnel refusals (why the corpus does not convert)
  not_development     int,
  too_senior          int,
  wrong_specialization int,
  stack_mismatch      int,
  -- outcomes
  eligible            int,
  decided_apply       int,
  surfaceable_apply   int,
  decided_consider    int,
  applied_total       int,
  -- health: a day is only a baseline day if these hold
  stranded_embeddings int,
  crawls_succeeded    int,
  crawls_failed       int
);

WITH re AS (
  SELECT vector FROM resume_embeddings
  WHERE "resumeVersionId" = (
    SELECT "resumeVersionId" FROM job_matches
    GROUP BY "resumeVersionId" ORDER BY count(*) DESC LIMIT 1
  )
),
-- Replicates browseByFit's pool exactly: evaluated first, then by cosine,
-- capped at the /today limit of 24 * 3.
pool AS (
  SELECT m.verdict,
         row_number() OVER (
           -- MUST MIRROR browseByFit EXACTLY (matching.service.ts). This clause
           -- was written against the PRE-Q2 cosine ordering and was not updated
           -- when production changed on 2026-08-28, so the collector reported
           -- surfaceable_apply=3 for five days while production actually reached
           -- 50 -- a 16x under-report that made a shipped fix look inert.
           -- Change this ONLY together with browseByFit.
           ORDER BY (m."decidedAt" IS NOT NULL) DESC,
                    m."opportunityScore" DESC NULLS LAST,
                    je.vector <=> re.vector
         ) AS rn
  FROM jobs j
  JOIN job_embeddings je ON je."jobId" = j.id
  LEFT JOIN job_matches m ON m."jobId" = j.id
  CROSS JOIN re
  WHERE j.status = 'ACTIVE'
)
INSERT INTO phase0_daily_baseline VALUES (
  current_date,
  now(),
  (SELECT count(*) FROM jobs WHERE "firstSeenAt" >= current_date),
  (SELECT count(*) FROM jobs WHERE "firstSeenAt" >= current_date
     AND (country = 'IN' OR "workMode" = 'REMOTE')),
  (SELECT count(*) FROM jobs WHERE status = 'ACTIVE'),
  (SELECT count(*) FROM job_matches WHERE "decidedAt" IS NOT NULL),
  (SELECT count(*) FROM job_matches WHERE "verdictCode" = 'NOT_DEVELOPMENT'),
  (SELECT count(*) FROM job_matches WHERE "verdictCode" = 'TARGET_ROLE_TOO_SENIOR'),
  (SELECT count(*) FROM job_matches WHERE "verdictCode" = 'DEVELOPMENT_WRONG_SPECIALIZATION'),
  (SELECT count(*) FROM job_matches WHERE "verdictCode" = 'CORE_STACK_MISMATCH'),
  (SELECT count(*) FROM job_matches WHERE "verdictCode" = 'TARGET_ROLE_ELIGIBLE'),
  -- ACTIVE + embedded only, so this shares a denominator with
  -- surfaceable_apply below. Counting all matches here would flatter the ratio
  -- by including APPLYs on retired or unembedded jobs, which no surface can
  -- show either.
  (SELECT count(*) FROM job_matches m JOIN jobs j ON j.id = m."jobId"
     JOIN job_embeddings e ON e."jobId" = j.id
     WHERE m.verdict = 'APPLY' AND j.status = 'ACTIVE'),
  (SELECT count(*) FROM pool WHERE rn <= 72 AND verdict = 'APPLY'),
  (SELECT count(*) FROM job_matches m JOIN jobs j ON j.id = m."jobId"
     JOIN job_embeddings e ON e."jobId" = j.id
     WHERE m.verdict = 'CONSIDER' AND j.status = 'ACTIVE'),
  (SELECT count(*) FROM applications),
  (SELECT count(*) FROM jobs j LEFT JOIN job_embeddings e ON e."jobId" = j.id
     WHERE j.status = 'ACTIVE' AND e."jobId" IS NULL
       AND j."firstSeenAt" < now() - interval '30 minutes'),
  (SELECT count(*) FROM crawl_runs WHERE "startedAt" >= current_date AND status = 'SUCCEEDED'),
  (SELECT count(*) FROM crawl_runs WHERE "startedAt" >= current_date AND status = 'FAILED')
)
ON CONFLICT (day) DO UPDATE SET
  collected_at = EXCLUDED.collected_at,
  new_jobs = EXCLUDED.new_jobs,
  new_india = EXCLUDED.new_india,
  active_jobs = EXCLUDED.active_jobs,
  evaluated = EXCLUDED.evaluated,
  not_development = EXCLUDED.not_development,
  too_senior = EXCLUDED.too_senior,
  wrong_specialization = EXCLUDED.wrong_specialization,
  stack_mismatch = EXCLUDED.stack_mismatch,
  eligible = EXCLUDED.eligible,
  decided_apply = EXCLUDED.decided_apply,
  surfaceable_apply = EXCLUDED.surfaceable_apply,
  decided_consider = EXCLUDED.decided_consider,
  applied_total = EXCLUDED.applied_total,
  stranded_embeddings = EXCLUDED.stranded_embeddings,
  crawls_succeeded = EXCLUDED.crawls_succeeded,
  crawls_failed = EXCLUDED.crawls_failed;

\echo '=== phase0_daily_baseline ==='
SELECT day, new_jobs, new_india, evaluated, decided_apply, surfaceable_apply,
       stranded_embeddings, crawls_succeeded AS ok, crawls_failed AS fail
FROM phase0_daily_baseline ORDER BY day;
