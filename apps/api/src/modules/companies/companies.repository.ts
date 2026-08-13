import { Injectable } from '@nestjs/common';
import { AtsProvider, Company, Prisma } from '@prisma/client';
import { CRAWLABLE_PROVIDERS } from '@careeros/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizeCompanyName } from './company-name';

// Single source of truth in shared, mirroring the workers' adapter map.
// The 2026-07-08 incident was exactly this list drifting: WORKABLE had a
// shipped adapter but was missing here, so 36 monitored india-seed
// companies were never crawled.
const CRAWLABLE = CRAWLABLE_PROVIDERS as AtsProvider[];

@Injectable()
export class CompaniesRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.CompanyCreateInput): Promise<Company> {
    return this.prisma.company.create({ data });
  }

  findById(id: string): Promise<Company | null> {
    return this.prisma.company.findUnique({ where: { id } });
  }

  findByAts(provider: AtsProvider, identifier: string): Promise<Company | null> {
    return this.prisma.company.findUnique({
      where: { atsProvider_atsIdentifier: { atsProvider: provider, atsIdentifier: identifier } },
    });
  }

  findByName(name: string): Promise<Company | null> {
    return this.prisma.company.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
    });
  }

  /**
   * Match on company identity rather than exact string, so "Zensar" and
   * "Zensar Technologies" resolve to one row instead of two.
   *
   * The normalized base is always a PREFIX of any suffixed variant, so a
   * prefix query is a sound and index-friendly candidate filter; normalized
   * equality is then checked in JS. Doing it this way avoids a stored-column
   * migration and keeps the rule in one testable function.
   */
  async findByNormalizedName(name: string): Promise<Company | null> {
    const base = normalizeCompanyName(name);
    if (!base) return null;
    const candidates = await this.prisma.company.findMany({
      where: { name: { startsWith: base, mode: 'insensitive' } },
      // Oldest first: merge into the established record, not the newcomer.
      orderBy: { createdAt: 'asc' },
      take: 25,
    });
    return candidates.find((c) => normalizeCompanyName(c.name) === base) ?? null;
  }

  list(skip: number, take: number, search?: string) {
    const where: Prisma.CompanyWhereInput = search
      ? { name: { contains: search, mode: 'insensitive' } }
      : {};
    return this.prisma.$transaction([
      this.prisma.company.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { jobs: { where: { status: 'ACTIVE' } } } } },
      }),
      this.prisma.company.count({ where }),
    ]);
  }

  /**
   * Companies due for a crawl right now: supported ATS + identifier present +
   * nextCrawlAt has passed. The scheduler ticks every 15 min; each company's
   * cadence comes from its crawlTier (bumped after every sync).
   */
  findCrawlable(): Promise<Company[]> {
    return this.prisma.company.findMany({
      where: {
        atsProvider: { in: CRAWLABLE },
        atsIdentifier: { not: null },
        nextCrawlAt: { lte: new Date() },
      },
    });
  }

  update(id: string, data: Prisma.CompanyUpdateInput): Promise<Company> {
    return this.prisma.company.update({ where: { id }, data });
  }
}
