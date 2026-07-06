/**
 * Canonical queue names shared across the Node workers and the Python scraper
 * service. Both sides must agree on these strings — the Python side consumes
 * `SCRAPE_HARD_TARGET` via the `bullmq` PyPI package, which speaks the same
 * Redis wire protocol as this Node `bullmq` package.
 */
export const QueueNames = {
  REFRESH_ALL: 'refresh-all', // repeatable 24h tick + manual trigger from the API
  CRAWL_COMPANY: 'crawl-company',
  CRAWL_BOARD: 'crawl-board',
  SCRAPE_HARD_TARGET: 'scrape-hard-target',
  PARSE_RESUME: 'parse-resume',
  GENERATE_MATCHES: 'generate-matches',
  SEND_NOTIFICATION: 'send-notification',
} as const;

export type QueueName = (typeof QueueNames)[keyof typeof QueueNames];
