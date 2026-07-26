import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Source Trust — how much to weight a job by where it came from. A structured
 * ATS feed (Ashby, Greenhouse) is near-authoritative; an aggregator is good but
 * noisier; our own deterministic extractor is decent but precision-limited. The
 * score starts from a curated baseline and is nudged by OBSERVED quality (does
 * the source keep stale posts around? are its listings fresh?), so it's dynamic
 * without being jittery. It feeds a small, bounded adjustment into the
 * Opportunity Score — never a large lever, but a real one.
 */

// Curated priors. Structured, first-party feeds rank highest; aggregators high
// but noisier; our extractor mid — high precision, unverified against the source.
const BASELINES: Record<string, number> = {
  ashby: 100,
  greenhouse: 100,
  lever: 99,
  workday: 99,
  smartrecruiters: 96,
  workable: 95,
  recruitee: 94,
  teamtailor: 94,
  breezy: 92,
  adzuna: 92,
  jooble: 90,
  remoteok: 88,
  'hn-hiring': 82,
};
const DEFAULT_BASELINE = 85;

/** Baseline prior for a source string. Career-page/replay share one prior. */
export function baselineFor(source: string): number {
  if (source.startsWith('career-page') || source.startsWith('career-replay')) return 94;
  return BASELINES[source] ?? DEFAULT_BASELINE;
}

export interface SourceStats {
  seen: number; // all jobs ever ingested from this source
  active: number; // currently ACTIVE
  removed: number; // taken down
  stale: number; // ACTIVE but > 60 days old — source isn't pruning dead posts
  fresh: number; // ACTIVE and < 14 days old — a lively source
}

/**
 * baseline + freshness bonus − stale penalty, clamped [40, 100]. A source that
 * lets old posts rot loses trust; one whose live jobs are mostly fresh gains a
 * little. Bounded so data can nudge but never swamp the curated prior.
 */
export function computeTrustScore(baseline: number, s: SourceStats): number {
  if (s.active === 0) return baseline; // nothing live yet — trust the prior
  const staleRate = s.stale / s.active;
  const freshShare = s.fresh / s.active;
  const stalePenalty = Math.round(Math.min(12, staleRate * 12));
  const freshBonus = Math.round(Math.min(5, freshShare * 5));
  return Math.max(40, Math.min(100, baseline + freshBonus - stalePenalty));
}

const CACHE_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class SourceTrustService {
  private readonly logger = new Logger(SourceTrustService.name);
  private cache: { at: number; map: Map<string, number> } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Recompute every source's trust from live job data and upsert the table.
   * Cheap (one grouped aggregate) — run daily. Returns the fresh rows.
   */
  async recompute() {
    const rows = await this.prisma.$queryRaw<
      Array<{
        source: string;
        seen: bigint;
        active: bigint;
        removed: bigint;
        stale: bigint;
        fresh: bigint;
      }>
    >`
      SELECT source,
             count(*) AS seen,
             count(*) FILTER (WHERE status = 'ACTIVE') AS active,
             count(*) FILTER (WHERE status = 'REMOVED') AS removed,
             count(*) FILTER (WHERE status = 'ACTIVE' AND "firstSeenAt" < now() - interval '60 days') AS stale,
             count(*) FILTER (WHERE status = 'ACTIVE' AND "firstSeenAt" > now() - interval '14 days') AS fresh
      FROM jobs
      WHERE source IS NOT NULL
      GROUP BY source
    `;

    const out: Array<{ source: string; trustScore: number; baseline: number }> = [];
    for (const r of rows) {
      const stats: SourceStats = {
        seen: Number(r.seen),
        active: Number(r.active),
        removed: Number(r.removed),
        stale: Number(r.stale),
        fresh: Number(r.fresh),
      };
      const baseline = baselineFor(r.source);
      const trustScore = computeTrustScore(baseline, stats);
      await this.prisma.sourceTrust.upsert({
        where: { source: r.source },
        create: {
          source: r.source,
          baseline,
          trustScore,
          jobsSeen: stats.seen,
          jobsActive: stats.active,
          jobsRemoved: stats.removed,
          jobsStale: stats.stale,
          jobsFresh: stats.fresh,
        },
        update: {
          baseline,
          trustScore,
          jobsSeen: stats.seen,
          jobsActive: stats.active,
          jobsRemoved: stats.removed,
          jobsStale: stats.stale,
          jobsFresh: stats.fresh,
          computedAt: new Date(),
        },
      });
      out.push({ source: r.source, trustScore, baseline });
    }
    this.cache = null; // invalidate
    this.logger.log(`source-trust recomputed for ${out.length} sources`);
    return { sources: out.length, rows: out.sort((a, b) => b.trustScore - a.trustScore) };
  }

  /** Cached source→trust map (5-min TTL) for hot scoring paths. */
  async trustMap(): Promise<Map<string, number>> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.map;
    const rows = await this.prisma.sourceTrust.findMany({
      select: { source: true, trustScore: true },
    });
    const map = new Map(rows.map((r) => [r.source, r.trustScore]));
    this.cache = { at: Date.now(), map };
    return map;
  }

  /** Trust for one source: live value if computed, else the baseline prior. */
  async trustFor(source: string | null | undefined): Promise<number | null> {
    if (!source) return null;
    const map = await this.trustMap();
    return map.get(source) ?? baselineFor(source);
  }

  /** All rows for the Discovery Health dashboard, most trusted first. */
  list() {
    return this.prisma.sourceTrust.findMany({ orderBy: { trustScore: 'desc' } });
  }
}
