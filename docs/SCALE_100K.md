# If CareerOS suddenly had 100,000 users, what would break first?

*Asked as an architecture exercise (2026-07-07). The honest answer, in failure order.*

## The key insight first

CareerOS has two workloads that scale on **different axes**:

- **Crawling/discovery scales with COMPANIES** — 100k users don't add a single crawl. The job
  corpus is shared; ten users or a million users watching Stripe costs one crawl per tier
  interval. This side of the system is almost user-count-invariant.
- **Matching/notification scales with USERS** — every user needs scoring against every relevant
  new job, and their own notifications.

So nothing on the crawler side breaks at 100k users. Everything that breaks is downstream of
the words "per user".

## What breaks, in order

### 1. LLM economics (breaks at ~1,000 users, not 100,000)

Deep-scoring is per-user × per-job: 100k users × ~15 scored jobs/day ≈ **1.5M LLM calls/day**.
At even $0.001/call that's $1,500/day. This breaks *economically* long before anything breaks
technically — it is THE scaling wall.

**Fixes, in escalation order:**
- Similarity gate already exists (only jobs above 0.45 cosine get LLM calls) — tighten per user.
- Score once per **(job, resume-cluster)** instead of (job, user): cluster similar resumes
  (they're already vectors), share the LLM verdict, personalize only the cheap parts
  (opportunity modules are pure math). 100k users might be ~5k clusters → 30× cost cut.
- Move deep scoring to a batch API (50% discount on most providers) — notifications tolerate
  minutes of latency.
- Distill: use accumulated LLM scores to train a small reranker; reserve the LLM for the top-3.

### 2. The match-new-jobs fan-out (breaks at ~10k users)

Today `matchNewJobs` loops users and runs one pgvector query per user per new-job batch —
O(users) queries. At 100k users each crawl tick triggers 100k similarity queries.

**Fix:** invert the query. Resume embeddings are already HNSW-indexed; for each new job, ONE
query — `SELECT userId FROM resume_embeddings ORDER BY vector <=> job_vector LIMIT k` — returns
the users worth scoring. O(new jobs) instead of O(users). The schema already supports this;
it's a rework of one method.

### 3. The job_matches table (breaks at ~50k users)

Materializing matches for everyone × everything relevant → billions of rows. Index bloat,
vacuum pain, backup times.

**Fixes:** only materialize above a threshold (already implicit via top-K); TTL matches for
REMOVED jobs; partition by user-id hash; eventually move cold matches to cheap storage.

### 4. Notification delivery (breaks at ~30k users, Telegram first)

One Telegram bot = ~30 messages/second hard limit. A hot job matching 5k users = 3 minutes of
queue just for one posting, and the platform will throttle bursts.

**Fixes:** per-channel delivery queues with rate limiters (BullMQ has them natively); digest
batching (one message per user per hour, not per job); multiple bots; email as the bulk channel
with Telegram reserved for 90+ scores.

### 5. Postgres as a whole (breaks at ~100k users, gracefully)

Not the crawl writes (company-scaled, batched upserts already), but: auth traffic, match reads,
notification lists, admin dashboards — read volume.

**Fixes, boring and standard:** read replicas for dashboard/list queries; PgBouncer;
`CREATE INDEX CONCURRENTLY` discipline for migrations on hot tables; the tsvector/HNSW indexes
already in place carry search. Postgres itself is fine into the millions of jobs — pgvector
HNSW query time degrades slowly and rebuildable.

### 6. Single Redis / single box (limits, not breakage)

BullMQ on one Redis sustains ~thousands of jobs/sec — crawling never gets near it; per-user
notification queues could. Redis Cluster or per-workload Redis instances split it cleanly.
The bigger truth: at 100k users this is no longer one $5 VPS — it's a small k8s/ECS cluster or
a few big boxes, and the three-deployable modular monolith moves onto them **unchanged**. The
seams (queues, single-writer API, stateless workers) were chosen so scaling is horizontal
replication, not rearchitecture.

### What does NOT break (and why that's the moat)

- Crawling, discovery, ATS adapters, company intelligence: company-scaled, shared corpus.
  Marginal infrastructure cost of user #100,001 ≈ their matching + notifications only.
- The single-writer ingest: ingest volume is company-scaled; unchanged.
- ToS posture: crawl rate doesn't grow with users — CareerOS at 100k users hits career pages
  no harder than CareerOS at 1 user.

### The one-sentence answer

**The LLM bill breaks first — around user one thousand, not one hundred thousand — followed by
the per-user matching fan-out; everything else is standard horizontal scaling that the current
seams already permit.**
