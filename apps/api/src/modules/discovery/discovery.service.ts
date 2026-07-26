import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AtsProvider, Company, CrawlTier, DiscoveryStage, Prisma } from '@prisma/client';
import type { CompanyCandidate, DiscoveryResult } from '@careeros/shared';
import { CRAWLABLE_PROVIDERS } from '@careeros/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { detectAts } from '../companies/ats-detector';

/**
 * Confidence signals → 0-100 score. The score answers: "how sure are we this
 * is a real, monitorable employer whose jobs we're actually receiving?"
 */
export interface ConfidenceSignals {
  websiteVerified: boolean;
  careerPageFound: boolean;
  atsDetected: boolean;
  jobsExtracted: boolean;
  monitoringHealthy: boolean;
}

const SIGNAL_WEIGHTS: Record<keyof ConfidenceSignals, number> = {
  websiteVerified: 15,
  careerPageFound: 20,
  atsDetected: 25,
  jobsExtracted: 25,
  monitoringHealthy: 15,
};

export function computeConfidence(signals: Partial<ConfidenceSignals>): number {
  let score = 0;
  for (const [key, weight] of Object.entries(SIGNAL_WEIGHTS)) {
    if (signals[key as keyof ConfidenceSignals]) score += weight;
  }
  return score;
}

/** Probe cooldowns: unresolved companies get retried, but with patience. */
const REPROBE_AFTER_DAYS: Partial<Record<DiscoveryStage, number>> = {
  [DiscoveryStage.DISCOVERED]: 7,
  [DiscoveryStage.WEBSITE_VERIFIED]: 7,
  [DiscoveryStage.CAREER_PAGE_FOUND]: 7,
  [DiscoveryStage.UNRESOLVABLE]: 30,
};

@Injectable()
export class DiscoveryService {
  private readonly logger = new Logger(DiscoveryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Bulk-register candidates from any discovery source. Dedupe order:
   * ATS identity (strongest) → website host → case-insensitive name.
   * Returns how many were genuinely new — the top of the conversion funnel.
   */
  async bulkDiscover(source: string, candidates: CompanyCandidate[]) {
    let created = 0;
    let merged = 0;

    let skipped = 0;
    for (const c of candidates) {
      // One bad candidate must never abort a 6,000-company batch. Every DB path
      // below (the website dedup, the enrich-update, the create) can hit the
      // UNIQUE(website) constraint — Places returns the same website for many
      // differently-named listings (franchises, SEO doorway pages, shared
      // domains) that the host-substring dedup can miss. Contain each row.
      try {
        const detected = c.atsHintUrl ? detectAts(c.atsHintUrl) : null;

        let existing: Company | null = null;
        if (detected?.identifier) {
          existing = await this.prisma.company.findUnique({
            where: {
              atsProvider_atsIdentifier: {
                atsProvider: detected.provider,
                atsIdentifier: detected.identifier,
              },
            },
          });
        }
        if (!existing && c.website) {
          existing = await this.prisma.company.findFirst({
            where: { website: { contains: this.hostOf(c.website), mode: 'insensitive' } },
          });
        }
        if (!existing) {
          existing = await this.prisma.company.findFirst({
            where: { name: { equals: c.name, mode: 'insensitive' } },
          });
        }

        if (existing) {
          merged++;
          // Enrich blanks — never overwrite existing data with directory data.
          await this.prisma.company.update({
            where: { id: existing.id },
            data: {
              website: existing.website ?? c.website ?? undefined,
              industry: existing.industry ?? c.industry ?? undefined,
              country: existing.country ?? c.country ?? undefined,
              city: existing.city ?? c.city ?? undefined,
              teamSize: existing.teamSize ?? c.teamSize ?? undefined,
              description: existing.description ?? c.description ?? undefined,
            },
          });
          continue;
        }

        const monitorable =
          detected?.identifier && CRAWLABLE_PROVIDERS.includes(detected.provider);
        await this.prisma.company.create({
          data: {
            name: c.name,
            website: c.website ?? undefined,
            careerPageUrl: c.atsHintUrl ?? undefined,
            atsProvider: detected?.identifier ? detected.provider : AtsProvider.UNKNOWN,
            atsIdentifier: detected?.identifier ?? undefined,
            industry: c.industry ?? undefined,
            country: c.country ?? undefined,
            city: c.city ?? undefined,
            teamSize: c.teamSize ?? undefined,
            description: c.description ?? undefined,
            discoverySource: source,
            discoveryStage: monitorable ? DiscoveryStage.MONITORED : DiscoveryStage.DISCOVERED,
            confidence: computeConfidence({
              websiteVerified: false,
              atsDetected: !!detected?.identifier,
            }),
            confidenceSignals: { atsDetected: !!detected?.identifier } as object,
            nextCrawlAt: new Date(), // monitorable ones get crawled on the next tick
          },
        });
        created++;
      } catch (err) {
        // A duplicate (P2002) is expected and fine — it is already in the DB.
        // Anything else, log once and keep going; coverage beats perfection.
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
          this.logger.warn(
            `bulk-discover[${source}] skipped "${c.name}": ${err instanceof Error ? err.message.slice(0, 120) : err}`,
          );
        }
        skipped++;
      }
    }
    if (skipped) this.logger.log(`bulk-discover[${source}]: ${skipped} skipped (dup/error)`);

    this.logger.log(`bulk-discover[${source}]: ${created} new, ${merged} merged`);
    return { created, merged };
  }

  /** Companies the prober should work on now (batched, oldest-probed first). */
  probeDue(limit: number) {
    const now = Date.now();
    const or: Prisma.CompanyWhereInput[] = Object.entries(REPROBE_AFTER_DAYS).map(
      ([stage, days]) => ({
        discoveryStage: stage as DiscoveryStage,
        OR: [
          { lastProbedAt: null },
          { lastProbedAt: { lt: new Date(now - days * 24 * 60 * 60 * 1000) } },
        ],
      }),
    );
    return this.prisma.company.findMany({
      where: { OR: or },
      orderBy: [{ lastProbedAt: { sort: 'asc', nulls: 'first' } }],
      take: limit,
      select: {
        id: true,
        name: true,
        website: true,
        careerPageUrl: true,
        discoveryStage: true,
      },
    });
  }

  /** Apply what the prober found: stage transition + confidence recompute. */
  async applyResult(companyId: string, result: DiscoveryResult) {
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw new NotFoundException('Company not found');

    const prevSignals = (company.confidenceSignals ?? {}) as Partial<ConfidenceSignals>;
    const atsProvider = result.atsProvider ? AtsProvider[result.atsProvider] : null;
    const monitorable =
      !!atsProvider &&
      !!result.atsIdentifier &&
      CRAWLABLE_PROVIDERS.includes(result.atsProvider!);

    // Detected board already claimed by another company row? Merge signal — skip claim.
    if (monitorable) {
      const claimed = await this.prisma.company.findUnique({
        where: {
          atsProvider_atsIdentifier: {
            atsProvider: atsProvider!,
            atsIdentifier: result.atsIdentifier!,
          },
        },
      });
      if (claimed && claimed.id !== companyId) {
        await this.prisma.company.update({
          where: { id: companyId },
          data: {
            discoveryStage: DiscoveryStage.UNRESOLVABLE,
            lastProbedAt: new Date(),
            confidenceSignals: {
              ...prevSignals,
              duplicateOf: claimed.id,
              probeLog: result.probeLog,
            } as object,
          },
        });
        return { stage: DiscoveryStage.UNRESOLVABLE, duplicateOf: claimed.id };
      }
    }

    const signals: Partial<ConfidenceSignals> = {
      ...prevSignals,
      websiteVerified: result.websiteVerified,
      careerPageFound: !!result.careerPageUrl,
      atsDetected: !!result.atsIdentifier,
    };

    let stage: DiscoveryStage;
    if (monitorable) stage = DiscoveryStage.MONITORED;
    else if (result.careerPageUrl) stage = DiscoveryStage.CAREER_PAGE_FOUND;
    else if (result.websiteVerified) stage = DiscoveryStage.WEBSITE_VERIFIED;
    else stage = DiscoveryStage.UNRESOLVABLE; // dead website — monthly retry

    const data: Prisma.CompanyUpdateInput = {
      discoveryStage: stage,
      lastProbedAt: new Date(),
      website: result.website ?? company.website,
      careerPageUrl: result.careerPageUrl ?? company.careerPageUrl,
      ...(monitorable
        ? {
            atsProvider: atsProvider!,
            atsIdentifier: result.atsIdentifier!,
            crawlTier: CrawlTier.WARM,
            nextCrawlAt: new Date(), // first crawl on the next 15-min tick
          }
        : {}),
      description: company.description ?? result.metadata?.description ?? undefined,
      githubOrg: company.githubOrg ?? result.metadata?.githubOrg ?? undefined,
      engineeringBlogUrl: company.engineeringBlogUrl ?? result.metadata?.blogUrl ?? undefined,
      confidence: computeConfidence(signals),
      confidenceSignals: { ...signals, probeLog: result.probeLog } as object,
    };

    try {
      await this.prisma.company.update({ where: { id: companyId }, data });
    } catch (err) {
      // The probe resolved to a website another company already owns (redirects
      // to a parent domain, shared host). Keep this company's own website and
      // still save the probe outcome — the stage matters more than the URL.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        await this.prisma.company.update({
          where: { id: companyId },
          data: { ...data, website: company.website },
        });
      } else {
        throw err;
      }
    }

    return { stage };
  }

  /** "https://www.stripe.com/about" → "stripe.com" — dedupe key for websites. */
  private hostOf(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  /**
   * The Phase B success metric: % of discovered companies now monitored —
   * overall AND per discovery source, because conversion is a property of
   * seed quality (name-only boards ≪ curated directories with websites).
   */
  async funnelStats() {
    const rows = await this.prisma.company.groupBy({
      by: ['discoveryStage'],
      _count: { _all: true },
    });
    const byStage = Object.fromEntries(
      rows.map((r) => [r.discoveryStage, r._count._all]),
    ) as Record<string, number>;
    const total = rows.reduce((s, r) => s + r._count._all, 0);
    const monitored = byStage[DiscoveryStage.MONITORED] ?? 0;

    const perSource = await this.prisma.company.groupBy({
      by: ['discoverySource', 'discoveryStage'],
      _count: { _all: true },
    });
    const bySource: Record<string, { total: number; monitored: number; conversionRate: number }> =
      {};
    for (const row of perSource) {
      const key = row.discoverySource ?? 'manual';
      bySource[key] ??= { total: 0, monitored: 0, conversionRate: 0 };
      bySource[key].total += row._count._all;
      if (row.discoveryStage === DiscoveryStage.MONITORED) {
        bySource[key].monitored += row._count._all;
      }
    }
    for (const s of Object.values(bySource)) {
      s.conversionRate = s.total > 0 ? Math.round((s.monitored / s.total) * 1000) / 10 : 0;
    }

    return {
      total,
      byStage,
      monitored,
      conversionRate: total > 0 ? Math.round((monitored / total) * 1000) / 10 : 0,
      bySource,
    };
  }

  /**
   * Career pages worth a deterministic-extractor pass: a career page is known
   * but no ATS was detected (the custom/JS long tail). Prioritised by target
   * city so the cities the user cares about get covered first; randomised within
   * so repeated runs spread across the pool (no per-company extractedAt yet).
   */
  async careerPagesDue(limit = 30) {
    // Priority: watched-by-anyone → target city → never/least-recently extracted.
    // The same statement CLAIMS the batch (sets lastExtractedAt) so runs rotate
    // through the corpus instead of re-fetching the same pages every 6h.
    return this.prisma.$queryRaw<Array<{ id: string; name: string; careerPageUrl: string }>>`
      WITH due AS (
        SELECT c.id
        FROM companies c
        WHERE c."careerPageUrl" IS NOT NULL
          AND c."atsProvider" = 'UNKNOWN'
          AND c."discoveryStage" <> 'UNRESOLVABLE'
        ORDER BY
          EXISTS (SELECT 1 FROM company_watches w WHERE w."companyId" = c.id) DESC,
          (c.city IN ('Bangalore','Bengaluru','Pune','Hyderabad','Mumbai','Indore','Gurgaon','Gurugram','Noida','Chennai','Ahmedabad','Kolkata')) DESC,
          c."lastExtractedAt" ASC NULLS FIRST,
          c.id
        LIMIT ${Math.min(100, Math.max(1, limit))}
      )
      UPDATE companies SET "lastExtractedAt" = now()
      WHERE id IN (SELECT id FROM due)
      RETURNING id, name, "careerPageUrl"
    `;
  }

  /**
   * Store (or replace) the preprocessed HTML snapshot for a company's career
   * page. One latest snapshot per company — this is the raw material the replay
   * queue re-mines when the extractor improves. HTML is capped upstream (~500KB).
   */
  async storeSnapshot(input: {
    companyId: string;
    url: string;
    html: string;
    extractorVersion: string;
    confidence: number;
    jobsAccepted: number;
    candidateCount: number;
  }) {
    const data = {
      url: input.url,
      html: input.html,
      extractorVersion: input.extractorVersion,
      confidence: input.confidence,
      jobsAccepted: input.jobsAccepted,
      candidateCount: input.candidateCount,
    };
    await this.prisma.extractionSnapshot.upsert({
      where: { companyId: input.companyId },
      create: { companyId: input.companyId, fetchedAt: new Date(), ...data },
      // A store from a live crawl refreshes fetchedAt; a store from replay keeps
      // the original fetchedAt (html unchanged) but advances the version.
      update: { ...data, fetchedAt: new Date() },
    });
    return { ok: true };
  }

  /**
   * Snapshots that a newer extractor hasn't processed yet — the replay backlog.
   * Claims the batch (sets replayedAt) so runs rotate and don't re-hand the same
   * pages. `version` is the caller's current extractor version; anything stored
   * under a different version is replay-eligible.
   */
  async snapshotsReplayDue(version: string, limit = 50) {
    return this.prisma.$queryRaw<
      Array<{ companyId: string; name: string; url: string; html: string }>
    >`
      WITH due AS (
        SELECT s."companyId"
        FROM extraction_snapshots s
        WHERE s."extractorVersion" <> ${version}
        ORDER BY s."replayedAt" ASC NULLS FIRST, s."fetchedAt" ASC
        LIMIT ${Math.min(200, Math.max(1, limit))}
      )
      UPDATE extraction_snapshots s SET "replayedAt" = now()
      FROM companies c
      WHERE s."companyId" IN (SELECT "companyId" FROM due) AND c.id = s."companyId"
      RETURNING s."companyId" AS "companyId", c.name AS name, s.url AS url, s.html AS html
    `;
  }

  /** How much of the corpus is captured + how far behind the current extractor. */
  async replayStatus(version: string) {
    const [row] = await this.prisma.$queryRaw<
      [{ total: bigint; behind: bigint; accepted: bigint; avgconf: number | null }]
    >`
      SELECT count(*) AS total,
             count(*) FILTER (WHERE "extractorVersion" <> ${version}) AS behind,
             COALESCE(sum("jobsAccepted"), 0) AS accepted,
             avg(confidence) AS avgconf
      FROM extraction_snapshots
    `;
    return {
      snapshots: Number(row.total),
      behindCurrentVersion: Number(row.behind),
      jobsAccepted: Number(row.accepted),
      avgConfidence: row.avgconf == null ? 0 : Math.round(Number(row.avgconf)),
      currentVersion: version,
    };
  }

  /** Persist one extraction/replay run's telemetry — the pipeline dashboard's source. */
  async recordExtractionRun(m: {
    kind: string;
    extractorVersion: string;
    companiesQueued: number;
    fetched: number;
    fetchFailed: number;
    pagesWithJobs: number;
    jobsExtracted: number;
    jobsIngested: number;
    duplicates: number;
    snapshotted: number;
    avgConfidence: number;
    avgFetchMs: number;
    avgParseMs: number;
    totalMs: number;
    rejections: Record<string, number>;
  }) {
    await this.prisma.extractionRun.create({
      data: { ...m, rejections: m.rejections as object },
    });
    return { ok: true };
  }

  /**
   * The whole discovery pipeline as one picture: the extraction funnel
   * (queued → fetched → parsed → accepted → ingested) and quality (avg
   * confidence, jobs/page, duplicates, latency, top rejection reasons) over the
   * last 7 days, plus the global embed → rank stages. This is where a bottleneck
   * becomes obvious instead of hypothetical.
   */
  async pipelineMetrics() {
    const [agg] = await this.prisma.$queryRaw<
      [
        {
          runs: bigint;
          queued: bigint;
          fetched: bigint;
          fetch_failed: bigint;
          with_jobs: bigint;
          accepted: bigint;
          ingested: bigint;
          duplicates: bigint;
          snapshotted: bigint;
          avg_conf: number | null;
          avg_fetch: number | null;
          avg_parse: number | null;
        },
      ]
    >`
      SELECT count(*) AS runs,
             COALESCE(sum("companiesQueued"), 0) AS queued,
             COALESCE(sum(fetched), 0) AS fetched,
             COALESCE(sum("fetchFailed"), 0) AS fetch_failed,
             COALESCE(sum("pagesWithJobs"), 0) AS with_jobs,
             COALESCE(sum("jobsExtracted"), 0) AS accepted,
             COALESCE(sum("jobsIngested"), 0) AS ingested,
             COALESCE(sum(duplicates), 0) AS duplicates,
             COALESCE(sum(snapshotted), 0) AS snapshotted,
             round(avg(NULLIF("avgConfidence", 0))) AS avg_conf,
             round(avg(NULLIF("avgFetchMs", 0))) AS avg_fetch,
             round(avg(NULLIF("avgParseMs", 0))) AS avg_parse
      FROM extraction_runs
      WHERE "createdAt" > now() - interval '7 days'
    `;

    // Merge rejection maps across recent runs in JS — small, and JSONB summing
    // in SQL is not worth the ceremony at this volume.
    const recent = await this.prisma.extractionRun.findMany({
      where: { createdAt: { gt: new Date(Date.now() - 7 * 86_400_000) } },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { rejections: true },
    });
    const rejMap: Record<string, number> = {};
    for (const r of recent) {
      const rej = (r.rejections ?? {}) as Record<string, number>;
      for (const [k, v] of Object.entries(rej)) rejMap[k] = (rejMap[k] ?? 0) + Number(v);
    }
    const topRejections = Object.entries(rejMap)
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);

    const [stages] = await this.prisma.$queryRaw<
      [{ active_jobs: bigint; embedded: bigint; ranked: bigint }]
    >`
      SELECT
        (SELECT count(*) FROM jobs WHERE status = 'ACTIVE') AS active_jobs,
        (SELECT count(*) FROM job_embeddings je JOIN jobs j ON j.id = je."jobId" AND j.status = 'ACTIVE') AS embedded,
        (SELECT count(DISTINCT "jobId") FROM job_matches) AS ranked
    `;

    const withJobs = Number(agg.with_jobs);
    const accepted = Number(agg.accepted);
    return {
      window: '7d',
      runs: Number(agg.runs),
      funnel: {
        queued: Number(agg.queued),
        fetched: Number(agg.fetched),
        fetchFailed: Number(agg.fetch_failed),
        parsed: withJobs, // pages that produced >=1 accepted job
        accepted,
        ingested: Number(agg.ingested),
        duplicates: Number(agg.duplicates),
        snapshotted: Number(agg.snapshotted),
      },
      quality: {
        avgConfidence: agg.avg_conf == null ? 0 : Number(agg.avg_conf),
        jobsPerPage: withJobs > 0 ? Math.round((accepted / withJobs) * 10) / 10 : 0,
        avgFetchMs: agg.avg_fetch == null ? 0 : Number(agg.avg_fetch),
        avgParseMs: agg.avg_parse == null ? 0 : Number(agg.avg_parse),
        topRejections,
      },
      stages: {
        activeJobs: Number(stages.active_jobs),
        embedded: Number(stages.embedded),
        ranked: Number(stages.ranked),
      },
    };
  }

  /** Flag companies whose career pages are JS app shells — the render tier's queue. */
  async flagForRender(companyIds: string[]) {
    if (companyIds.length === 0) return { flagged: 0 };
    const res = await this.prisma.company.updateMany({
      where: { id: { in: companyIds }, needsRender: false },
      data: { needsRender: true },
    });
    return { flagged: res.count };
  }

  /**
   * Companies flagged for rendering, claimed (lastRenderedAt bumped) so runs
   * rotate. Prioritised watched → target-city → least-recently-rendered, same as
   * the static extractor. Returns the URL the render service should load.
   */
  async renderDue(limit = 20) {
    return this.prisma.$queryRaw<Array<{ id: string; name: string; careerPageUrl: string }>>`
      WITH due AS (
        SELECT c.id
        FROM companies c
        WHERE c."needsRender" = true
          AND c."careerPageUrl" IS NOT NULL
          AND c."discoveryStage" <> 'UNRESOLVABLE'
        ORDER BY
          EXISTS (SELECT 1 FROM company_watches w WHERE w."companyId" = c.id) DESC,
          (c.city IN ('Bangalore','Bengaluru','Pune','Hyderabad','Mumbai','Indore','Gurgaon','Gurugram','Noida','Chennai','Ahmedabad','Kolkata')) DESC,
          c."lastRenderedAt" ASC NULLS FIRST,
          c.id
        LIMIT ${Math.min(50, Math.max(1, limit))}
      )
      UPDATE companies SET "lastRenderedAt" = now()
      WHERE id IN (SELECT id FROM due)
      RETURNING id, name, "careerPageUrl"
    `;
  }

  /** Render-tier health: how many pages are flagged, and how many rendered. */
  async renderHealth() {
    const [row] = await this.prisma.$queryRaw<
      [{ flagged: bigint; rendered: bigint; jobs: bigint }]
    >`
      SELECT
        count(*) FILTER (WHERE "needsRender" = true) AS flagged,
        count(*) FILTER (WHERE "needsRender" = true AND "lastRenderedAt" IS NOT NULL) AS rendered,
        (SELECT count(*) FROM jobs WHERE source LIKE 'career-render%' AND status = 'ACTIVE') AS jobs
      FROM companies
    `;
    const flagged = Number(row.flagged);
    const rendered = Number(row.rendered);
    return {
      flagged,
      rendered,
      pending: flagged - rendered,
      jobsFromRender: Number(row.jobs),
      renderedPct: flagged > 0 ? Math.round((rendered / flagged) * 100) : 0,
    };
  }

  /** Operational health of the deterministic career-page extractor. */
  async extractionHealth() {
    const [runs] = await this.prisma.$queryRaw<
      [{ runs: bigint; found: bigint; created: bigint; last: Date | null }]
    >`
      SELECT count(*) AS runs, COALESCE(sum("jobsFound"), 0) AS found,
             COALESCE(sum("jobsNew"), 0) AS created, max("startedAt") AS last
      FROM crawl_runs WHERE source LIKE 'career-page%'
    `;
    const [corpus] = await this.prisma.$queryRaw<[{ total: bigint; extracted: bigint }]>`
      SELECT count(*) AS total,
             count(*) FILTER (WHERE "lastExtractedAt" IS NOT NULL) AS extracted
      FROM companies
      WHERE "careerPageUrl" IS NOT NULL AND "atsProvider" = 'UNKNOWN'
    `;
    const [jobs] = await this.prisma.$queryRaw<[{ n: bigint }]>`
      SELECT count(*) AS n FROM jobs WHERE "externalId" LIKE 'careerpage-%' AND status = 'ACTIVE'
    `;
    const total = Number(corpus.total);
    const extracted = Number(corpus.extracted);
    return {
      runs: Number(runs.runs),
      jobsExtracted: Number(jobs.n),
      companiesTotal: total,
      companiesProcessed: extracted,
      processedPct: total > 0 ? Math.round((extracted / total) * 100) : 0,
      lastRun: runs.last,
    };
  }

  /**
   * Adaptive-crawl health: how the monitored corpus is distributed across tiers,
   * so the dead-company backoff is visible. A large DORMANT count is a good sign
   * — it means the scheduler stopped wasting crawls on companies that never post.
   */
  async crawlScheduleHealth() {
    const rows = await this.prisma.company.groupBy({
      by: ['crawlTier'],
      where: { discoveryStage: DiscoveryStage.MONITORED },
      _count: { _all: true },
    });
    const byTier: Record<string, number> = { HOT: 0, WARM: 0, COLD: 0, DORMANT: 0 };
    for (const r of rows) byTier[r.crawlTier] = r._count._all;
    const total = Object.values(byTier).reduce((a, b) => a + b, 0);
    return {
      total,
      hot: byTier.HOT,
      warm: byTier.WARM,
      cold: byTier.COLD,
      dormant: byTier.DORMANT,
      dormantPct: total > 0 ? Math.round((byTier.DORMANT / total) * 100) : 0,
    };
  }

  /**
   * Discovery coverage per city — the observability the funnel was missing.
   * For each city we know: companies discovered → career pages found → ATS
   * detected → monitored → actually hiring → engineering roles open. Coverage %
   * is monitored/known: it shows exactly where we're blind, not just a total.
   */
  async cityCoverage() {
    const rows = await this.prisma.$queryRaw<
      Array<{
        city: string;
        companies: bigint;
        career_pages: bigint;
        ats_detected: bigint;
        monitored: bigint;
        hiring: bigint;
        active_jobs: bigint;
        dev_jobs: bigint;
      }>
    >`
      SELECT c.city AS city,
             count(*) AS companies,
             count(*) FILTER (WHERE c."careerPageUrl" IS NOT NULL) AS career_pages,
             count(*) FILTER (WHERE c."atsProvider" <> 'UNKNOWN') AS ats_detected,
             count(*) FILTER (WHERE c."discoveryStage" = 'MONITORED') AS monitored,
             count(*) FILTER (WHERE COALESCE(j.active_jobs, 0) > 0) AS hiring,
             COALESCE(sum(j.active_jobs), 0) AS active_jobs,
             COALESCE(sum(j.dev_jobs), 0) AS dev_jobs
      FROM companies c
      LEFT JOIN (
        SELECT "companyId",
               count(*) FILTER (WHERE status = 'ACTIVE') AS active_jobs,
               count(*) FILTER (
                 WHERE status = 'ACTIVE'
                   AND title ~* 'full.?stack|node|react|mern|back.?end|software|developer|engineer'
               ) AS dev_jobs
        FROM jobs GROUP BY "companyId"
      ) j ON j."companyId" = c.id
      WHERE c.city IS NOT NULL AND c.city <> ''
      GROUP BY c.city
      HAVING count(*) >= 3
      ORDER BY companies DESC
      LIMIT 30
    `;

    return rows.map((r) => {
      const companies = Number(r.companies);
      const monitored = Number(r.monitored);
      return {
        city: r.city,
        companies,
        careerPages: Number(r.career_pages),
        atsDetected: Number(r.ats_detected),
        monitored,
        hiring: Number(r.hiring),
        activeJobs: Number(r.active_jobs),
        devJobs: Number(r.dev_jobs),
        coverage: companies > 0 ? Math.round((monitored / companies) * 100) : 0,
      };
    });
  }
}
