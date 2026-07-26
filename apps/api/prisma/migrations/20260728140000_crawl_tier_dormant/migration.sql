-- Adaptive crawl scheduling: a DORMANT tier for the dead-company backoff. A
-- monitored company with no live jobs and nothing new for ~4 months is crawled
-- monthly instead of every few hours, freeing the single-box budget for
-- companies that actually post.
ALTER TYPE "CrawlTier" ADD VALUE 'DORMANT';
