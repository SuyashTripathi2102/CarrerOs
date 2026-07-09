-- The user's judgement on jobs CareerOS could not classify confidently.
--
-- Kept out of job_classifications on purpose. That table answers "what is this
-- job?" — objective, shared, and thrown away whenever the classifier version
-- bumps. This answers "is this my kind of work?", which is personal and must
-- outlive every reclassification.
CREATE TABLE "job_review_feedback" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "relevant" BOOLEAN NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_review_feedback_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "job_review_feedback_userId_jobId_key" ON "job_review_feedback"("userId", "jobId");
CREATE INDEX "job_review_feedback_userId_relevant_idx" ON "job_review_feedback"("userId", "relevant");

ALTER TABLE "job_review_feedback" ADD CONSTRAINT "job_review_feedback_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "job_review_feedback" ADD CONSTRAINT "job_review_feedback_jobId_fkey"
    FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
