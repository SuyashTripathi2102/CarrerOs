import { Controller, Get, Param, Query } from '@nestjs/common';
import { ListJobsDto } from './dto/list-jobs.dto';
import { JobsService } from './jobs.service';

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @Get()
  list(@Query() filters: ListJobsDto) {
    return this.jobsService.list(filters);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.jobsService.get(id);
  }
}
