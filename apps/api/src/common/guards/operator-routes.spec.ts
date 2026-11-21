import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';
import type { Server } from 'node:http';
import request from 'supertest';
import { AdminController } from '../../modules/admin/admin.controller';
import { AiUsageController } from '../../modules/ai/ai-usage.controller';
import { AiUsageService } from '../../modules/ai/ai-usage.service';
import { CompaniesController } from '../../modules/companies/companies.controller';
import { CompaniesService } from '../../modules/companies/companies.service';
import { CrawlController } from '../../modules/crawl/crawl.controller';
import { DiscoveryController } from '../../modules/discovery/discovery.controller';
import { DiscoveryService } from '../../modules/discovery/discovery.service';
import { IntelligenceController } from '../../modules/intelligence/intelligence.controller';
import { IntelligenceService } from '../../modules/intelligence/intelligence.service';
import { SourceTrustController } from '../../modules/source-trust/source-trust.controller';
import { SourceTrustService } from '../../modules/source-trust/source-trust.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RolesGuard } from './roles.guard';

/**
 * The operator routes over HTTP, with the real controllers and the real RolesGuard. Only the sign-in
 * is a stand-in: the `x-test-user: <id>:<role in the token>` header plays the part of the JWT. What
 * the database says each account is NOW comes from DB_ROLES, read by RolesGuard as in production.
 */
const DB_ROLES: Record<string, Role> = {
  admin: Role.ADMIN,
  user: Role.USER,
  demoted: Role.USER,
};

/** The 16 routes W8 makes ADMIN-only (method, path). */
const OPERATOR: [string, string][] = [
  ['post', '/crawl/trigger'],
  ['post', '/crawl/seed'],
  ['post', '/crawl/discover'],
  ['get', '/crawl/runs'],
  ['get', '/admin/health'],
  ['get', '/ai/usage'],
  ['post', '/companies'],
  ['post', '/intelligence/derive'],
  ['get', '/discovery/stats'],
  ['get', '/discovery/coverage'],
  ['get', '/discovery/extraction'],
  ['get', '/discovery/replay'],
  ['get', '/discovery/pipeline'],
  ['get', '/discovery/crawl-schedule'],
  ['get', '/discovery/render'],
  ['get', '/source-trust'],
];
/** Catalogue reads on the same controllers, which every signed-in account keeps. */
const READS: string[] = [
  '/companies',
  '/companies/c1',
  '/companies/c1/intelligence',
  '/intelligence/top-growing',
];

@Injectable()
class HeaderSignIn implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: unknown }>();
    const header = req.headers['x-test-user'];
    if (!header) throw new UnauthorizedException();
    const [id, role] = header.split(':');
    req.user = { id, email: `${id}@example.test`, role };
    return true;
  }
}

describe('operator routes over HTTP: ADMIN only, by the role in the database', () => {
  let app: INestApplication;
  const ok = () => jest.fn(() => Promise.resolve({}));
  const queue = { add: jest.fn(() => Promise.resolve({ id: 'job-1' })) };
  // /admin/health is stopped at its first query, before it opens any Redis connection.
  const healthStopped = jest.fn(() =>
    Promise.reject(new Error('test: stop before the queues')),
  );
  const prisma = {
    user: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(
          DB_ROLES[where.id] ? { role: DB_ROLES[where.id] } : null,
        ),
      ),
    },
    crawlRun: {
      findMany: jest.fn(() => Promise.resolve([])),
      groupBy: ok(),
      findFirst: ok(),
    },
    company: { groupBy: healthStopped },
    job: { count: ok() },
    jobMatch: { count: ok() },
    notification: { count: ok() },
    $queryRaw: ok(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [
        CrawlController,
        AdminController,
        AiUsageController,
        CompaniesController,
        IntelligenceController,
        DiscoveryController,
        SourceTrustController,
      ],
      providers: [
        { provide: APP_GUARD, useClass: HeaderSignIn },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: PrismaService, useValue: prisma },
        // A port nothing listens on: no test can reach a real Redis.
        {
          provide: ConfigService,
          useValue: {
            get: (k: string, d?: unknown) =>
              k === 'REDIS_URL' ? 'redis://127.0.0.1:9' : d,
          },
        },
        ...[
          'refresh-all',
          'seed-import',
          'discovery-fanout',
          'derive-intel',
        ].map((name) => ({ provide: getQueueToken(name), useValue: queue })),
        { provide: AiUsageService, useValue: { stats: ok() } },
        {
          provide: CompaniesService,
          useValue: { create: ok(), list: ok(), get: ok() },
        },
        {
          provide: IntelligenceService,
          useValue: {
            get: ok(),
            topGrowing: jest.fn(() => Promise.resolve([])),
          },
        },
        {
          provide: DiscoveryService,
          useValue: {
            funnelStats: ok(),
            cityCoverage: ok(),
            extractionHealth: ok(),
            replayStatus: ok(),
            pipelineMetrics: ok(),
            crawlScheduleHealth: ok(),
            renderHealth: ok(),
          },
        },
        {
          provide: SourceTrustService,
          useValue: { list: jest.fn(() => Promise.resolve([])) },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });
  afterAll(() => app.close());
  const server = () => app.getHttpServer() as Server;

  const call = (method: string, path: string, as: string) =>
    (
      request(server()) as unknown as Record<
        string,
        (p: string) => request.Test
      >
    )
      [method](path)
      .set('x-test-user', as);

  it('covers 16 operator routes', () => {
    expect(OPERATOR).toHaveLength(16);
  });

  it.each(OPERATOR)(
    '%s %s refuses a USER with 403, before the handler runs',
    async (method, path) => {
      queue.add.mockClear();
      const res = await call(method, path, 'user:USER');

      expect(res.status).toBe(403);
      expect(queue.add).not.toHaveBeenCalled();
    },
  );

  it.each(OPERATOR)(
    '%s %s refuses an account demoted since its token was issued',
    async (method, path) => {
      const res = await call(method, path, 'demoted:ADMIN');

      expect(res.status).toBe(403);
    },
  );

  it.each(OPERATOR)(
    '%s %s lets an ADMIN through to the handler',
    async (method, path) => {
      const res = await call(method, path, 'admin:ADMIN');

      if (path === '/admin/health') {
        expect(res.status).toBe(500); // the handler ran, and the test stopped it at its first query
        expect(healthStopped).toHaveBeenCalled();
      } else {
        expect(res.status).toBeLessThan(300);
      }
    },
  );

  it.each(READS)('GET %s stays open to a USER', async (path) => {
    const res = await call('get', path, 'user:USER');

    expect(res.status).toBe(200);
  });

  it('refuses a request with no sign-in at all (401)', async () => {
    const res = await request(server()).post('/crawl/trigger');

    expect(res.status).toBe(401);
  });
});
