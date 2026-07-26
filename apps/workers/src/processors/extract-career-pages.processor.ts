import { get as httpsGet } from 'node:https';
import { get as httpGet } from 'node:http';
import { Job, Queue, Worker } from 'bullmq';
import type { BoardJob } from '@careeros/shared';
import { QueueNames } from '../queues/names';
import { createRedisConnection } from '../queues/connection';
import { ApiClient } from '../api-client';
import { extractCareerPage } from '../adapters/career-extractor';

/** The extractor's version — recorded via the ingest source so we know which
 *  parser produced which jobs (and can re-extract when it improves). */
const EXTRACTOR_VERSION = 'deterministic-v1';
const BATCH = 30;
const CONFIDENCE_THRESHOLD = 70;

/** IPv4-forced HTML GET (broken v6 egress; arbitrary career hosts) — null on any failure. */
function fetchHtmlV4(url: string, timeoutMs = 10_000): Promise<string | null> {
  return new Promise((resolve) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      resolve(null);
      return;
    }
    const getter = u.protocol === 'http:' ? httpGet : httpsGet;
    const req = getter(
      url,
      {
        family: 4,
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; CareerOS/0.1)', accept: 'text/html' },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // Follow one redirect manually (keeps it simple + bounded).
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolve(fetchHtmlV4(new URL(res.headers.location, url).toString(), timeoutMs));
          return;
        }
        if (status >= 400) {
          res.resume();
          resolve(null);
          return;
        }
        const ct = res.headers['content-type'] ?? '';
        if (!/text\/html|application\/xhtml/i.test(String(ct))) {
          res.resume();
          resolve(null);
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
          if (body.length > 1_500_000) req.destroy(); // cap
        });
        res.on('end', () => resolve(body));
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

/** Never ingest a job missing the fields the pipeline needs downstream. */
const valid = (b: BoardJob): boolean =>
  !!b.company?.name && !!b.job?.title && !!b.job?.url && /^https?:\/\//i.test(b.job.url);

/**
 * Tier-1 career-page extraction. Concurrency 1 (one page at a time — no browser,
 * gentle on the box). Pulls a prioritised batch of custom career pages, extracts
 * deterministically, validates, and ingests high-confidence jobs through the
 * same BoardJob → ingest → embed → Opportunity pipeline as every other source.
 */
export function startCareerExtractWorker(api: ApiClient): Worker {
  return new Worker(
    QueueNames.CAREER_EXTRACT,
    async (_job: Job) => {
      const started = Date.now();
      const due = await api.getCareerPagesDue(BATCH);
      let processed = 0;
      let fetchFailed = 0;
      let pagesWithJobs = 0;
      const all: BoardJob[] = [];

      for (const company of due) {
        processed++;
        const html = await fetchHtmlV4(company.careerPageUrl);
        if (!html) {
          fetchFailed++;
          continue;
        }
        const { boardJobs } = extractCareerPage(
          html,
          company.careerPageUrl,
          company.name,
          CONFIDENCE_THRESHOLD,
        );
        const clean = boardJobs.filter(valid);
        if (clean.length > 0) {
          pagesWithJobs++;
          all.push(...clean);
        }
        await new Promise((r) => setTimeout(r, 400)); // pace
      }

      let ingested = { found: 0, created: 0 };
      if (all.length > 0) {
        ingested = await api.ingestBoardJobs(`career-page-${EXTRACTOR_VERSION}`, all);
      }
      console.log(
        `[career-extract] ${processed} pages · ${fetchFailed} fetch-failed · ${pagesWithJobs} with jobs · ` +
          `${all.length} extracted · ${ingested.created} new · ${Date.now() - started}ms`,
      );
      return { processed, fetchFailed, pagesWithJobs, extracted: all.length, ...ingested };
    },
    { connection: createRedisConnection(), concurrency: 1 },
  );
}

/** Run a batch a few times a day — custom pages change slowly, quota is $0. */
export async function ensureCareerExtractSchedule(): Promise<void> {
  const queue = new Queue(QueueNames.CAREER_EXTRACT, { connection: createRedisConnection() });
  await queue.upsertJobScheduler(
    'career-extract-6h',
    { pattern: '15 */6 * * *' }, // every 6 hours at :15
    { name: 'scheduled', opts: { attempts: 1, removeOnComplete: true, removeOnFail: true } },
  );
  await queue.close();
  console.log('[scheduler] career-extract: every 6h (concurrency 1)');
}
