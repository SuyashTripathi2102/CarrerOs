import { Module } from '@nestjs/common';
import { ApplicationsModule } from '../applications/applications.module';
import { TelegramChannel } from './channels';
import { DailyBriefInternalController } from './daily-brief.controller';
import { DailyBriefService } from './daily-brief.service';
import { DashboardController } from './dashboard.controller';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { TelegramAppliedService } from './telegram-applied.service';
import { TelegramPollerService } from './telegram-poller.service';
import { TelegramWebhookController } from './telegram-webhook.controller';

@Module({
  imports: [ApplicationsModule],
  controllers: [
    NotificationsController,
    DailyBriefInternalController,
    DashboardController,
    TelegramWebhookController,
  ],
  providers: [
    NotificationsService,
    DailyBriefService,
    TelegramChannel,
    TelegramAppliedService,
    TelegramPollerService,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
