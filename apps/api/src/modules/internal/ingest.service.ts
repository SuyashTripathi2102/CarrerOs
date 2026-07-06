import { Injectable, Logger } from '@nestjs/common';
import { CrawlStatus, JobStatus, Prisma } from '@prisma/client';
import type { BoardJob, NormalizedJob } from '@jobintel/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { CompaniesService } from '../companies/companies.service';

export interface SyncResult {
  crawlRunId: string;
  found: number;
  created: number;
  updated: number;
  removed: number;
}

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly companies: CompaniesService,
  ) {}

  /**
   * Full-board sync for one company: upsert what the crawler saw, mark what
   * disappeared as REMOVED, record a CrawlRun. Never deletes — history is
   * a feature (application tracker's "position filled" signal).
   */
  async syncCompanyJobs(
    companyId: string,
    source: string,
    jobs: NormalizedJob[],
  ): Promise<SyncResult> {
    const run = await this.prisma.crawlRun.create({
      data: { companyId, source, status: CrawlStatus.RUNNING },
    });

    try {
      let created = 0;
      let updated = 0;

      for (const job of jobs) {
        const result = await this.upsertJob(companyId, job);
        if (result === 'created') created++;
        else updated++;
      }

      // Anything ACTIVE we did NOT see this run has been taken down.
      const seenIds = jobs.map((j) => j.externalId);
      const { count: removed } = await this.prisma.job.updateMany({
        where: {
          companyId,
          status: JobStatus.ACTIVE,
          externalId: { notIn: seenIds },
        },
        data: { status: JobStatus.REMOVED },
      });

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
      throw err;
    }
  }

  /**
   * Board ingest (RemoteOK, HN...): jobs arrive with company info instead of
   * a companyId. Companies are found-or-created — the discovery flywheel.
   * No removed-detection here: a job leaving a board says nothing about the
   * company's own career page.
   */
  async ingestBoardJobs(source: string, entries: BoardJob[]): Promise<SyncResult> {
    const run = await this.prisma.crawlRun.create({
      data: { source, status: CrawlStatus.RUNNING },
    });

    let created = 0;
    let updated = 0;
    let failures = 0;

    for (const entry of entries) {
      try {
        const company = await this.companies.findOrCreateFromBoard(entry.company);
        const result = await this.upsertJob(company.id, entry.job);
        if (result === 'created') created++;
        else updated++;
      } catch (err) {
        failures++;
        this.logger.warn(
          `Board ingest skipped "${entry.job.title}" @ ${entry.company.name}: ${err instanceof Error ? err.message : err}`,
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
        error: failures > 0 ? `${failures} entries failed` : null,
      },
    });

    return { crawlRunId: run.id, found: entries.length, created, updated, removed: 0 };
  }

  private async upsertJob(
    companyId: string,
    job: NormalizedJob,
  ): Promise<'created' | 'updated'> {
    const existing = await this.prisma.job.findUnique({
      where: { companyId_externalId: { companyId, externalId: job.externalId } },
      select: { id: true },
    });

    const common = {
      title: job.title,
      description: job.description ?? '',
      url: job.url,
      location: job.location ?? null,
      country: job.country ?? null,
      workMode: job.workMode ?? null,
      salaryMin: job.salaryMin ?? null,
      salaryMax: job.salaryMax ?? null,
      currency: job.currency ?? null,
      postedAt: job.postedAt ? new Date(job.postedAt) : null,
      raw: (job.raw ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      status: JobStatus.ACTIVE,
      lastSeenAt: new Date(),
    };

    if (existing) {
      await this.prisma.job.update({ where: { id: existing.id }, data: common });
      return 'updated';
    }
    await this.prisma.job.create({ data: { companyId, externalId: job.externalId, ...common } });
    return 'created';
  }
}
