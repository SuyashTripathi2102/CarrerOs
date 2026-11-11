import { Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import type { NormalizedJob } from '@careeros/shared';
import { IngestService, type SyncResult } from './ingest.service';
import { DailyBriefService } from '../notifications/daily-brief.service';

/**
 * The retirement drop guard (R-1) against a real Postgres: syncCompanyJobs and
 * the brief's query, end to end. Test ids R1-Txx match the guard's regression
 * list.
 *
 * Needs two THROWAWAY databases, never a live one:
 *   R1_INT_DATABASE_URL      the current schema plus crawl_runs.complete/reconciled
 *   R1_INT_PRE_DATABASE_URL  the current schema only
 * Every test truncates companies, jobs and crawl_runs, so each database must be
 * marked `ALTER DATABASE ... SET careeros.throwaway = 'r1'`, and the suite
 * refuses to run without that marker. Without the variables it is skipped.
 */

const V23_URL = process.env.R1_INT_DATABASE_URL;
const PRE_URL = process.env.R1_INT_PRE_DATABASE_URL;
const describeDb = V23_URL && PRE_URL ? describe : describe.skip;

const SOURCE = 'breezy';

interface RunRow {
  status: string;
  found: number;
  removed: number;
  complete: boolean | null;
  reconciled: boolean | null;
}

const job = (
  externalId: string,
  extra: Partial<NormalizedJob> = {},
): NormalizedJob => ({
  externalId,
  title: `Engineer ${externalId}`,
  description: '',
  url: `https://jobs.example.com/${encodeURIComponent(externalId)}`,
  ...extra,
});
const names = (n: number, prefix = 'j') =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const jobsOf = (list: string[]) => list.map((id) => job(id));

async function connect(url: string): Promise<PrismaClient> {
  const prisma = new PrismaClient({ datasourceUrl: url });
  const [{ marker }] = await prisma.$queryRaw<{ marker: string | null }[]>`
    SELECT current_setting('careeros.throwaway', true) AS marker
  `;
  if (marker !== 'r1') {
    await prisma.$disconnect();
    throw new Error(
      'refusing to run: this database is not marked as an R-1 throwaway',
    );
  }
  return prisma;
}

async function reset(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRaw`TRUNCATE crawl_runs, jobs, companies RESTART IDENTITY CASCADE`;
}

function stubs(guardSwitch: 'on' | 'off', opts: { failEmbed?: boolean } = {}) {
  const embeds = { calls: 0 };
  const queue = {
    add: async () => {
      embeds.calls++;
      if (opts.failEmbed) throw new Error('redis down');
    },
  };
  const config = {
    get: (key: string) =>
      key === 'RETIREMENT_DROP_GUARD' ? guardSwitch : undefined,
  };
  return { queue, config, embeds };
}

async function ingest(
  prisma: PrismaClient,
  guardSwitch: 'on' | 'off',
  opts: { failEmbed?: boolean } = {},
) {
  const { queue, config, embeds } = stubs(guardSwitch, opts);
  const service = new IngestService(
    prisma as never,
    {} as never,
    queue as never,
    config as never,
  );
  await service.onModuleInit();
  return Object.assign(service, { embeds });
}

async function company(
  prisma: PrismaClient,
  name = `Co ${randomUUID().slice(0, 8)}`,
): Promise<string> {
  return (await prisma.company.create({ data: { name } })).id;
}

async function countActive(
  prisma: PrismaClient,
  companyId: string,
  source = SOURCE,
): Promise<number> {
  return prisma.job.count({ where: { companyId, source, status: 'ACTIVE' } });
}

async function runsOf(
  prisma: PrismaClient,
  companyId: string,
): Promise<RunRow[]> {
  return prisma.$queryRaw<RunRow[]>`
    SELECT status::text AS status, "jobsFound" AS found, "jobsRemoved" AS removed, complete, reconciled
    FROM crawl_runs WHERE "companyId" = ${companyId} ORDER BY "startedAt"
  `;
}

/** Jobs that exist from before, with no crawl run of their own. */
async function seedJobs(
  prisma: PrismaClient,
  companyId: string,
  list: string[],
  source = SOURCE,
) {
  await prisma.job.createMany({
    data: list.map((externalId) => ({
      companyId,
      externalId,
      title: `Engineer ${externalId}`,
      description: '',
      url: `https://jobs.example.com/${externalId}`,
      source,
      status: 'ACTIVE' as const,
    })),
  });
}

/** A crawl run written directly, e.g. one from before the run flags existed. */
async function seedRun(
  prisma: PrismaClient,
  companyId: string,
  r: {
    status: string;
    found: number;
    removed?: number;
    complete: boolean | null;
    reconciled: boolean | null;
    hoursAgo: number;
  },
) {
  const at = new Date(Date.now() - r.hoursAgo * 3_600_000);
  await prisma.$executeRaw`
    INSERT INTO crawl_runs (id, "companyId", source, status, "startedAt", "finishedAt", "jobsFound", "jobsNew", "jobsRemoved", complete, reconciled)
    VALUES (${randomUUID()}, ${companyId}, ${SOURCE}, ${r.status}::"CrawlStatus", ${at}, ${at}, ${r.found}, 0, ${r.removed ?? 0}, ${r.complete}, ${r.reconciled})
  `;
}

describeDb('retirement drop guard against Postgres', () => {
  let v23: PrismaClient;
  let pre: PrismaClient;
  let errorLog: jest.SpyInstance;
  let warnLog: jest.SpyInstance;

  beforeAll(async () => {
    v23 = await connect(V23_URL!);
    pre = await connect(PRE_URL!);
  });
  afterAll(async () => {
    await v23?.$disconnect();
    await pre?.$disconnect();
  });
  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnLog = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    await reset(v23);
    await reset(pre);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('A-01 schema, guard on', () => {
    it('R1-T01/T02/T09: a drop is deferred, retired when confirmed, and reversed when the jobs return', async () => {
      const svc = await ingest(v23, 'on');
      const c = await company(v23);
      const all = names(2452);

      await svc.syncCompanyJobs(c, SOURCE, jobsOf(all)); // the reference (first crawl: NO_REFERENCE)
      const drop = await svc.syncCompanyJobs(c, SOURCE, jobsOf([all[0]]));
      expect(drop.removed).toBe(0); // T01
      expect(await countActive(v23, c)).toBe(2452);

      const confirm = await svc.syncCompanyJobs(c, SOURCE, jobsOf([all[0]]));
      expect(confirm.removed).toBe(2451); // T02
      expect(await countActive(v23, c)).toBe(1);

      await svc.syncCompanyJobs(c, SOURCE, jobsOf(all)); // T09
      expect(await countActive(v23, c)).toBe(2452);

      expect(await runsOf(v23, c)).toEqual([
        {
          status: 'SUCCEEDED',
          found: 2452,
          removed: 0,
          complete: true,
          reconciled: false,
        },
        {
          status: 'SUCCEEDED',
          found: 1,
          removed: 0,
          complete: true,
          reconciled: false,
        },
        {
          status: 'SUCCEEDED',
          found: 1,
          removed: 2451,
          complete: true,
          reconciled: true,
        },
        {
          status: 'SUCCEEDED',
          found: 2452,
          removed: 0,
          complete: true,
          reconciled: true,
        },
      ]);
    });

    it('R1-T03: a rebound after the deferral retires only the jobs genuinely missing', async () => {
      const svc = await ingest(v23, 'on');
      const c = await company(v23);
      const all = names(2452);
      await svc.syncCompanyJobs(c, SOURCE, jobsOf(all));
      await svc.syncCompanyJobs(c, SOURCE, jobsOf([all[0]]));

      const rebound = await svc.syncCompanyJobs(
        c,
        SOURCE,
        jobsOf(all.slice(0, 2450)),
      );

      expect(rebound.removed).toBe(2);
      const removed = await v23.job.findMany({
        where: { companyId: c, status: 'REMOVED' },
        select: { externalId: true },
      });
      expect(removed.map((j) => j.externalId).sort()).toEqual(
        [all[2450], all[2451]].sort(),
      );
    });

    it('R1-T04: against a reference of 100, 50 retires and 49 is deferred', async () => {
      const svc = await ingest(v23, 'on');
      for (const [seen, expectedRemoved, expectedActive] of [
        [50, 50, 50],
        [49, 0, 100],
      ] as const) {
        const c = await company(v23);
        const all = names(100);
        await svc.syncCompanyJobs(c, SOURCE, jobsOf(all));
        const r = await svc.syncCompanyJobs(
          c,
          SOURCE,
          jobsOf(all.slice(0, seen)),
        );
        expect(r.removed).toBe(expectedRemoved);
        expect(await countActive(v23, c)).toBe(expectedActive);
      }
    });

    it('R1-T05: with only empty crawls before, the first non-empty crawl waits once', async () => {
      const svc = await ingest(v23, 'on');
      const c = await company(v23);
      await seedJobs(v23, c, names(30));
      await svc.syncCompanyJobs(c, SOURCE, []);
      await svc.syncCompanyJobs(c, SOURCE, []);

      const first = await svc.syncCompanyJobs(c, SOURCE, jobsOf(['j0']));
      expect(first.removed).toBe(0);
      expect(warnLog).toHaveBeenLastCalledWith(
        expect.stringContaining('(NO_REFERENCE)'),
      );

      const next = await svc.syncCompanyJobs(c, SOURCE, jobsOf(['j0']));
      expect(next.removed).toBe(29);
    });

    it('R1-T06/T08: a partial walk and an empty result retire nothing, whatever the counts', async () => {
      const svc = await ingest(v23, 'on');
      const c = await company(v23);
      const all = names(100);
      await svc.syncCompanyJobs(c, SOURCE, jobsOf(all));
      await svc.syncCompanyJobs(c, SOURCE, jobsOf(all)); // a reference exists

      expect(
        (await svc.syncCompanyJobs(c, SOURCE, jobsOf(all.slice(0, 60)), false))
          .removed,
      ).toBe(0);
      expect((await svc.syncCompanyJobs(c, SOURCE, [])).removed).toBe(0);
      expect(await countActive(v23, c)).toBe(100);
      expect((await runsOf(v23, c)).slice(2)).toEqual([
        {
          status: 'SUCCEEDED',
          found: 60,
          removed: 0,
          complete: false,
          reconciled: false,
        },
        {
          status: 'SUCCEEDED',
          found: 0,
          removed: 0,
          complete: true,
          reconciled: false,
        },
      ]);
    });

    it('R1-T07: an ingest failure is a FAILED run that retired nothing', async () => {
      const svc = await ingest(v23, 'on');
      const c = await company(v23);
      const all = names(10);
      await svc.syncCompanyJobs(c, SOURCE, jobsOf(all));
      await svc.syncCompanyJobs(c, SOURCE, jobsOf(all));

      const broken = [job('j0', { workMode: 'NOT_A_MODE' as never })];
      await expect(svc.syncCompanyJobs(c, SOURCE, broken)).rejects.toThrow();

      expect(await countActive(v23, c)).toBe(10);
      expect((await runsOf(v23, c)).at(-1)).toMatchObject({
        status: 'FAILED',
        removed: 0,
        complete: true,
        reconciled: false,
      });
    });

    it('R1-T10: a 40% shrink at every step retires at every step (the documented limit)', async () => {
      const svc = await ingest(v23, 'on');
      const c = await company(v23);
      const all = names(100);
      await svc.syncCompanyJobs(c, SOURCE, jobsOf(all));
      const removed: number[] = [];
      for (const n of [60, 36, 21, 12]) {
        removed.push(
          (await svc.syncCompanyJobs(c, SOURCE, jobsOf(all.slice(0, n))))
            .removed,
        );
      }
      expect(removed).toEqual([40, 24, 15, 9]);
    });

    it("R1-T11: never retires another source's jobs at the same company", async () => {
      const svc = await ingest(v23, 'on');
      const c = await company(v23);
      await seedJobs(v23, c, names(20, 'gh'), 'greenhouse');
      const all = names(100);
      await svc.syncCompanyJobs(c, SOURCE, jobsOf(all));
      await svc.syncCompanyJobs(c, SOURCE, jobsOf(all.slice(0, 50)));
      expect(await countActive(v23, c, 'greenhouse')).toBe(20);
      expect(await countActive(v23, c, SOURCE)).toBe(50);
    });

    it("R1-T12: a deferred crawl's other effects match the same crawl with the guard off", async () => {
      const guarded = await ingest(v23, 'on');
      const unguarded = await ingest(v23, 'off');
      const x = await company(v23, 'Deferred Co');
      const y = await company(v23, 'Retired Co');
      const all = names(100);
      const later = [...all.slice(0, 10), ...names(5, 'new')];
      for (const [svc, c] of [
        [guarded, x],
        [unguarded, y],
      ] as const) {
        await svc.syncCompanyJobs(c, SOURCE, jobsOf(all));
        await svc.syncCompanyJobs(c, SOURCE, jobsOf(all));
      }
      const before = new Date();

      const rx = await guarded.syncCompanyJobs(x, SOURCE, jobsOf(later));
      const ry = await unguarded.syncCompanyJobs(y, SOURCE, jobsOf(later));

      expect(rx.removed).toBe(0);
      expect(ry.removed).toBe(90);
      expect({ ...rx, crawlRunId: '', removed: 0 }).toEqual({
        ...ry,
        crawlRunId: '',
        removed: 0,
      });
      expect(guarded.embeds.calls).toBe(unguarded.embeds.calls);

      const seen = await v23.job.findMany({
        where: { externalId: { in: later }, companyId: { in: [x, y] } },
        select: { companyId: true, status: true, lastSeenAt: true },
      });
      expect(seen).toHaveLength(30);
      for (const s of seen) {
        expect(s.status).toBe('ACTIVE');
        expect(s.lastSeenAt.getTime()).toBeGreaterThanOrEqual(
          before.getTime() - 1000,
        );
      }

      const [cx, cy] = await Promise.all(
        [x, y].map((id) =>
          v23.company.findUniqueOrThrow({
            where: { id },
            select: {
              crawlTier: true,
              discoveryStage: true,
              confidence: true,
              confidenceSignals: true,
              nextCrawlAt: true,
            },
          }),
        ),
      );
      expect({ ...cx, nextCrawlAt: 0 }).toEqual({ ...cy, nextCrawlAt: 0 });
      expect(
        Math.abs(cx.nextCrawlAt.getTime() - cy.nextCrawlAt.getTime()),
      ).toBeLessThan(5_000);
    });

    it('R1-T16: a reference that listed every posting twice still counts 100, so 90 retires 10', async () => {
      const svc = await ingest(v23, 'on');
      const c = await company(v23);
      const all = names(100);
      await svc.syncCompanyJobs(c, SOURCE, jobsOf([...all, ...all]));
      await svc.syncCompanyJobs(c, SOURCE, jobsOf([...all, ...all]));

      const r = await svc.syncCompanyJobs(c, SOURCE, jobsOf(all.slice(0, 90)));

      expect(r.removed).toBe(10);
      expect((await runsOf(v23, c)).map((x) => x.found)).toEqual([
        100, 100, 90,
      ]);
    });

    it('R1-T17: 40 postings listed three times are 40, a SUDDEN_DROP against 100', async () => {
      const svc = await ingest(v23, 'on');
      const c = await company(v23);
      const all = names(100);
      await svc.syncCompanyJobs(c, SOURCE, jobsOf(all));
      const forty = all.slice(0, 40);

      const r = await svc.syncCompanyJobs(
        c,
        SOURCE,
        jobsOf([...forty, ...forty, ...forty]),
      );

      expect(r.removed).toBe(0);
      expect(warnLog).toHaveBeenLastCalledWith(
        expect.stringContaining('(SUDDEN_DROP)'),
      );
      expect((await runsOf(v23, c)).at(-1)).toMatchObject({
        found: 40,
        reconciled: false,
      });
    });

    it('R1-T19: rows from before the run flags are never references', async () => {
      const svc = await ingest(v23, 'on');
      const c = await company(v23);
      await seedJobs(v23, c, names(60));
      // A pre-deploy history: raw counts, complete NULL. 5,000 would make 50 a drop.
      await seedRun(v23, c, {
        status: 'SUCCEEDED',
        found: 5000,
        complete: null,
        reconciled: null,
        hoursAgo: 2,
      });

      const first = await svc.syncCompanyJobs(c, SOURCE, jobsOf(names(50)));
      expect(first.removed).toBe(0);
      expect(warnLog).toHaveBeenLastCalledWith(
        expect.stringContaining('(NO_REFERENCE)'),
      );

      const second = await svc.syncCompanyJobs(c, SOURCE, jobsOf(names(50)));
      expect(second.removed).toBe(10);
    });

    it('R1-T20: a partial walk is never the reference (1,100, partial 500, then 1,080)', async () => {
      const svc = await ingest(v23, 'on');
      const c = await company(v23);
      const all = names(1100);
      await svc.syncCompanyJobs(c, SOURCE, jobsOf(all));
      await svc.syncCompanyJobs(c, SOURCE, jobsOf(all)); // a valid reference of 1,100
      await svc.syncCompanyJobs(c, SOURCE, jobsOf(all.slice(0, 500)), false);

      const r = await svc.syncCompanyJobs(
        c,
        SOURCE,
        jobsOf(all.slice(0, 1080)),
      );
      expect(r.removed).toBe(20);
      expect((await runsOf(v23, c))[2]).toMatchObject({
        found: 500,
        removed: 0,
        complete: false,
        reconciled: false,
      });
    });

    it('R1-T20, sharper: 540 after the partial 500 is a drop, so the reference was 1,100', async () => {
      // Against 500, 540 would retire; only the 1,100 walk makes it a drop.
      const svc = await ingest(v23, 'on');
      const c = await company(v23);
      const all = names(1100);
      await svc.syncCompanyJobs(c, SOURCE, jobsOf(all));
      await svc.syncCompanyJobs(c, SOURCE, jobsOf(all));
      await svc.syncCompanyJobs(c, SOURCE, jobsOf(all.slice(0, 500)), false);

      const r = await svc.syncCompanyJobs(c, SOURCE, jobsOf(all.slice(0, 540)));
      expect(r.removed).toBe(0);
      expect(warnLog).toHaveBeenLastCalledWith(
        expect.stringContaining('the previous valid crawl 1100'),
      );
    });

    it('R1-T21: a failure after retirement ran is recorded FAILED with reconciled=true', async () => {
      const ok = await ingest(v23, 'on');
      const c = await company(v23);
      const all = names(100);
      await ok.syncCompanyJobs(c, SOURCE, jobsOf(all));
      await ok.syncCompanyJobs(c, SOURCE, jobsOf(all));

      const failing = await ingest(v23, 'on', { failEmbed: true });
      await expect(
        failing.syncCompanyJobs(
          c,
          SOURCE,
          jobsOf([...all.slice(0, 80), 'brand-new']),
        ),
      ).rejects.toThrow('redis down');

      expect(await countActive(v23, c)).toBe(81);
      expect((await runsOf(v23, c)).at(-1)).toEqual({
        status: 'FAILED',
        found: 81,
        removed: 20,
        complete: true,
        reconciled: true,
      });
    });

    it('R1-T21: when the database refuses the recording, the crawl stays SUCCEEDED and is never a reference', async () => {
      // Regression (review of 11 Nov). A trigger makes Postgres itself reject
      // the recording UPDATE: it fires only for statements that SET complete
      // or reconciled, so the crawl's own status update is untouched.
      const svc = await ingest(v23, 'on');
      const c = await company(v23);
      const all = names(300);
      await svc.syncCompanyJobs(c, SOURCE, jobsOf(all.slice(0, 100))); // a valid reference: 100

      await v23.$executeRawUnsafe(
        `CREATE FUNCTION r1_refuse_flags() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'r1 test: recording refused'; END $$`,
      );
      await v23.$executeRawUnsafe(
        `CREATE TRIGGER r1_refuse_flags BEFORE UPDATE OF complete, reconciled ON crawl_runs
         FOR EACH ROW EXECUTE FUNCTION r1_refuse_flags()`,
      );
      let result: SyncResult | undefined;
      try {
        result = await svc.syncCompanyJobs(c, SOURCE, jobsOf(all)); // 300 against 100: retires normally
      } finally {
        await v23.$executeRawUnsafe(
          'DROP TRIGGER r1_refuse_flags ON crawl_runs',
        );
        await v23.$executeRawUnsafe('DROP FUNCTION r1_refuse_flags()');
      }

      expect(result).toMatchObject({ found: 300, removed: 0 });
      expect((await runsOf(v23, c)).at(-1)).toEqual({
        status: 'SUCCEEDED',
        found: 300,
        removed: 0,
        complete: null,
        reconciled: null,
      });
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('r1 test: recording refused'),
      );

      // Not a reference: against 300, 120 would be a drop and retire nothing.
      // Against the valid 100 it is not, so it retires the 180 unseen.
      const next = await svc.syncCompanyJobs(
        c,
        SOURCE,
        jobsOf(all.slice(0, 120)),
      );
      expect(next.removed).toBe(180);
    });
  });

  describe('R1-D6: overlapping crawls', () => {
    // A previous crawl is a reference only if it FINISHED before this crawl
    // started. Each test builds the same company: a valid crawl P that saw 100
    // jobs, 200 more ACTIVE jobs from before, and an overlapping crawl A that
    // started after P but before this crawl B, and saw 1,000. This crawl B
    // sees 60. Against P that retires 240 (40 + 200); against A it would be a
    // SUDDEN_DROP and retire nothing.
    const SAW = 60;

    async function setUp(svc: IngestService) {
      const c = await company(v23, `Overlap ${randomUUID().slice(0, 6)}`);
      const p = names(100);
      await svc.syncCompanyJobs(c, SOURCE, jobsOf(p)); // P: the valid 100
      await seedJobs(v23, c, names(200, 'x'));
      return { c, p };
    }

    async function seedOverlapping(
      c: string,
      a: { status: 'RUNNING' | 'SUCCEEDED'; finishedAt: Date | null },
    ) {
      const id = randomUUID();
      const done = a.status === 'SUCCEEDED';
      await v23.$executeRaw`
        INSERT INTO crawl_runs (id, "companyId", source, status, "startedAt", "finishedAt",
                                "jobsFound", "jobsNew", "jobsRemoved", complete, reconciled)
        VALUES (${id}, ${c}, ${SOURCE}, ${a.status}::"CrawlStatus", ${new Date()}, ${a.finishedAt},
                ${done ? 1000 : 0}, 0, 0, ${done ? true : null}, ${done ? true : null})
      `;
      await new Promise((resolve) => setTimeout(resolve, 20)); // B starts strictly later
      return id;
    }

    function spyReference(svc: IngestService) {
      return jest.spyOn(
        svc as unknown as {
          previousValidCrawl: (
            companyId: string,
            source: string,
            before: Date,
          ) => Promise<{ found: number } | null>;
        },
        'previousValidCrawl',
      );
    }

    it('a crawl that finished after this one started is never its reference', async () => {
      const svc = await ingest(v23, 'on');
      const { c, p } = await setUp(svc);
      // A started before B, and finishes 10 minutes after B started.
      await seedOverlapping(c, {
        status: 'SUCCEEDED',
        finishedAt: new Date(Date.now() + 10 * 60_000),
      });
      const reference = spyReference(svc);

      const b = await svc.syncCompanyJobs(c, SOURCE, jobsOf(p.slice(0, SAW)));

      await expect(reference.mock.results[0].value).resolves.toEqual({
        found: 100,
      });
      expect(b.removed).toBe(240);
    });

    it('the guard and the brief select the same reference when crawls overlap', async () => {
      const svc = await ingest(v23, 'on');
      const { c, p } = await setUp(svc);
      // A is still running when B decides...
      const a = await seedOverlapping(c, {
        status: 'RUNNING',
        finishedAt: null,
      });
      const reference = spyReference(svc);
      const b = await svc.syncCompanyJobs(c, SOURCE, jobsOf(p.slice(0, SAW)));
      const decided = await (reference.mock.results[0]
        .value as Promise<unknown>);

      // ...and finishes, valid and larger, after B started.
      await v23.$executeRaw`
        UPDATE crawl_runs SET status = 'SUCCEEDED', "finishedAt" = ${new Date()},
          "jobsFound" = 1000, complete = TRUE, reconciled = TRUE
        WHERE id = ${a}
      `;

      // The decision used P.
      expect(decided).toEqual({ found: 100 });
      expect(b.removed).toBe(240);

      // The brief, read afterwards, shows P too, not the overlapping A.
      const telegram = {
        isConfigured: () => false,
        send: () => Promise.resolve(),
      };
      const config = {
        get: (key: string) =>
          key === 'RETIREMENT_DROP_GUARD' ? 'on' : undefined,
      };
      const brief = new DailyBriefService(
        v23 as never,
        telegram as never,
        config as never,
      );
      const { rows } = await brief.largeRetirements();
      const line = rows.find((r) => r.removed === 240);
      expect(line).toMatchObject({
        found: SAW,
        removed: 240,
        referenceFound: 100,
      });

      // And the guard's own query, re-run now that A has finished, still says P.
      const run = await v23.crawlRun.findUniqueOrThrow({
        where: { id: b.crawlRunId },
        select: { startedAt: true },
      });
      reference.mockRestore();
      const now = await (
        svc as unknown as {
          previousValidCrawl: (
            companyId: string,
            source: string,
            before: Date,
          ) => Promise<{ found: number } | null>;
        }
      ).previousValidCrawl(c, SOURCE, run.startedAt);
      expect(now).toEqual({ found: line?.referenceFound });
    });
  });

  describe('A-01 schema, guard off', () => {
    it('R1-T15: retires at once, exactly as before the guard, while still recording', async () => {
      const svc = await ingest(v23, 'off');
      const c = await company(v23);
      const all = names(2452);
      await svc.syncCompanyJobs(c, SOURCE, jobsOf(all));

      const r = await svc.syncCompanyJobs(c, SOURCE, jobsOf([all[0], all[0]]));

      expect(r.removed).toBe(2451);
      expect(await runsOf(v23, c)).toEqual([
        {
          status: 'SUCCEEDED',
          found: 2452,
          removed: 0,
          complete: true,
          reconciled: true,
        },
        {
          status: 'SUCCEEDED',
          found: 1,
          removed: 2451,
          complete: true,
          reconciled: true,
        },
      ]);
    });
  });

  describe("the brief's large-retirement query (R1-T18)", () => {
    function brief(prisma: PrismaClient) {
      const telegram = {
        isConfigured: () => false,
        send: async () => undefined,
      };
      const config = {
        get: (key: string) =>
          key === 'RETIREMENT_DROP_GUARD' ? 'on' : undefined,
      };
      return new DailyBriefService(
        prisma as never,
        telegram as never,
        config as never,
      );
    }

    it('lists confirmed large retirements, largest first, each with its previous valid crawl', async () => {
      const svc = await ingest(v23, 'on');
      const a = await company(v23, 'Acme');
      const all = names(2452);
      await svc.syncCompanyJobs(a, SOURCE, jobsOf(all));
      await svc.syncCompanyJobs(a, SOURCE, jobsOf([all[0]])); // deferred
      await svc.syncCompanyJobs(a, SOURCE, jobsOf([all[0]])); // confirmed: 2,451

      const b = await company(v23, 'Beta');
      const beta = names(120);
      await svc.syncCompanyJobs(b, SOURCE, jobsOf(beta));
      await svc.syncCompanyJobs(b, SOURCE, jobsOf(beta.slice(0, 40))); // deferred
      await svc.syncCompanyJobs(b, SOURCE, jobsOf(beta.slice(0, 40))); // confirmed: 80 retired, 40 kept

      // Not listed (R1-D5), each failing exactly one half of the filter:
      // churn retires 60 but keeps 60, so it did not retire MORE than it kept;
      const churn = await company(v23, 'Churn');
      await svc.syncCompanyJobs(churn, SOURCE, jobsOf(names(120)));
      await svc.syncCompanyJobs(churn, SOURCE, jobsOf(names(60)));
      // Gamma retires 49 and keeps 48: more than it kept, but below 50.
      const small = await company(v23, 'Gamma');
      const gamma = names(97);
      await svc.syncCompanyJobs(small, SOURCE, jobsOf(gamma));
      await svc.syncCompanyJobs(small, SOURCE, jobsOf(gamma.slice(0, 48))); // deferred
      await svc.syncCompanyJobs(small, SOURCE, jobsOf(gamma.slice(0, 48))); // confirmed: 49

      // Not listed: too old, not reconciled, from before the run flags, or churn.
      const other = await company(v23, 'Delta');
      await seedRun(v23, other, {
        status: 'SUCCEEDED',
        found: 600,
        removed: 500,
        complete: true,
        reconciled: true,
        hoursAgo: 1,
      });
      await seedRun(v23, other, {
        status: 'SUCCEEDED',
        found: 5,
        removed: 500,
        complete: true,
        reconciled: true,
        hoursAgo: 25,
      });
      await seedRun(v23, other, {
        status: 'SUCCEEDED',
        found: 5,
        removed: 500,
        complete: true,
        reconciled: false,
        hoursAgo: 1,
      });
      await seedRun(v23, other, {
        status: 'SUCCEEDED',
        found: 5,
        removed: 500,
        complete: null,
        reconciled: null,
        hoursAgo: 1,
      });

      await expect(brief(v23).largeRetirements()).resolves.toEqual({
        rows: [
          {
            company: 'Acme',
            source: SOURCE,
            found: 1,
            removed: 2451,
            referenceFound: 1,
          },
          {
            company: 'Beta',
            source: SOURCE,
            found: 40,
            removed: 80,
            referenceFound: 40,
          },
        ],
        more: 0,
      });
      // Both excluded crawls did retire, so the filter, not the guard, left them out.
      const retiredBy = async (name: string) =>
        (
          await v23.crawlRun.findMany({
            where: { company: { name } },
            select: { jobsRemoved: true },
          })
        )
          .map((r) => r.jobsRemoved)
          .filter((n) => n > 0);
      expect(await retiredBy('Churn')).toEqual([60]);
      expect(await retiredBy('Gamma')).toEqual([49]);
    });

    it('with 7 qualifying, returns 5 and counts 2 more; with none, returns none', async () => {
      await expect(brief(v23).largeRetirements()).resolves.toEqual({
        rows: [],
        more: 0,
      });
      for (let i = 0; i < 7; i++) {
        const c = await company(v23, `Co${i}`);
        await seedRun(v23, c, {
          status: 'SUCCEEDED',
          found: 100,
          complete: true,
          reconciled: true,
          hoursAgo: 3,
        });
        await seedRun(v23, c, {
          status: 'SUCCEEDED',
          found: 60,
          removed: 100 + i,
          complete: true,
          reconciled: true,
          hoursAgo: 2,
        });
      }
      const { rows, more } = await brief(v23).largeRetirements();
      expect(rows.map((r) => r.removed)).toEqual([106, 105, 104, 103, 102]);
      expect(rows.every((r) => r.referenceFound === 100)).toBe(true);
      expect(more).toBe(2);
    });
  });

  describe('the schema before A-01', () => {
    it('switch on: the startup check keeps the guard off, and crawls behave exactly as before', async () => {
      const svc = await ingest(pre, 'on');
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('the drop guard stays off'),
      );
      const c = await company(pre);
      const five = names(5);

      await svc.syncCompanyJobs(c, SOURCE, jobsOf([...five, ...five]));
      const r = await svc.syncCompanyJobs(c, SOURCE, jobsOf([five[0]]));

      expect(r.removed).toBe(4);
      const runs = await pre.$queryRaw<{ found: number; removed: number }[]>`
        SELECT "jobsFound" AS found, "jobsRemoved" AS removed FROM crawl_runs WHERE "companyId" = ${c} ORDER BY "startedAt"
      `;
      expect(runs).toEqual([
        { found: 10, removed: 0 }, // the raw entry count, as before
        { found: 1, removed: 4 },
      ]);
    });

    it('switch on: the real query fails on the missing column, and only the section is lost', async () => {
      const telegram = {
        isConfigured: () => false,
        send: async () => undefined,
      };
      const config = {
        get: (key: string) =>
          key === 'RETIREMENT_DROP_GUARD' ? 'on' : undefined,
      };
      const service = new DailyBriefService(
        pre as never,
        telegram as never,
        config as never,
      );

      // 42703 undefined_column: complete/reconciled do not exist here.
      await expect(service.largeRetirements()).rejects.toThrow(/42703/);
      const lines = await (
        service as unknown as { largeRetirementLines(): Promise<string[]> }
      ).largeRetirementLines();

      expect(lines).toEqual([]);
      expect(warnLog).toHaveBeenCalledWith(
        expect.stringContaining('large-retirements section left out'),
      );
    });
  });
});
