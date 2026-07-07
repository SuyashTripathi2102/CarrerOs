import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AtsProvider, Company } from '@prisma/client';
import { CompaniesRepository } from './companies.repository';
import { CreateCompanyDto } from './dto/create-company.dto';
import { detectAts } from './ats-detector';

@Injectable()
export class CompaniesService {
  constructor(private readonly companies: CompaniesRepository) {}

  async create(dto: CreateCompanyDto): Promise<Company> {
    let provider = dto.atsProvider ?? AtsProvider.UNKNOWN;
    let identifier = dto.atsIdentifier ?? null;

    // Auto-detect ATS from the career URL unless explicitly provided.
    if (provider === AtsProvider.UNKNOWN && dto.careerPageUrl) {
      const detected = detectAts(dto.careerPageUrl);
      provider = detected.provider;
      identifier = detected.identifier;
    }

    if (identifier) {
      const existing = await this.companies.findByAts(provider, identifier);
      if (existing) {
        throw new ConflictException(
          `Company "${existing.name}" already crawls this ${provider} board`,
        );
      }
    }

    return this.companies.create({
      name: dto.name,
      website: dto.website,
      careerPageUrl: dto.careerPageUrl,
      atsProvider: provider,
      atsIdentifier: identifier,
      country: dto.country,
      city: dto.city,
      industry: dto.industry,
    });
  }

  /**
   * Flywheel entry point (used by internal board ingest): find or create a
   * company from the little a board job tells us about it.
   */
  async findOrCreateFromBoard(input: {
    name: string;
    website?: string | null;
    atsHintUrl?: string | null;
  }): Promise<Company> {
    const detected = input.atsHintUrl ? detectAts(input.atsHintUrl) : null;

    if (detected?.identifier) {
      const byAts = await this.companies.findByAts(detected.provider, detected.identifier);
      if (byAts) return byAts;
    }

    const byName = await this.companies.findByName(input.name);
    if (byName) {
      // Upgrade: we may have just learned this company's ATS — enables direct crawls.
      if (byName.atsProvider === AtsProvider.UNKNOWN && detected?.identifier) {
        return this.companies.update(byName.id, {
          atsProvider: detected.provider,
          atsIdentifier: detected.identifier,
          careerPageUrl: byName.careerPageUrl ?? input.atsHintUrl,
        });
      }
      return byName;
    }

    return this.companies.create({
      name: input.name,
      website: input.website ?? undefined,
      careerPageUrl: input.atsHintUrl ?? undefined,
      atsProvider: detected?.identifier ? detected.provider : AtsProvider.UNKNOWN,
      atsIdentifier: detected?.identifier ?? undefined,
      // Without this, board-discovered companies group as "manual" in funnel
      // stats — the flywheel's biggest channel was invisible in its own metrics.
      discoverySource: 'board',
    });
  }

  async get(id: string): Promise<Company> {
    const company = await this.companies.findById(id);
    if (!company) throw new NotFoundException('Company not found');
    return company;
  }

  async list(page: number, limit: number, search?: string) {
    const [items, total] = await this.companies.list((page - 1) * limit, limit, search);
    return { items, total, page, limit };
  }

  findCrawlable(): Promise<Company[]> {
    return this.companies.findCrawlable();
  }
}
