-- Render tier (Phase 4): the static extractor found a JS app shell (jobs hidden
-- behind client-side rendering). Flag it for the render service, which loads the
-- page in a real browser and feeds the SAME deterministic extractor. Feature-
-- flagged worker-side (RENDER_SERVICE_URL) so this is a no-op until a render
-- service is provisioned on a bigger box.
ALTER TABLE "companies" ADD COLUMN "needsRender" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "companies" ADD COLUMN "lastRenderedAt" TIMESTAMP(3);
CREATE INDEX "companies_needsRender_lastRenderedAt_idx" ON "companies"("needsRender", "lastRenderedAt");
