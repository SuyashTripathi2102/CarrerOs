import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { ApplicationStatus, ApplicationsService } from './applications.service';

class CreateApplicationDto {
  @IsString()
  jobId!: string;

  @IsOptional()
  @IsEnum(ApplicationStatus)
  status?: ApplicationStatus;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

class TransitionDto {
  @IsEnum(ApplicationStatus)
  status!: ApplicationStatus;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

@Controller('applications')
export class ApplicationsController {
  constructor(private readonly applications: ApplicationsService) {}

  /** "I applied" (default) or "save for later" (status: SAVED). Idempotent per job. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateApplicationDto) {
    return this.applications.createFromJob(user.id, dto.jobId, {
      status: dto.status,
      note: dto.note,
    });
  }

  @Patch(':id')
  transition(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: TransitionDto,
  ) {
    return this.applications.transition(user.id, id, dto.status, dto.note);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query('status') status?: ApplicationStatus) {
    return this.applications.list(user.id, status);
  }

  @Get('stats')
  stats(@CurrentUser() user: AuthenticatedUser) {
    return this.applications.stats(user.id);
  }

  /** Per-application next-actions + likely causes + honest portfolio insights. */
  @Get('intelligence')
  intelligence(@CurrentUser() user: AuthenticatedUser) {
    return this.applications.intelligence(user.id);
  }
}
