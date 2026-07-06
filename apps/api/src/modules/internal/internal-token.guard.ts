import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';

/**
 * Guards service-to-service endpoints (workers/scraper → API).
 * Not user auth — a shared secret in the x-internal-token header.
 */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.getOrThrow<string>('INTERNAL_API_TOKEN');
    const provided = context.switchToHttp().getRequest().headers['x-internal-token'];

    if (typeof provided !== 'string' || provided.length !== expected.length) {
      throw new UnauthorizedException('Invalid internal token');
    }
    if (!timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
      throw new UnauthorizedException('Invalid internal token');
    }
    return true;
  }
}
