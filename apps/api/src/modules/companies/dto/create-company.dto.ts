import { AtsProvider } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

export class CreateCompanyDto {
  @IsString()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsUrl()
  website?: string;

  /** Any career-page/board/posting URL — ATS is auto-detected from it. */
  @IsOptional()
  @IsUrl()
  careerPageUrl?: string;

  @IsOptional()
  @IsEnum(AtsProvider)
  atsProvider?: AtsProvider;

  @IsOptional()
  @IsString()
  atsIdentifier?: string;

  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  industry?: string;
}
