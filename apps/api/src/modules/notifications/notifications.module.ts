import { Module } from '@nestjs/common';
import { TelegramChannel } from './channels';
import { DailyBriefInternalController } from './daily-brief.controller';
import { DailyBriefService } from './daily-brief.service';
import { DashboardController } from './dashboard.controller';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Module({
  controllers: [NotificationsController, DailyBriefInternalController, DashboardController],
  providers: [NotificationsService, DailyBriefService, TelegramChannel],
  exports: [NotificationsService],
})
export class NotificationsModule {}
