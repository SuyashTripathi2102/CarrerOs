import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ListJobsDto } from './dto/list-jobs.dto';

@Injectable()
export class JobsRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(filters: ListJobsDto) {
    const where: Prisma.JobWhereInput = {
      status: filters.status,
      companyId: filters.companyId,
      country: filters.country
        ? { equals: filters.country, mode: 'insensitive' }
        : undefined,
      workMode: filters.workMode,
      ...(filters.search
        ? {
            OR: [
              { title: { contains: filters.search, mode: 'insensitive' } },
              { description: { contains: filters.search, mode: 'insensitive' } },
            ],
          }
        : {}),
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
