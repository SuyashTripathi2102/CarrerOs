import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CrawlStatus, JobStatus } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';

const QUEUES = [
  'refresh-all',
  'crawl-company',
  'crawl-board',
  'discovery-fanout',
  'discover-company',
  'seed-import',
  'embed-jobs',
  'match-new-jobs',
  'generate-matches',
  'derive-intel',
];

/**
 * Internal health dashboard (ChatGPT-review request, C.5): one endpoint that
 * answers "is the machine alive and what did it do today" — invaluable the
 * first time something breaks silently on the VPS.
 */
@Controller('admin/health')
export class AdminController {
  private readonly redisUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.redisUrl = config.get<string>('REDIS_URL', 'redis://localhost:6379');
  }

  @Get()
  async health() {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [
      companiesByStage,
      activeJobs,
      jobsToday,
      matchesTotal,
      notificationsToday,
      runs24h,
      failingCompanies,
      lastRun,
    ] = await Promise.all([
      this.prisma.company.groupBy({ by: ['discoveryStage'], _count: { _all: true } }),
      this.prisma.job.count({ where: { status: JobStatus.ACTIVE } }),
      this.prisma.job.count({ where: { firstSeenAt: { gte: dayAgo } } }),
      this.prisma.jobMatch.count(),
      this.prisma.notification.count({ where: { createdAt: { gte: dayAgo } } }),
      this.prisma.crawlRun.groupBy({
        by: ['status'],
        where: { startedAt: { gte: dayAgo } },
        _count: { _all: true },
      }),
      // Companies whose last 3 runs ALL failed — the "silently broken" list.
      this.prisma.$queryRaw<{ id: string; name: string; fails: bigint }[]>`
        SELECT c.id, c.name, count(*) AS fails FROM companies c
        JOIN LATERAL (
          SELECT status FROM crawl_runs r
          WHERE r."companyId" = c.id ORDER BY r."startedAt" DESC LIMIT 3
        ) recent ON true
        WHERE recent.status = 'FAILED'
        GROUP BY c.id, c.name HAVING count(*) >= 3
      `,
      this.prisma.crawlRun.findFirst({
        orderBy: { startedAt: 'desc' },
        select: { startedAt: true, source: true, status: true },
      }),
    ]);

    const queues: Record<string, unknown> = {};
    for (const name of QUEUES) {
      const q = new Queue(name, { connection: { url: this.redisUrl } });
      try {
        const counts = await q.getJobCounts('waiting', 'active', 'delayed', 'failed');
        queues[name] = counts;
      } catch {
        queues[name] = { error: 'unreachable' };
      } finally {
        await q.close().catch(() => undefined);
      }
    }

    const succeeded =
      runs24h.find((r) => r.status === CrawlStatus.SUCCEEDED)?._count._all ?? 0;
    const totalRuns = runs24h.reduce((s, r) => s + r._count._all, 0);

    // Observability v1: derived from timestamps we already store — no metrics
    // infrastructure needed until real Prometheus arrives with multi-box deploy.
    const [derived] = await this.prisma.$queryRaw<
      {
        avg_crawl_seconds: number | null;
        avg_notify_latency_minutes: number | null;
        matches_today: bigint;
      }[]
    >`
      SELECT
        (SELECT avg(EXTRACT(EPOCH FROM ("finishedAt" - "startedAt")))
           FROM crawl_runs
          WHERE "startedAt" >= ${dayAgo} AND "finishedAt" IS NOT NULL) AS avg_crawl_seconds,
        (SELECT avg(EXTRACT(EPOCH FROM (m."notifiedAt" - j."firstSeenAt")) / 60)
           FROM job_matches m JOIN jobs j ON j.id = m."jobId"
          WHERE m."notifiedAt" >= ${dayAgo}) AS avg_notify_latency_minutes,
        (SELECT count(*) FROM job_matches WHERE "createdAt" >= ${dayAgo}) AS matches_today
    `;

    return {
      timestamp: new Date().toISOString(),
      metrics24h: {
        avgCrawlSeconds:
          derived.avg_crawl_seconds != null ? Math.round(derived.avg_crawl_seconds * 10) / 10 : null,
        avgJobToNotificationMinutes:
          derived.avg_notify_latency_minutes != null
            ? Math.round(derived.avg_notify_latency_minutes)
            : null,
        matchesCreated: Number(derived.matches_today),
      },
      companies: Object.fromEntries(
        companiesByStage.map((r) => [r.discoveryStage, r._count._all]),
      ),
      jobs: { active: activeJobs, newLast24h: jobsToday },
      matches: matchesTotal,
      notificationsLast24h: notificationsToday,
      crawls24h: {
        total: totalRuns,
        successRate: totalRuns > 0 ? Math.round((succeeded / totalRuns) * 100) : null,
        lastRun,
      },
      failingCompanies: failingCompanies.map((c) => ({ id: c.id, name: c.name })),
      queues,
    };
  }
}
