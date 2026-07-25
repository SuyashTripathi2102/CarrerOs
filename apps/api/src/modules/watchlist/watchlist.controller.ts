import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { WatchlistService } from './watchlist.service';

/** Dream Company Watchlist — company-first monitoring. JWT-guarded (global). */
@Controller('watchlist')
export class WatchlistController {
  constructor(private readonly watchlist: WatchlistService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.watchlist.list(user.id);
  }

  @Get('search')
  search(@CurrentUser() _user: AuthenticatedUser, @Query('q') q = '') {
    return this.watchlist.search(q);
  }

  @Post()
  add(@CurrentUser() user: AuthenticatedUser, @Body() body: { company: string }) {
    return this.watchlist.add(user.id, body.company ?? '');
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.watchlist.remove(user.id, id);
  }
}
