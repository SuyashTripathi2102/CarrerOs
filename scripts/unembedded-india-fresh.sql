-- Job ids that are ACTIVE, India-relevant, fresh (<=45d) and have NO embedding.
-- These are eligible for retrieval in every respect except that the candidate
-- query INNER JOINs job_embeddings, so they are invisible to it.
-- Feed to apps/workers/src/scripts/repair-embeddings.ts
SELECT j.id
FROM jobs j
LEFT JOIN job_embeddings je ON je."jobId" = j.id
WHERE j.status = 'ACTIVE'
  AND je."jobId" IS NULL
  AND (j.country = 'IN' OR j.location ~* 'india|bengaluru|bangalore|mumbai|pune|new delhi|delhi ncr|delhi|hyderabad|chennai|noida|gurgaon|gurugram|indore|kolkata|ahmedabad|jaipur|kochi|trivandrum|chandigarh')
  AND now()::date - COALESCE(j."postedAt", j."firstSeenAt")::date <= 45;
