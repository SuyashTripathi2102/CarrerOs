import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { CrawlStatus, CrawlTier, DiscoveryStage, JobStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import type { BoardJob, NormalizedJob } from '@careeros/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { CompaniesService } from '../companies/companies.service';
import { computeConfidence } from '../discovery/discovery.service';
import { normalizeCountry } from './country';
import { jobFingerprint } from './job-fingerprint';
import { adaptiveTier, TIER_INTERVAL_MS, type Tier } from './crawl-scheduling';
import { decideReconciliation } from './crawl-reconciliation';
import { EMBED_JOBS_QUEUE } from './internal.constants';

/**
 * How old a vector-less ACTIVE job must be before the sweeper calls it
 * stranded rather than in flight. Embedding normally completes in well under a
 * minute (p50 0.32 h at the worst measured backlog); 30 minutes is far outside
 * normal latency, so anything older has genuinely lost its enqueue.
 */
const EMBED_GRACE_MS = 30 * 60 * 1000;

/** Bounded so one sweep cannot enqueue the entire corpus after an outage. */
const EMBED_SWEEP_LIMIT = 2_000;

export interface SyncResult {
  crawlRunId: string;
  found: number;
  created: number;
  updated: number;
  removed: number;
  duplicates?: number; // cross-source fingerprint collisions collapsed away
}

const FAILURE_BACKOFF_MS = 60 * 60 * 1000; // failed company retries in 1h, not hot-loop

const UPSERT_CHUNK = 500;

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly companies: CompaniesService,
    @InjectQueue(EMBED_JOBS_QUEUE) private readonly embedQueue: Queue,
  ) {}

  /**
   * Full-board sync for one company: batched upsert of what the crawler saw,
   * mark what disappeared as REMOVED, record a CrawlRun, bump nextCrawlAt by
   * tier, enqueue embeddings for genuinely new jobs. Never deletes — history
   * is a feature (application tracker's "position filled" signal).
   */
  async syncCompanyJobs(
    companyId: string,
    source: string,
    jobs: NormalizedJob[],
    boardComplete = true,
  ): Promise<SyncResult> {
    const run = await this.prisma.crawlRun.create({
      data: { companyId, source, status: CrawlStatus.RUNNING },
    });

    try {
      const { created, updated, newJobIds } = await this.batchUpsert(companyId, jobs, source);

      // Retire what this crawl is authoritative for — see crawl-reconciliation.ts.
      // TWO guards, both of which were missing and together destroyed 18 of 31
      // actionable FreeHire opportunities on 2026-08-15:
      //
      //   1. An EMPTY crawl retires nothing. `notIn: []` matches every row, so
      //      a failed/rate-limited/misrouted crawl wiped the whole board.
      //   2. A crawl only reconciles ITS OWN source. A Workable board being
      //      empty says nothing about a job discovered via FreeHire.
      //   3. A PARTIAL board retires nothing. A walk that stopped at a page cap
      //      is successful and non-empty, so it clears both guards above and
      //      then retires every job past the last page it read.
      const seenIds = jobs.map((j) => j.externalId);
      const decision = decideReconciliation({
        seenExternalIds: seenIds,
        crawlSucceeded: true,
        boardComplete,
      });
      let removed = 0;
      if (decision.retire) {
        ({ count: removed } = await this.prisma.job.updateMany({
          where: {
            companyId,
            source,
            status: JobStatus.ACTIVE,
            externalId: { notIn: seenIds },
          },
          data: { status: JobStatus.REMOVED },
        }));
      } else {
        this.logger.warn(
          `[${source}] company ${companyId}: reconciliation skipped (${decision.reason}) — ` +
            `existing jobs preserved`,
        );
      }

      await this.prisma.crawlRun.update({
        where: { id: run.id },
        data: {
          status: CrawlStatus.SUCCEEDED,
          finishedAt: new Date(),
          jobsFound: jobs.length,
          jobsNew: created,
          jobsRemoved: removed,
        },
      });

      await this.applyAdaptiveSchedule(companyId);
      await this.updateConfidenceAfterCrawl(companyId, jobs.length > 0);
      await this.enqueueEmbeddings(newJobIds);

      return { crawlRunId: run.id, found: jobs.length, created, updated, removed };
    } catch (err) {
      await this.prisma.crawlRun.update({
        where: { id: run.id },
        data: {
          status: CrawlStatus.FAILED,
          finishedAt: new Date(),
          error: err instanceof Error ? err.message : String(err),
        },
      });
      await this.bumpNextCrawl(companyId, /* failed */ true);
      throw err;
    }
  }

  /**
   * Board ingest (RemoteOK, HN...): jobs arrive with company info instead of
   * a companyId. Companies are found-or-created — the discovery flywheel.
   * No removed-detection here: a job leaving a board says nothing about the
   * company's own career page.
   */
  /**
   * Repair descriptions on jobs that already exist. UPDATE ONLY.
   *
   * Deliberately not a crawl: no insert, no reconciliation, no status change,
   * no crawl_run. Matching is on (source, externalId) so a row can only ever be
   * updated in place. An empty body is stored with descriptionSource MISSING
   * rather than being skipped — "we looked and there is nothing" is a fact
   * worth recording, and the gate holds those instead of judging them.
   *
   * Returns what changed so the repair can be measured rather than assumed.
   */
  /**
   * THE SWEEPER — the missing half of the embedding invariant.
   *
   * `enqueueEmbeddings` is the only producer of embed work and it runs exactly
   * once, at ingest. Nothing sweeps behind it, so any id lost between ingest
   * and embed is lost permanently: the job stays ACTIVE, looks healthy in every
   * count, and can NEVER be retrieved, because the candidate query INNER JOINs
   * `job_embeddings`. Measured 2026-08-23: 1,673 such jobs, 79 of them stranded
   * inside two hours by embed batches that failed and were discarded.
   *
   * The invariant this restores:
   *
   *   every job requiring an embedding is eventually either embedded or
   *   explicitly observable as failed — never silently stranded.
   *
   * THE GRACE PERIOD IS THE WHOLE DESIGN. A job ingested a minute ago also has
   * no vector, and it is not stranded — it is in flight. The 2026-08-13
   * analysis concluded "nothing is stranded" precisely because it could not
   * tell those two apart: it segmented by ingestion day, and a cohort
   * measurement reads both as "not embedded yet". Only age separates them, so
   * this sweeps nothing younger than the grace window and re-enqueues the rest.
   *
   * Idempotent: `embedJobsByIds` filters on `embedding: null`, so re-enqueuing
   * a job that has since been embedded is a no-op.
   */
  async reconcileEmbeddings(
    limit = EMBED_SWEEP_LIMIT,
  ): Promise<{ stranded: number; enqueued: number }> {
    const cutoff = new Date(Date.now() - EMBED_GRACE_MS);

    const [{ n }] = await this.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n
      FROM jobs j
      LEFT JOIN job_embeddings e ON e."jobId" = j.id
      WHERE j.status = 'ACTIVE' AND e."jobId" IS NULL AND j."firstSeenAt" < ${cutoff}
    `;
    const stranded = Number(n);
    if (stranded === 0) return { stranded: 0, enqueued: 0 };

    // Newest first: a job stranded today is likelier to still be open than one
    // stranded weeks ago, and a bounded sweep should recover the useful ones
    // first. The rest are picked up by the following ticks.
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT j.id
      FROM jobs j
      LEFT JOIN job_embeddings e ON e."jobId" = j.id
      WHERE j.status = 'ACTIVE' AND e."jobId" IS NULL AND j."firstSeenAt" < ${cutoff}
      ORDER BY j."firstSeenAt" DESC
      LIMIT ${limit}
    `;
    await this.enqueueEmbeddings(rows.map((r) => r.id));

    // Logged whenever it fires, because a sweeper that silently finds work
    // every single tick means the producer is leaking and the sweep is only
    // masking it. Steady-state is expected to be zero.
    this.logger.warn(
      `[embedding-sweep] ${stranded} stranded job(s) past the ${EMBED_GRACE_MS / 60000}m grace ` +
        `window — re-enqueued ${rows.length}`,
    );
    return { stranded, enqueued: rows.length };
  }

  async repairDescriptions(
    source: string,
    updates: { externalId: string; description: string; descriptionSource: string }[],
  ): Promise<{ matched: number; changed: number; unchanged: number; notFound: number }> {
    if (updates.length === 0) return { matched: 0, changed: 0, unchanged: 0, notFound: 0 };

    // SET-BASED on purpose. The first version did one findFirst + one update
    // PER ROW — 8,030 round trips for a 4,015-posting board — which exhausted
    // the Prisma connection pool while the evaluation belt was also running,
    // and the repair 500'd mid-board. Two statements do the same work.
    const externalIds = updates.map((u) => u.externalId);
    const existing = await this.prisma.job.findMany({
      where: { source, externalId: { in: externalIds } },
      select: { id: true, externalId: true, description: true },
    });
    const byExternalId = new Map(existing.map((e) => [e.externalId, e]));

    const toWrite: { id: string; description: string; descriptionSource: string }[] = [];
    let unchanged = 0;
    for (const u of updates) {
      const row = byExternalId.get(u.externalId);
      if (!row) continue;
      if ((row.description ?? '') === u.description) {
        unchanged++;
        continue;
      }
      toWrite.push({ id: row.id, description: u.description, descriptionSource: u.descriptionSource });
    }

    const matched = existing.length;
    let changed = 0;
    if (toWrite.length > 0) {
      const ids = toWrite.map((w) => w.id);
      const descs = toWrite.map((w) => w.description);
      const provs = toWrite.map((w) => w.descriptionSource);
      // One UPDATE ... FROM unnest, matching the batch-upsert style already
      // used by batchUpsert. Touches description and provenance only — never
      // status, never source, never anything reconciliation reads.
      // Same invariant as batchUpsert: a changed body means a stale vector.
      // Clearing it lets the existing embed path rebuild it — nothing else can,
      // because embedJobsByIds only looks at rows WHERE embedding IS NULL.
      await this.prisma.jobEmbedding.deleteMany({ where: { jobId: { in: ids } } });

      changed = await this.prisma.$executeRaw`
        UPDATE jobs AS j
        SET description = u.description,
            "descriptionSource" = u.description_source::"DescriptionSource"
        FROM unnest(${ids}::text[], ${descs}::text[], ${provs}::text[])
          AS u(id, description, description_source)
        WHERE j.id = u.id
      `;

      // A cleared vector that is never re-enqueued STRANDS the job: it stays
      // ACTIVE, looks healthy in every count, and retrieval can never see it
      // because the candidate query INNER JOINs job_embeddings. Deleting above
      // without this line would hide the very jobs this repair just fixed.
      await this.enqueueEmbeddings(ids);
    }

    this.logger.log(
      `[${source}] description repair: ${changed} changed, ${unchanged} already correct, ` +
        `${updates.length - matched} not found`,
    );
    return { matched, changed, unchanged, notFound: updates.length - matched };
  }

  async ingestBoardJobs(
    source: string,
    entries: BoardJob[],
    discoverySource?: string,
  ): Promise<SyncResult> {
    const run = await this.prisma.crawlRun.create({
      data: { source, status: CrawlStatus.RUNNING },
    });

    let created = 0;
    let updated = 0;
    let duplicates = 0;
    let failures = 0;
    const newJobIds: string[] = [];

    // Group by company so each company's jobs go through one batched upsert.
    const byCompany = new Map<string, { entry: BoardJob['company']; jobs: NormalizedJob[] }>();
    for (const e of entries) {
      const key = e.company.name.toLowerCase();
      const bucket = byCompany.get(key) ?? { entry: e.company, jobs: [] };
      bucket.jobs.push(e.job);
      byCompany.set(key, bucket);
    }

    for (const { entry, jobs } of byCompany.values()) {
      try {
        // Pass the board through: without it every board collapses to the
        // literal 'board' and the discovery-vs-acquisition distinction — the
        // one that separates 67.1% from 92.7% — is destroyed at write time.
        // discoverySource overrides it where the two genuinely differ: a
        // company found via a directory, whose jobs are crawled from its own
        // ATS, is discoveredBy the directory and acquiredFrom the ATS.
        const company = await this.companies.findOrCreateFromBoard(
          entry,
          discoverySource ?? source,
        );
        const res = await this.batchUpsert(company.id, jobs, source);
        created += res.created;
        updated += res.updated;
        duplicates += res.duplicates;
        newJobIds.push(...res.newJobIds);
      } catch (err) {
        failures++;
        this.logger.warn(
          `Board ingest skipped ${jobs.length} job(s) @ ${entry.name}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    await this.prisma.crawlRun.update({
      where: { id: run.id },
      data: {
        status: failures === 0 ? CrawlStatus.SUCCEEDED : CrawlStatus.PARTIAL,
        finishedAt: new Date(),
        jobsFound: entries.length,
        jobsNew: created,
        error: failures > 0 ? `${failures} companies failed` : null,
      },
    });

    await this.enqueueEmbeddings(newJobIds);
    return { crawlRunId: run.id, found: entries.length, created, updated, removed: 0, duplicates };
  }

  /**
   * One INSERT ... ON CONFLICT round trip per chunk instead of 2 queries per
   * job — the difference between 10 minutes and 5 seconds at 10k jobs/day.
   * `xmax = 0` distinguishes fresh inserts from conflict-updates.
   */
  private async batchUpsert(
    companyId: string,
    jobs: NormalizedJob[],
    source?: string,
  ): Promise<{ created: number; updated: number; duplicates: number; newJobIds: string[] }> {
    let created = 0;
    let updated = 0;
    let duplicates = 0;
    const newJobIds: string[] = [];

    // Dedupe by externalId within this crawl: Workable (and others) list the
    // same shortcode twice for multi-location postings. Postgres ON CONFLICT
    // can't update one row twice in a statement — an un-deduped batch fails
    // ENTIRELY, silently dropping every job from that company (2026-07-09:
    // 45 Workable crawls/day failing this way). Keep first occurrence.
    const seen = new Set<string>();
    const byExternalId = jobs.filter((j) => {
      if (seen.has(j.externalId)) return false;
      seen.add(j.externalId);
      return true;
    });

    // Compute the cross-source fingerprint once per job.
    const withFp = byExternalId.map((j) => ({
      job: j,
      fingerprint: jobFingerprint({
        companyId,
        title: j.title,
        location: j.location,
        workMode: j.workMode,
      }),
    }));

    // Within-batch collapse: a single source can list the same opening twice
    // (near-identical duplicate posts). Keep the first per fingerprint so the
    // ON CONFLICT statement never sees a fingerprint twice.
    const fpSeen = new Set<string>();
    const uniqueInBatch = withFp.filter((w) => {
      if (fpSeen.has(w.fingerprint)) {
        duplicates++;
        return false;
      }
      fpSeen.add(w.fingerprint);
      return true;
    });

    // Cross-source collapse: this company may already carry this fingerprint
    // under a DIFFERENT externalId (same job from another board). Don't insert
    // a competing row — just keep the canonical one fresh. Never suppress an
    // entry whose own externalId already exists (that's a legitimate update).
    const fingerprints = uniqueInBatch.map((w) => w.fingerprint);
    const externalIds = uniqueInBatch.map((w) => w.job.externalId);
    const existing = await this.prisma.job.findMany({
      where: { companyId, fingerprint: { in: fingerprints } },
      select: { id: true, externalId: true, fingerprint: true },
    });
    const ownerByFp = new Map(existing.map((e) => [e.fingerprint!, e]));
    const refreshIds: string[] = [];
    const toUpsert = uniqueInBatch.filter((w) => {
      const owner = ownerByFp.get(w.fingerprint);
      if (owner && owner.externalId !== w.job.externalId) {
        duplicates++;
        refreshIds.push(owner.id); // keep the canonical row's lastSeenAt current
        return false;
      }
      return true;
    });
    if (refreshIds.length > 0) {
      await this.prisma.job.updateMany({
        where: { id: { in: refreshIds } },
        data: { lastSeenAt: new Date(), status: JobStatus.ACTIVE },
      });
    }

    for (let i = 0; i < toUpsert.length; i += UPSERT_CHUNK) {
      const chunk = toUpsert.slice(i, i + UPSERT_CHUNK);

      const ids = chunk.map(() => randomUUID());
      const chunkExternalIds = chunk.map((w) => w.job.externalId);
      const titles = chunk.map((w) => w.job.title);
      const descriptions = chunk.map((w) => w.job.description ?? '');
      const urls = chunk.map((w) => w.job.url);
      const locations = chunk.map((w) => w.job.location ?? null);
      // Normalized HERE, at the one place every source converges, so a new
      // adapter cannot reintroduce the 2026-08-15 bug: Workable and Recruitee
      // emitted locale names ("India", "Deutschland") and 567 Indian jobs
      // became invisible to every `country = 'IN'` filter in the product.
      // Falls back to the location string when the source sends no country —
      // "Bengaluru, India" is perfectly good evidence of the market.
      const countries = chunk.map(
        (w) => normalizeCountry(w.job.country) ?? normalizeCountry(w.job.location),
      );
      const workModes = chunk.map((w) => w.job.workMode ?? null);
      const salaryMins = chunk.map((w) => w.job.salaryMin ?? null);
      const salaryMaxs = chunk.map((w) => w.job.salaryMax ?? null);
      const currencies = chunk.map((w) => w.job.currency ?? null);
      const postedAts = chunk.map((w) => w.job.postedAt ?? null);
      const fingerprintsCol = chunk.map((w) => w.fingerprint);
      const sources = chunk.map(() => source ?? null);
      // Provenance of the body. NULL when an adapter does not report it — the
      // eight that always receive a description with the listing. Never
      // defaulted to LIST: inventing provenance is the same error as inventing
      // a description. See enum DescriptionSource.
      const descriptionSources = chunk.map((w) => w.job.descriptionSource ?? null);

      const rows = await this.prisma.$queryRaw<
        { id: string; inserted: boolean; description_changed: boolean }[]
      >`
        INSERT INTO jobs (
          id, "companyId", "externalId", title, description, url,
          location, country, "workMode", "salaryMin", "salaryMax", currency,
          "postedAt", source, fingerprint, "descriptionSource", status, "firstSeenAt", "lastSeenAt"
        )
        SELECT
          u.id, ${companyId}, u.external_id, u.title, u.description, u.url,
          u.location, u.country, u.work_mode::"WorkMode", u.salary_min, u.salary_max, u.currency,
          u.posted_at::timestamptz, u.source, u.fingerprint,
          u.description_source::"DescriptionSource", 'ACTIVE', now(), now()
        FROM unnest(
          ${ids}::text[], ${chunkExternalIds}::text[], ${titles}::text[],
          ${descriptions}::text[], ${urls}::text[], ${locations}::text[],
          ${countries}::text[], ${workModes}::text[], ${salaryMins}::int[],
          ${salaryMaxs}::int[], ${currencies}::text[], ${postedAts}::text[],
          ${sources}::text[], ${fingerprintsCol}::text[],
          ${descriptionSources}::text[]
        ) AS u(
          id, external_id, title, description, url, location,
          country, work_mode, salary_min, salary_max, currency, posted_at,
          source, fingerprint, description_source
        )
        ON CONFLICT ("companyId", "externalId") DO UPDATE SET
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          url = EXCLUDED.url,
          location = EXCLUDED.location,
          country = EXCLUDED.country,
          "workMode" = EXCLUDED."workMode",
          "salaryMin" = EXCLUDED."salaryMin",
          "salaryMax" = EXCLUDED."salaryMax",
          currency = EXCLUDED.currency,
          "postedAt" = EXCLUDED."postedAt",
          -- COALESCE so a re-crawl by an adapter that does not report
          -- provenance cannot erase provenance an earlier crawl established.
          "descriptionSource" = COALESCE(EXCLUDED."descriptionSource", jobs."descriptionSource"),
          source = COALESCE(EXCLUDED.source, jobs.source),
          fingerprint = EXCLUDED.fingerprint,
          status = 'ACTIVE',
          "lastSeenAt" = now()
        RETURNING id, (xmax = 0) AS inserted,
                  -- Did the BODY actually change? xmax=0 marks an insert; for an
                  -- update this compares the incoming text to what was stored.
                  (xmax <> 0 AND jobs.description IS DISTINCT FROM EXCLUDED.description)
                    AS description_changed
      `;

      const restaleIds: string[] = [];
      for (const r of rows) {
        if (r.inserted) {
          created++;
          newJobIds.push(r.id);
        } else {
          updated++;
          if (r.description_changed) restaleIds.push(r.id);
        }
      }

      /**
       * THE EMBEDDING INVARIANT.
       *
       * A job's vector is built from its title + description. When the
       * description changes the vector is stale, and nothing refreshes it:
       * embedJobsByIds filters on `embedding: null` and the insert is
       * ON CONFLICT DO NOTHING, so a stale vector survives forever.
       *
       * That is silent and it corrupts RETRIEVAL, which gates judging. The
       * 2026-08-23 description repair hit it directly — 5,270 jobs had correct
       * text and vectors built from an EMPTY body, so the right job could be
       * invisible to the very query meant to find it.
       *
       * Deleting the row is what makes the existing path rebuild it: the job
       * re-enters `embedding: null` and the next embed tick re-embeds it.
       * Enqueued alongside genuinely new jobs below.
       */
      if (restaleIds.length > 0) {
        await this.prisma.jobEmbedding.deleteMany({ where: { jobId: { in: restaleIds } } });
        this.logger.log(
          `[${source ?? 'ingest'}] ${restaleIds.length} description(s) changed — stale embeddings cleared for re-embedding`,
        );
        newJobIds.push(...restaleIds);
      }
    }

    return { created, updated, duplicates, newJobIds };
  }

  /**
   * Post-crawl confidence maintenance: jobsExtracted once we've ever pulled
   * jobs, monitoringHealthy from the recent success rate. Weights live in
   * discovery.service.ts (computeConfidence) — duplicated intentionally NOT:
   * we import it.
   */
  private async updateConfidenceAfterCrawl(companyId: string, gotJobs: boolean): Promise<void> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { confidenceSignals: true },
    });
    const recent = await this.prisma.crawlRun.findMany({
      where: { companyId },
      orderBy: { startedAt: 'desc' },
      take: 10,
      select: { status: true },
    });
    const successes = recent.filter((r) => r.status === CrawlStatus.SUCCEEDED).length;
    const healthy = recent.length > 0 && successes / recent.length >= 0.7;

    const prev = (company?.confidenceSignals ?? {}) as Record<string, unknown>;
    const signals = {
      ...prev,
      websiteVerified: prev.websiteVerified === true,
      careerPageFound: true, // it's syncing a board — the page evidently exists
      atsDetected: true,
      jobsExtracted: prev.jobsExtracted === true || gotJobs,
      monitoringHealthy: healthy,
    };
    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        discoveryStage: DiscoveryStage.MONITORED,
        confidence: computeConfidence(signals),
        confidenceSignals: signals as object,
      },
    });
  }

  private async bumpNextCrawl(companyId: string, failed: boolean): Promise<void> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { crawlTier: true },
    });
    const interval = failed
      ? FAILURE_BACKOFF_MS
      : TIER_INTERVAL_MS[(company?.crawlTier ?? CrawlTier.WARM) as Tier];
    await this.prisma.company.update({
      where: { id: companyId },
      data: { nextCrawlAt: new Date(Date.now() + interval) },
    });
  }

  /**
   * Set the crawl tier + next-crawl time from the company's own hiring history:
   * frequent shippers get visited often, the quiet get backed off, the long-dead
   * go DORMANT (monthly). A watched company is always kept HOT — the user is
   * actively tracking it, so we crawl it eagerly regardless of recent volume.
   */
  private async applyAdaptiveSchedule(companyId: string): Promise<void> {
    const [stats] = await this.prisma.$queryRaw<
      [{ active: bigint; new14: bigint; last_new: Date | null; attempts: bigint; watched: bigint }]
    >`
      SELECT
        count(*) FILTER (WHERE status = 'ACTIVE') AS active,
        count(*) FILTER (WHERE COALESCE("postedAt", "firstSeenAt") > now() - interval '14 days') AS new14,
        max("firstSeenAt") AS last_new,
        (SELECT count(*) FROM crawl_runs WHERE "companyId" = ${companyId}) AS attempts,
        (SELECT count(*) FROM company_watches WHERE "companyId" = ${companyId}) AS watched
      FROM jobs WHERE "companyId" = ${companyId}
    `;

    const daysSinceLastNewJob = stats.last_new
      ? Math.floor((Date.now() - new Date(stats.last_new).getTime()) / 86_400_000)
      : null;
    let tier: Tier = adaptiveTier({
      newJobs14d: Number(stats.new14),
      activeJobs: Number(stats.active),
      daysSinceLastNewJob,
      crawlAttempts: Number(stats.attempts),
    });
    // Watchlist overrides adaptive backoff — never let a tracked company go cold.
    if (Number(stats.watched) > 0) tier = 'HOT';

    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        crawlTier: tier as CrawlTier,
        nextCrawlAt: new Date(Date.now() + TIER_INTERVAL_MS[tier]),
      },
    });
  }

  /** New jobs get embedded in the background — the incremental-matching path. */
  private async enqueueEmbeddings(jobIds: string[]): Promise<void> {
    if (jobIds.length === 0) return;
    for (let i = 0; i < jobIds.length; i += 100) {
      await this.embedQueue.add(
        'embed',
        { jobIds: jobIds.slice(i, i + 100) },
        {
          removeOnComplete: true,
          // NOT true. Discarding failures is how 79 repaired jobs ended up with no
          // vector on 2026-08-23 while the queue read active:0 failed:0 -- clean.
          // A stranded job stays ACTIVE and looks healthy in every count, so the
          // failed batch is the only evidence that it needs re-embedding.
          removeOnFail: 1000,
          attempts: 5,
          backoff: { type: 'exponential', delay: 60_000 },
        },
      );
    }
  }
}
