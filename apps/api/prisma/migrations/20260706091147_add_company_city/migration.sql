-- DropIndex
DROP INDEX "job_embeddings_vector_hnsw_idx";

-- DropIndex
DROP INDEX "resume_embeddings_vector_hnsw_idx";

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "city" TEXT;
