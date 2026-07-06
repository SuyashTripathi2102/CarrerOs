import { Injectable, NotFoundException } from '@nestjs/common';
import { ListJobsDto } from './dto/list-jobs.dto';
import { JobsRepository } from './jobs.repository';

@Injectable()
export class JobsService {
  constructor(private readonly jobs: JobsRepository) {}

  async list(filters: ListJobsDto) {
    const [items, total] = await this.jobs.list(filters);
    return { items, total, page: filters.page, limit: filters.limit };
  }

  async get(id: string) {
    const job = await this.jobs.findById(id);
    if (!job) throw new NotFoundException('Job not found');
    return job;
  }
}
