-- HNSW approximate-nearest-neighbor indexes for semantic search.
-- Prisma's schema DSL cannot express pgvector index types, so this migration
-- is maintained by hand. vector_cosine_ops matches the cosine-similarity
-- queries the matching engine will use (Phase 5).
CREATE INDEX "job_embeddings_vector_hnsw_idx"
  ON "job_embeddings" USING hnsw ("vector" vector_cosine_ops);

CREATE INDEX "resume_embeddings_vector_hnsw_idx"
  ON "resume_embeddings" USING hnsw ("vector" vector_cosine_ops);
