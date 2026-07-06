import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ListJobsDto } from './dto/list-jobs.dto';

@Injectable()
export class JobsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(filters: ListJobsDto) {
    // Search goes through the GIN-indexed tsvector column (websearch syntax:
    // quoted phrases, OR, -exclusions), then IDs constrain the Prisma query —
    // ILIKE-over-description died in the Phase A review at ~100k jobs.
    let searchIds: string[] | undefined;
    if (filters.search) {
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM jobs
        WHERE search @@ websearch_to_tsquery('english', ${filters.search})
        ORDER BY ts_rank(search, websearch_to_tsquery('english', ${filters.search})) DESC
        LIMIT 2000
      `;
      searchIds = rows.map((r) => r.id);
      if (searchIds.length === 0) return [[], 0] as const;
    }

    const where: Prisma.JobWhereInput = {
      status: filters.status,
      companyId: filters.companyId,
      country: filters.country
        ? { equals: filters.country, mode: 'insensitive' }
        : undefined,
      workMode: filters.workMode,
      ...(searchIds ? { id: { in: searchIds } } : {}),
    };

    return this.prisma.$transaction([
      this.prisma.job.findMany({
        where,
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
        orderBy: [{ postedAt: { sort: 'desc', nulls: 'last' } }, { firstSeenAt: 'desc' }],
        select: {
          id: true,
          title: true,
          url: true,
          location: true,
          country: true,
          workMode: true,
          salaryMin: true,
          salaryMax: true,
          currency: true,
          seniority: true,
          status: true,
          postedAt: true,
          firstSeenAt: true,
          company: { select: { id: true, name: true, website: true, logoUrl: true } },
        },
      }),
      this.prisma.job.count({ where }),
    ]);
  }

  findById(id: string) {
    return this.prisma.job.findUnique({
      where: { id },
      include: { company: true, skills: { include: { skill: true } } },
    });
  }
}
