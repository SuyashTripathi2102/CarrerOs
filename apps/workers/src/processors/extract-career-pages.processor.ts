import { get as httpsGet } from 'node:https';
import { get as httpGet } from 'node:http';
import { Job, Queue, Worker } from 'bullmq';
import type { BoardJob } from '@careeros/shared';
import { QueueNames } from '../queues/names';
import { createRedisConnection } from '../queues/connection';
import { ApiClient } from '../api-client';
import {
  extractCareerPage,
  preprocess,
  looksJsRendered,
  EXTRACTOR_VERSION,
} from '../adapters/career-extractor';

const BATCH = 30;
const CONFIDENCE_THRESHOLD = 70;
// Cap stored HTML: preprocessed career pages are typically 20–150KB; this bounds
// the pathological ones so one giant page can't blow up the snapshot table.
const SNAPSHOT_CAP = 500_000;
const REPLAY_BATCH = 60;
const RENDER_BATCH = 15; // rendering is heavier — smaller batches

/**
 * Fetch a page's rendered HTML from the render service (Playwright/Crawl4AI on a
 * separate box — Chromium is too heavy for the API box). Returns null on any
 * failure or when no render service is configured, so the render tier degrades
 * to a no-op instead of erroring.
 */
async function fetchRenderedHtml(url: string): Promise<string | null> {
  const base = process.env.RENDER_SERVICE_URL;
  if (!base) return null;
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/render`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.RENDER_SERVICE_TOKEN
          ? { 'x-render-token': process.env.RENDER_SERVICE_TOKEN }
          : {}),
      },
      body: JSON.stringify({ url, waitUntil: 'networkidle' }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { html?: string };
    return data.html && data.html.length > 200 ? data.html : null;
  } catch {
    return null;
  }
}

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

      // Telemetry accumulators — the pipeline dashboard's raw material.
      let fetchMsTotal = 0;
      let parseMsTotal = 0;
      let confidenceTotal = 0;
      let confidencePages = 0;
      const rejections: Record<string, number> = {};
      const jsWallCompanyIds: string[] = []; // static tier hit an app shell → render tier

      let snapshotted = 0;
      for (const company of due) {
        processed++;
        const t0 = Date.now();
        const html = await fetchHtmlV4(company.careerPageUrl);
        fetchMsTotal += Date.now() - t0;
        if (!html) {
          fetchFailed++;
          continue;
        }
        const t1 = Date.now();
        const { boardJobs, jobs, confidence, rejections: rej } = extractCareerPage(
          html,
          company.careerPageUrl,
          company.name,
          CONFIDENCE_THRESHOLD,
        );
        parseMsTotal += Date.now() - t1;
        for (const [k, v] of Object.entries(rej)) rejections[k] = (rejections[k] ?? 0) + v;
        if (jobs.length > 0) {
          confidenceTotal += confidence;
          confidencePages++;
        }
        // Static tier found nothing but the page is a JS app shell → hand it to
        // the render tier, which loads it in a browser and re-runs THIS extractor.
        if (jobs.length === 0 && looksJsRendered(html)) jsWallCompanyIds.push(company.id);
        const clean = boardJobs.filter(valid);
        if (clean.length > 0) {
          pagesWithJobs++;
          all.push(...clean);
        }

        // Snapshot any page with job-like structure (>=1 candidate title survived
        // filtering), even at 0 accepted — that's exactly the recall a better
        // extractor will unlock on replay, with no re-crawl.
        if (jobs.length > 0) {
          try {
            await api.storeSnapshot({
              companyId: company.id,
              url: company.careerPageUrl,
              html: preprocess(html).slice(0, SNAPSHOT_CAP),
              extractorVersion: EXTRACTOR_VERSION,
              confidence,
              jobsAccepted: clean.length,
              candidateCount: jobs.length,
            });
            snapshotted++;
          } catch (err) {
            console.warn(`[career-extract] snapshot failed for ${company.name}: ${err}`);
          }
        }
        await new Promise((r) => setTimeout(r, 400)); // pace
      }

      let ingested: { found: number; created: number; duplicates?: number } = {
        found: 0,
        created: 0,
      };
      if (all.length > 0) {
        ingested = await api.ingestBoardJobs(`career-page-${EXTRACTOR_VERSION}`, all);
      }
      // Hand JS-app-shell pages to the render tier (no-op there until a render
      // service is configured). A failure must never fail the extraction run.
      if (jsWallCompanyIds.length > 0) {
        try {
          const f = await api.flagForRender(jsWallCompanyIds);
          console.log(`[career-extract] flagged ${f.flagged} JS-shell pages for render`);
        } catch (err) {
          console.warn(`[career-extract] flag-render failed: ${err}`);
        }
      }

      const totalMs = Date.now() - started;
      console.log(
        `[career-extract] ${processed} pages · ${fetchFailed} fetch-failed · ${pagesWithJobs} with jobs · ` +
          `${snapshotted} snapshotted · ${all.length} extracted · ${ingested.created} new · ${totalMs}ms`,
      );

      // Persist run telemetry — a failure here must not fail the extraction run.
      try {
        await api.recordExtractionRun({
          kind: 'live',
          extractorVersion: EXTRACTOR_VERSION,
          companiesQueued: due.length,
          fetched: processed - fetchFailed,
          fetchFailed,
          pagesWithJobs,
          jobsExtracted: all.length,
          jobsIngested: ingested.created,
          duplicates: ingested.duplicates ?? 0,
          snapshotted,
          avgConfidence: confidencePages ? Math.round(confidenceTotal / confidencePages) : 0,
          avgFetchMs: processed ? Math.round(fetchMsTotal / processed) : 0,
          avgParseMs: confidencePages ? Math.round(parseMsTotal / Math.max(1, processed - fetchFailed)) : 0,
          totalMs,
          rejections,
        });
      } catch (err) {
        console.warn(`[career-extract] metrics record failed: ${err}`);
      }

      return {
        processed,
        fetchFailed,
        pagesWithJobs,
        snapshotted,
        extracted: all.length,
        ...ingested,
      };
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

/**
 * Replay worker — the payoff of snapshots. Re-runs the CURRENT extractor over
 * stored HTML that an older version processed, and ingests whatever the improved
 * parser now finds. No network, no re-crawl: a parser improvement turns into new
 * jobs across the whole captured corpus. Idempotent — fingerprint dedup at ingest
 * means re-mining the same page never creates duplicates. After reprocessing, the
 * snapshot is re-stored under the current version so it leaves the backlog.
 */
export function startReplayExtractWorker(api: ApiClient): Worker {
  return new Worker(
    QueueNames.REPLAY_EXTRACT,
    async (_job: Job) => {
      const started = Date.now();
      const due = await api.getReplayDue(EXTRACTOR_VERSION, REPLAY_BATCH);
      let reprocessed = 0;
      let pagesWithJobs = 0;
      let parseMsTotal = 0;
      let confidenceTotal = 0;
      let confidencePages = 0;
      const rejections: Record<string, number> = {};
      const all: BoardJob[] = [];

      for (const snap of due) {
        reprocessed++;
        const t0 = Date.now();
        const { boardJobs, jobs, confidence, rejections: rej } = extractCareerPage(
          snap.html,
          snap.url,
          snap.name,
          CONFIDENCE_THRESHOLD,
        );
        parseMsTotal += Date.now() - t0;
        for (const [k, v] of Object.entries(rej)) rejections[k] = (rejections[k] ?? 0) + v;
        if (jobs.length > 0) {
          confidenceTotal += confidence;
          confidencePages++;
        }
        const clean = boardJobs.filter(valid);
        if (clean.length > 0) {
          pagesWithJobs++;
          all.push(...clean);
        }
        // Re-store under the current version so it exits the replay backlog. The
        // html is unchanged (from the snapshot itself) so no re-crawl happens.
        try {
          await api.storeSnapshot({
            companyId: snap.companyId,
            url: snap.url,
            html: snap.html,
            extractorVersion: EXTRACTOR_VERSION,
            confidence,
            jobsAccepted: clean.length,
            candidateCount: jobs.length,
          });
        } catch (err) {
          console.warn(`[replay-extract] re-store failed for ${snap.name}: ${err}`);
        }
      }

      let ingested: { found: number; created: number; duplicates?: number } = {
        found: 0,
        created: 0,
      };
      if (all.length > 0) {
        ingested = await api.ingestBoardJobs(`career-replay-${EXTRACTOR_VERSION}`, all);
      }
      const totalMs = Date.now() - started;
      console.log(
        `[replay-extract] ${reprocessed} snapshots · ${all.length} extracted · ` +
          `${ingested.created} new · ${totalMs}ms`,
      );

      if (reprocessed > 0) {
        try {
          await api.recordExtractionRun({
            kind: 'replay',
            extractorVersion: EXTRACTOR_VERSION,
            companiesQueued: due.length,
            fetched: reprocessed, // from storage, not network — but the "processed" count
            fetchFailed: 0,
            pagesWithJobs,
            jobsExtracted: all.length,
            jobsIngested: ingested.created,
            duplicates: ingested.duplicates ?? 0,
            snapshotted: 0,
            avgConfidence: confidencePages ? Math.round(confidenceTotal / confidencePages) : 0,
            avgFetchMs: 0, // replay does no network fetch
            avgParseMs: reprocessed ? Math.round(parseMsTotal / reprocessed) : 0,
            totalMs,
            rejections,
          });
        } catch (err) {
          console.warn(`[replay-extract] metrics record failed: ${err}`);
        }
      }

      return { reprocessed, extracted: all.length, ...ingested };
    },
    { connection: createRedisConnection(), concurrency: 1 },
  );
}

/**
 * Replay runs daily. When the extractor version is unchanged it's a no-op (every
 * snapshot is already current); when it's bumped, this drains the backlog a batch
 * at a time until the whole corpus has been re-mined by the new parser.
 */
export async function ensureReplayExtractSchedule(): Promise<void> {
  const queue = new Queue(QueueNames.REPLAY_EXTRACT, { connection: createRedisConnection() });
  await queue.upsertJobScheduler(
    'replay-extract-daily',
    { pattern: '45 3 * * *' }, // 03:45 daily
    { name: 'scheduled', opts: { attempts: 1, removeOnComplete: true, removeOnFail: true } },
  );
  await queue.close();
  console.log('[scheduler] replay-extract: daily (concurrency 1)');
}

/**
 * Render tier (Phase 4) — "just another renderer" behind the SAME pipeline. For
 * JS-app-shell career pages the static tier can't read, this asks the render
 * service for the browser-rendered HTML, then runs the EXACT SAME deterministic
 * extractor → validate → snapshot (so rendered pages are replayable too) →
 * ingest (fingerprint dedup, embed, Opportunity Score). No new extraction logic.
 *
 * Fully feature-flagged: with no RENDER_SERVICE_URL the worker is a clean no-op,
 * so it ships to the 2 GB box today and activates the moment a render service
 * (Playwright/Crawl4AI on a bigger box) is pointed at it.
 */
export function startRenderExtractWorker(api: ApiClient): Worker {
  return new Worker(
    QueueNames.RENDER_EXTRACT,
    async (_job: Job) => {
      if (!process.env.RENDER_SERVICE_URL) {
        return { skipped: 'no RENDER_SERVICE_URL configured' };
      }
      const started = Date.now();
      const due = await api.getRenderDue(RENDER_BATCH);
      let processed = 0;
      let renderFailed = 0;
      let pagesWithJobs = 0;
      let snapshotted = 0;
      let confidenceTotal = 0;
      let confidencePages = 0;
      let fetchMsTotal = 0;
      let parseMsTotal = 0;
      const rejections: Record<string, number> = {};
      const all: BoardJob[] = [];

      for (const company of due) {
        processed++;
        const t0 = Date.now();
        const html = await fetchRenderedHtml(company.careerPageUrl);
        fetchMsTotal += Date.now() - t0;
        if (!html) {
          renderFailed++;
          continue;
        }
        const t1 = Date.now();
        const { boardJobs, jobs, confidence, rejections: rej } = extractCareerPage(
          html,
          company.careerPageUrl,
          company.name,
          CONFIDENCE_THRESHOLD,
        );
        parseMsTotal += Date.now() - t1;
        for (const [k, v] of Object.entries(rej)) rejections[k] = (rejections[k] ?? 0) + v;
        if (jobs.length > 0) {
          confidenceTotal += confidence;
          confidencePages++;
        }
        const clean = boardJobs.filter(valid);
        if (clean.length > 0) {
          pagesWithJobs++;
          all.push(...clean);
        }
        // Snapshot the rendered HTML — rendered pages join the replay corpus too.
        if (jobs.length > 0) {
          try {
            await api.storeSnapshot({
              companyId: company.id,
              url: company.careerPageUrl,
              html: preprocess(html).slice(0, SNAPSHOT_CAP),
              extractorVersion: EXTRACTOR_VERSION,
              confidence,
              jobsAccepted: clean.length,
              candidateCount: jobs.length,
            });
            snapshotted++;
          } catch (err) {
            console.warn(`[render-extract] snapshot failed for ${company.name}: ${err}`);
          }
        }
      }

      let ingested: { found: number; created: number; duplicates?: number } = {
        found: 0,
        created: 0,
      };
      if (all.length > 0) {
        ingested = await api.ingestBoardJobs(`career-render-${EXTRACTOR_VERSION}`, all);
      }
      const totalMs = Date.now() - started;
      console.log(
        `[render-extract] ${processed} pages · ${renderFailed} render-failed · ${pagesWithJobs} with jobs · ` +
          `${all.length} extracted · ${ingested.created} new · ${totalMs}ms`,
      );

      if (processed > 0) {
        try {
          await api.recordExtractionRun({
            kind: 'render',
            extractorVersion: EXTRACTOR_VERSION,
            companiesQueued: due.length,
            fetched: processed - renderFailed,
            fetchFailed: renderFailed,
            pagesWithJobs,
            jobsExtracted: all.length,
            jobsIngested: ingested.created,
            duplicates: ingested.duplicates ?? 0,
            snapshotted,
            avgConfidence: confidencePages ? Math.round(confidenceTotal / confidencePages) : 0,
            avgFetchMs: processed ? Math.round(fetchMsTotal / processed) : 0,
            avgParseMs: confidencePages ? Math.round(parseMsTotal / Math.max(1, confidencePages)) : 0,
            totalMs,
            rejections,
          });
        } catch (err) {
          console.warn(`[render-extract] metrics record failed: ${err}`);
        }
      }

      return { processed, renderFailed, pagesWithJobs, extracted: all.length, ...ingested };
    },
    { connection: createRedisConnection(), concurrency: 1 },
  );
}

/** Render tier runs every 6h, offset from the static tier. No-op without a service. */
export async function ensureRenderExtractSchedule(): Promise<void> {
  const queue = new Queue(QueueNames.RENDER_EXTRACT, { connection: createRedisConnection() });
  await queue.upsertJobScheduler(
    'render-extract-6h',
    { pattern: '45 */6 * * *' }, // every 6h at :45 (static runs at :15)
    { name: 'scheduled', opts: { attempts: 1, removeOnComplete: true, removeOnFail: true } },
  );
  await queue.close();
  console.log('[scheduler] render-extract: every 6h (concurrency 1)');
}
