import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * The Dream Company Watchlist — company-first monitoring. The user picks the
 * companies they care about; watching bumps each to HOT crawl tier (checked
 * frequently) and surfaces its open roles ranked by resume fit. If a watched
 * name isn't in the index yet, we create it so it enters the discovery pipeline.
 */
@Injectable()
export class WatchlistService {
  constructor(private readonly prisma: PrismaService) {}

  /** Add a company to the watchlist by name (found-or-created), monitor it HOT. */
  async add(userId: string, rawName: string) {
    const name = rawName.trim();
    if (name.length < 2) throw new BadRequestException('Company name too short');

    let company = await this.prisma.company.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    });
    if (!company) {
      company = await this.prisma.company.create({
        data: {
          name,
          discoverySource: 'watchlist',
          discoveryStage: 'DISCOVERED',
          crawlTier: 'HOT',
        },
        select: { id: true },
      });
    } else {
      // Watching a known company promotes it to frequent monitoring, now.
      await this.prisma.company.update({
        where: { id: company.id },
        data: { crawlTier: 'HOT', nextCrawlAt: new Date() },
      });
    }

    await this.prisma.companyWatch.upsert({
      where: { userId_companyId: { userId, companyId: company.id } },
      create: { userId, companyId: company.id },
      update: {},
    });
    return this.list(userId);
  }

  async remove(userId: string, watchId: string) {
    const watch = await this.prisma.companyWatch.findFirst({ where: { id: watchId, userId } });
    if (!watch) throw new NotFoundException('Not on your watchlist');
    await this.prisma.companyWatch.delete({ where: { id: watch.id } });
    return this.list(userId);
  }

  /** Type-ahead for the "add company" box — known companies by name. */
  async search(q: string) {
    const term = q.trim();
    if (term.length < 2) return [];
    const rows = await this.prisma.company.findMany({
      where: { name: { contains: term, mode: 'insensitive' } },
      orderBy: [{ crawlTier: 'asc' }, { name: 'asc' }],
      take: 10,
      select: { id: true, name: true, atsProvider: true, discoveryStage: true },
    });
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      monitored: c.discoveryStage === 'MONITORED',
      ats: c.atsProvider,
    }));
  }

  /** Watched companies + their open roles ranked by resume fit. */
  async list(userId: string) {
    const watches = await this.prisma.companyWatch.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        createdAt: true,
        company: {
          select: { id: true, name: true, atsProvider: true, discoveryStage: true, careerPageUrl: true, website: true },
        },
      },
    });
    if (watches.length === 0) return { items: [] };

    const companyIds = watches.map((w) => w.company.id);
    const versionId = await this.activeResumeVersionId(userId);

    // Rank every watched company's active jobs by resume-embedding fit in one
    // query, then group. No LLM — instant, like Browse.
    const jobs = versionId
      ? await this.prisma.$queryRaw<
          Array<{
            id: string;
            companyId: string;
            title: string;
            location: string | null;
            url: string;
            firstSeenAt: Date;
            fit: number;
            applied: boolean;
          }>
        >`
          SELECT j.id, j."companyId", j.title, j.location, j.url, j."firstSeenAt",
                 (1 - (je.vector <=> re.vector))::float8 AS fit,
                 (a.id IS NOT NULL) AS applied
          FROM job_embeddings je
          JOIN jobs j ON j.id = je."jobId" AND j.status = 'ACTIVE'
          CROSS JOIN (SELECT vector FROM resume_embeddings WHERE "resumeVersionId" = ${versionId}) re
          LEFT JOIN applications a ON a."jobId" = j.id AND a."userId" = ${userId}
          WHERE j."companyId" = ANY(${companyIds})
          ORDER BY je.vector <=> re.vector
        `
      : [];

    const byCompany = new Map<string, typeof jobs>();
    for (const j of jobs) {
      const arr = byCompany.get(j.companyId) ?? [];
      arr.push(j);
      byCompany.set(j.companyId, arr);
    }

    const now = Date.now();
    return {
      items: watches.map((w) => {
        const roles = (byCompany.get(w.company.id) ?? []).slice(0, 5).map((j) => ({
          jobId: j.id,
          title: j.title,
          location: j.location,
          fit: Math.round(j.fit * 100),
          ageDays: Math.floor((now - new Date(j.firstSeenAt).getTime()) / 86_400_000),
          applied: j.applied,
        }));
        const total = byCompany.get(w.company.id)?.length ?? 0;
        const newThisWeek = (byCompany.get(w.company.id) ?? []).filter(
          (j) => now - new Date(j.firstSeenAt).getTime() < 7 * 86_400_000,
        ).length;
        return {
          watchId: w.id,
          companyId: w.company.id,
          name: w.company.name,
          monitored: w.company.discoveryStage === 'MONITORED',
          ats: w.company.atsProvider,
          careerPageUrl: w.company.careerPageUrl ?? w.company.website ?? null,
          openRoles: total,
          newThisWeek,
          roles,
        };
      }),
    };
  }

  private async activeResumeVersionId(userId: string): Promise<string | null> {
    const v = await this.prisma.resumeVersion.findFirst({
      where: { resume: { userId, isPrimary: true }, activatedAt: { not: null } },
      orderBy: { versionNumber: 'desc' },
      select: { id: true },
    });
    return v?.id ?? null;
  }
}
