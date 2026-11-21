import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CompaniesService } from './companies.service';
import { CreateCompanyDto } from './dto/create-company.dto';
import { Role } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';

@Controller('companies')
export class CompaniesController {
  constructor(private readonly companiesService: CompaniesService) {}

  // Adding to the shared catalogue is an operator action (W8); reading it stays open to every account.
  @Roles(Role.ADMIN)
  @Post()
  create(@Body() dto: CreateCompanyDto) {
    return this.companiesService.create(dto);
  }

  @Get()
  list(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('search') search?: string,
  ) {
    return this.companiesService.list(page, Math.min(limit, 100), search);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.companiesService.get(id);
  }
}
