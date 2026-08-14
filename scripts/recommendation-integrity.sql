-- RECOMMENDATION INTEGRITY — does what the user is shown match what the
-- decision engine actually decided?
--
--   docker exec -i careeros-postgres-1 psql -U careeros -d careeros -f - \
--     < scripts/recommendation-integrity.sql
--
-- Run BEFORE and AFTER any change to the surface/decision boundary. The number
-- that must go to zero is §2: jobs presented as "Apply" that the eligibility
-- gate explicitly refused.
--
-- Context (2026-08-14 audit): CareerOS had two functions both named
-- "Opportunity Score" — a 10-module persisted decision engine (ADR-10,
-- opportunity.service.ts, 2026-07-07) and a 7-signal additive surface score
-- (opportunity-score.ts, 2026-07-26) that ran no eligibility gate. /today and
-- /browse rendered the second one, so a job refused as TARGET_ROLE_TOO_SENIOR
-- could be displayed as "Apply — Opportunity 71".

\set resume_version '\'cmsq6ub49000jf5bwdz8dgwpu\''

-- ─────────────────────────────────────────────────────────────────────────────
-- NOTE (2026-08-15): §1 and §2 replicate the PRE-FIX surface algorithm on
-- purpose. They are the regression check: after the fix, browseByFit filters
-- REFUSED states and orders evaluated jobs first, so the live surface no longer
-- behaves like this. If these numbers ever describe production again, the fix
-- has been reverted. Live verification of the current contract is in
-- recommendation-state.spec.ts plus the /api/matches/browse state counts.
-- ─────────────────────────────────────────────────────────────────────────────

\echo '=== 1. [PRE-FIX ALGORITHM] surface feed composition — regression check ==='
-- Replicates the old browseByFit: top-200 by cosine, re-ranked by the additive
-- surface score, sliced to 100. Grouped by what the decision engine said.
WITH re AS (SELECT vector FROM resume_embeddings WHERE "resumeVersionId" = :resume_version),
cand AS (
  SELECT j.id, m."verdictCode", m.verdict,
         (1 - (je.vector <=> re.vector)) * 100 AS fit,
         GREATEST(0, EXTRACT(day FROM now() - j."firstSeenAt")) AS age
  FROM job_embeddings je
  JOIN jobs j ON j.id = je."jobId" AND j.status = 'ACTIVE'
  CROSS JOIN re
  LEFT JOIN job_matches m ON m."jobId" = j.id AND m."resumeVersionId" = :resume_version
  WHERE (j.country = 'IN' OR j."workMode" = 'REMOTE')
  ORDER BY je.vector <=> re.vector
  LIMIT 200
),
scored AS (
  SELECT *, LEAST(68, GREATEST(0, ((fit - 55) / 35) * 68))
    + CASE WHEN age <= 1 THEN 12 WHEN age <= 3 THEN 9 WHEN age <= 7 THEN 5
           WHEN age > 45 THEN -8 WHEN age > 21 THEN -4 ELSE 0 END AS surface
  FROM cand
)
SELECT COALESCE("verdictCode", '(never evaluated)') AS decision_engine_said,
       count(*) AS shown_in_top_100
FROM (SELECT * FROM scored ORDER BY surface DESC LIMIT 100) t
GROUP BY 1 ORDER BY 2 DESC;

\echo ''
\echo '=== 2. ⛔ THE INTEGRITY VIOLATION — refused jobs shown as actionable ==='
-- Must be ZERO. A job the gate refused must never reach the user as "Apply".
WITH re AS (SELECT vector FROM resume_embeddings WHERE "resumeVersionId" = :resume_version),
cand AS (
  SELECT j.id, m."verdictCode",
         (1 - (je.vector <=> re.vector)) * 100 AS fit,
         GREATEST(0, EXTRACT(day FROM now() - j."firstSeenAt")) AS age
  FROM job_embeddings je
  JOIN jobs j ON j.id = je."jobId" AND j.status = 'ACTIVE'
  CROSS JOIN re
  LEFT JOIN job_matches m ON m."jobId" = j.id AND m."resumeVersionId" = :resume_version
  WHERE (j.country = 'IN' OR j."workMode" = 'REMOTE')
  ORDER BY je.vector <=> re.vector
  LIMIT 200
),
scored AS (
  SELECT *, LEAST(68, GREATEST(0, ((fit - 55) / 35) * 68))
    + CASE WHEN age <= 1 THEN 12 WHEN age <= 3 THEN 9 WHEN age <= 7 THEN 5
           WHEN age > 45 THEN -8 WHEN age > 21 THEN -4 ELSE 0 END AS surface
  FROM cand
), top AS (SELECT * FROM scored ORDER BY surface DESC LIMIT 100)
SELECT
  count(*) FILTER (WHERE "verdictCode" IN
    ('TARGET_ROLE_TOO_SENIOR','NOT_DEVELOPMENT','DEVELOPMENT_WRONG_SPECIALIZATION',
     'TARGET_ROLE_BELOW_LEVEL','LOW_CODING_RESPONSIBILITY','CORE_STACK_MISMATCH'))
                                                    AS gate_refused_but_shown,
  count(*) FILTER (WHERE "verdictCode" IS NULL)     AS never_evaluated_but_shown,
  count(*) FILTER (WHERE "verdictCode" = 'TARGET_ROLE_ELIGIBLE') AS actually_eligible
FROM top;

\echo ''
\echo '=== 3. HIDDEN WINNERS — evaluated APPLY jobs the surface pool excludes ==='
-- The inverse failure: the decision engine approved these, but they sit below
-- the surface pool cutoff and are invisible. Deep retrieval reaches
-- MIN_SIMILARITY=0.45, so evaluation was never the constraint — display was.
WITH re AS (SELECT vector FROM resume_embeddings WHERE "resumeVersionId" = :resume_version),
cutoff AS (
  SELECT min(1 - (je.vector <=> re.vector)) AS c
  FROM (SELECT je.vector FROM job_embeddings je
        JOIN jobs j ON j.id = je."jobId" AND j.status = 'ACTIVE'
        CROSS JOIN re WHERE (j.country = 'IN' OR j."workMode" = 'REMOTE')
        ORDER BY je.vector <=> (SELECT vector FROM re) LIMIT 200) je
  CROSS JOIN re
)
SELECT round((SELECT c FROM cutoff)::numeric, 4) AS surface_pool_cutoff,
       count(*) AS apply_jobs_total,
       count(*) FILTER (WHERE (1 - (je.vector <=> re.vector)) < (SELECT c FROM cutoff))
                                                    AS apply_jobs_below_cutoff
FROM job_matches m
JOIN jobs j ON j.id = m."jobId" AND j.status = 'ACTIVE'
JOIN job_embeddings je ON je."jobId" = j.id
CROSS JOIN re
WHERE m.verdict = 'APPLY' AND m."resumeVersionId" = :resume_version;

\echo ''
\echo '=== 4. EVALUATION COVERAGE — how much of the pool has a real decision ==='
-- Determines whether gating the surface on verdicts would empty it. This is
-- the honest argument for a POTENTIAL MATCH state rather than hiding the rest.
SELECT
  count(*) AS active_jobs,
  count(m."jobId") AS evaluated,
  round(100.0 * count(m."jobId") / NULLIF(count(*), 0), 2) AS pct_evaluated,
  count(*) FILTER (WHERE m.verdict = 'APPLY')    AS apply,
  count(*) FILTER (WHERE m.verdict = 'CONSIDER') AS consider,
  count(*) FILTER (WHERE m.verdict = 'SKIP')     AS skip
FROM jobs j
LEFT JOIN job_matches m ON m."jobId" = j.id AND m."resumeVersionId" = :resume_version
WHERE j.status = 'ACTIVE';

\echo ''
\echo '=== 5. PLACEHOLDER SCORES — gate refusals stored as resumeFit 0 ==='
-- `overallScore = 0` on a gate-refused job means "never LLM-scored", not
-- "0% match". The verdict is right; the score is meaningless. Reporting these
-- as real scores would repeat the UNKNOWN != LOW mistake.
SELECT "verdictCode", count(*),
       round(avg("opportunityScore")::numeric, 1) AS avg_stored_score
FROM job_matches
WHERE "overallScore" = 0
GROUP BY 1 ORDER BY 2 DESC;

\echo ''
\echo '=== 6. UNNORMALIZED COUNTRY — India jobs invisible to every surface ==='
-- Found 2026-08-15 while verifying the fix: an evaluated APPLY job (77.3) was
-- still missing from the feed because its country is the string 'India', not
-- the ISO code 'IN', and it is not flagged REMOTE — so it fails the geography
-- filter `(country = 'IN' OR workMode = 'REMOTE')` everywhere.
--
-- SEPARATE, PRE-EXISTING BUG. Not caused by, and not fixed by, the
-- recommendation-integrity work. It is an ingest/normalization issue and is
-- recorded here so the count is tracked rather than rediscovered.
SELECT country, count(*) AS invisible_jobs
FROM jobs
WHERE status = 'ACTIVE'
  AND country IS NOT NULL
  AND country <> 'IN'
  AND country ~* 'india'
  AND ("workMode" IS DISTINCT FROM 'REMOTE')
GROUP BY 1 ORDER BY 2 DESC;
