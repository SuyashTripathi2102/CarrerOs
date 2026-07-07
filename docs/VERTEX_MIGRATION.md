# Migrating AI from Gemini Developer API → Vertex AI

**Why:** identical models and per-token prices, but Vertex bills to Google Cloud —
where the ₹28,321 (~$300 / 90-day) free-trial credits apply. The Developer API's
paid tier is prepaid-only and explicitly excluded from trial credits (March 2026
policy). After credits expire, Vertex stays pay-as-you-go at the same token
prices — nothing gets more expensive.

Both implementations stay in the codebase. Switching (either direction) is an
env change, not a deploy of new code:

| | `gemini` (Developer API) | `vertex` (Vertex AI) |
|---|---|---|
| Endpoint | generativelanguage.googleapis.com | {loc}-aiplatform.googleapis.com |
| Auth | API key (`GEMINI_API_KEY`) | Service-account OAuth2 (`GOOGLE_APPLICATION_CREDENTIALS`) |
| Billing | AI Studio prepaid | Cloud Billing (trial credits ✓) |
| Code | `gemini.provider.ts` | `vertex-gemini.provider.ts` |

## 1. One-time GCP setup (Suyash, ~20 min, Console)

1. console.cloud.google.com → create project (e.g. `careeros-prod`) — make sure
   it's linked to the billing account holding the trial credits.
2. APIs & Services → Enable APIs → enable **Vertex AI API**.
3. IAM & Admin → Service Accounts → Create (`careeros-api`), grant role
   **Vertex AI User** (`roles/aiplatform.user`).
4. On the service account → Keys → Add key → JSON. Download it.
5. Copy the key to the server and lock it down:
   ```bash
   ssh root@139.59.15.220 "mkdir -p /root/careeros/secrets"
   scp careeros-api-key.json root@139.59.15.220:/root/careeros/secrets/vertex-sa.json
   ssh root@139.59.15.220 "chmod 600 /root/careeros/secrets/vertex-sa.json"
   ```
   `secrets/` is gitignored; the compose file mounts it read-only at `/secrets`.

## 2. Flip production to Vertex

Append to `.env.prod` on the server:

```bash
AI_PROVIDER=vertex
GOOGLE_CLOUD_PROJECT=careeros-prod        # the real project id
GOOGLE_CLOUD_LOCATION=us-central1
```

Then recreate the api container (image already contains both providers):

```bash
cd /root/careeros
docker compose -f compose.prod.yml --env-file .env.prod up -d api
docker compose -f compose.prod.yml --env-file .env.prod logs api --tail 20
```

Boot must show Nest started with no "Unknown ... PROVIDER" error. A quick smoke:
`GET /api/ai/usage` now reports `providers.llm.provider: "vertex"`.

## 3. Re-embed everything (REQUIRED after the switch)

Embeddings from different providers/models are different vector spaces — mixing
them silently breaks similarity search. The schema stores ONE vector per job, so
the flow is: **backup → wipe → backfill re-embeds → validate → drop backup**.
The backfill is crash-safe and resumes where it stopped.

```sql
-- inside: docker compose ... exec postgres psql -U careeros -d careeros
CREATE TABLE job_embeddings_backup    AS TABLE job_embeddings;
CREATE TABLE resume_embeddings_backup AS TABLE resume_embeddings;
DELETE FROM job_embeddings;
DELETE FROM resume_embeddings;
```

Re-embed the resume first (matching needs it), then the jobs:

```bash
# resume: re-parse the primary version (1 LLM call + 1 embed)
curl -X POST http://localhost:3001/api/resumes/versions/<versionId>/parse -H "Authorization: Bearer $TOKEN"
# jobs: enqueue the full run — backfills all ACTIVE jobs, then rescores matches
curl -X POST http://localhost:3001/api/matches/generate -H "Authorization: Bearer $TOKEN"
```

At ~5,300 jobs this is ~2.7M embedding tokens ≈ **$0.55 against credits**.

## 4. Validate BEFORE deleting the backups

```sql
-- 1. Coverage: every ACTIVE job re-embedded
SELECT (SELECT count(*) FROM jobs WHERE status='ACTIVE') AS active_jobs,
       (SELECT count(*) FROM job_embeddings)             AS embedded;
-- 2. Model column shows the new provider's model on ALL rows
SELECT model, count(*) FROM job_embeddings GROUP BY model;
-- 3. Dimensionality intact (must be 1536)
SELECT vector_dims(vector) AS dims FROM job_embeddings LIMIT 1;
-- 4. Sanity: similarity search returns plausible neighbours
SELECT j.title, 1 - (je.vector <=> re.vector) AS similarity
FROM job_embeddings je JOIN jobs j ON j.id = je."jobId"
CROSS JOIN (SELECT vector FROM resume_embeddings LIMIT 1) re
ORDER BY je.vector <=> re.vector LIMIT 10;   -- titles should look like the resume's field
```

All four pass → `DROP TABLE job_embeddings_backup, resume_embeddings_backup;`

## 5. Rollback (any point before the backups are dropped)

```bash
# .env.prod: AI_PROVIDER=gemini  (delete the vertex lines)
docker compose -f compose.prod.yml --env-file .env.prod up -d api
```
```sql
DELETE FROM job_embeddings;    INSERT INTO job_embeddings    SELECT * FROM job_embeddings_backup;
DELETE FROM resume_embeddings; INSERT INTO resume_embeddings SELECT * FROM resume_embeddings_backup;
```

## 6. Benchmark (before/after)

`ai_usage` records latency + tokens + cost per call, per provider. After ≥1 day
on Vertex, compare like-for-like in `GET /api/ai/usage` (or SQL):

```sql
SELECT provider, kind, count(*), round(avg("latencyMs")) avg_ms,
       round(sum("costUsd")::numeric, 4) cost
FROM ai_usage WHERE ok GROUP BY 1, 2 ORDER BY 1, 2;
```

Baseline to beat (Developer API, measured 2026-07-07): embeddings batched 20/call
at ~15s pacing (free-tier pacing — paid Vertex needs no pacing, so expect embeds
to finish dramatically faster end-to-end); generate calls ~2–6s.

## Notes / gotchas

- `VERTEX_EMBED_BATCH_SIZE` defaults to **1** — gemini-embedding models on
  Vertex cap instances-per-request low. Raise it only after checking the model's
  limit in the Vertex quotas page; a 400 "instances" error means too high.
- The workers/scraper services never call Google directly (they go through the
  API's internal endpoints) — only the api service needs the key file.
- Trial credits: check balance/expiry at Console → Billing → Credits. When the
  trial ends, Google pauses billing-dependent services until you explicitly
  upgrade to a paid account — usage then bills at the same per-token prices.
