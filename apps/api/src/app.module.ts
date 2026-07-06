import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
    }),
    PrismaModule,
    // Domain modules (auth, resumes, jobs, companies, matching, ...) are added
    // here starting Phase 3 — see /ARCHITECTURE.md for the module map.
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
