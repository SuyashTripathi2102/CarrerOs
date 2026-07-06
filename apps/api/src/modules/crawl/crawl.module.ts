import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CrawlController } from './crawl.controller';
import { REFRESH_ALL_QUEUE } from './crawl.constants';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: { url: config.get<string>('REDIS_URL', 'redis://localhost:6379') },
      }),
    }),
    BullModule.registerQueue({ name: REFRESH_ALL_QUEUE }),
  ],
  controllers: [CrawlController],
})
export class CrawlModule {}
