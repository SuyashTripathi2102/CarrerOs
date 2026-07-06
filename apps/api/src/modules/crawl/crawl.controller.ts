import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { REFRESH_ALL_QUEUE } from './crawl.constants';
import { PrismaService } from '../../prisma/prisma.service';

@Controller('crawl')
export class CrawlController {
  constructor(
    @InjectQueue(REFRESH_ALL_QUEUE) private readonly refreshQueue: Queue,
    private readonly prisma: PrismaService,
  ) {}

  /** Manual "refresh everything now" — the 24h schedule lives in the workers. */
  @Post('trigger')
  @HttpCode(HttpStatus.ACCEPTED)
  async trigger() {
    const job = await this.refreshQueue.add('manual', { triggeredAt: new Date().toISOString() });
    return { enqueued: true, jobId: job.id };
  }

  /** Recent crawl activity — feeds the future admin panel. */
  @Get('runs')
  runs() {
    return this.prisma.crawlRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: 50,
      include: { company: { select: { id: true, name: true } } },
    });
  }
}
