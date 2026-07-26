-- Immutable per-event metadata (reviewer): rank (position → position-bias
-- analysis) and jobSource (provenance / extractor version). Impressions arrive
-- via the SHOWN type on the existing "type" column, so CTR = clicks / impressions
-- becomes computable.
ALTER TABLE "opportunity_events" ADD COLUMN "rank" INTEGER;
ALTER TABLE "opportunity_events" ADD COLUMN "jobSource" TEXT;
