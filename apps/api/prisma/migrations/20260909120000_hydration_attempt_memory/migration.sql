-- Detail hydration attempt memory.
--
-- Claimed at SELECTION, not on success. A job whose detail page never yields a
-- usable body stays eligible forever otherwise, consuming the batch on every
-- tick and re-fetching the same third-party page indefinitely -- the same
-- starvation shape as the 2026-08-12 candidate-queue bug. A failed attempt is
-- a decision, and decisions get persisted.
ALTER TABLE "jobs" ADD COLUMN "lastHydrationAttemptAt" TIMESTAMP(3);

-- Supports the due query: ACTIVE jobs not attempted inside the backoff window.
CREATE INDEX "jobs_status_lastHydrationAttemptAt_idx"
  ON "jobs"("status", "lastHydrationAttemptAt");
