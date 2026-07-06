import { Injectable } from '@nestjs/common';
import { AtsProvider, Company, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const CRAWLABLE: AtsProvider[] = [
  AtsProvider.GREENHOUSE,
  AtsProvider.LEVER,
  AtsProvider.ASHBY,
];

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

  /** Companies the 24h refresh should crawl: supported ATS + identifier present. */
  findCrawlable(): Promise<Company[]> {
    return this.prisma.company.findMany({
      where: { atsProvider: { in: CRAWLABLE }, atsIdentifier: { not: null } },
    });
  }

  update(id: string, data: Prisma.CompanyUpdateInput): Promise<Company> {
    return this.prisma.company.update({ where: { id }, data });
  }
}
