import { Logger } from '@nestjs/common';
import { CrawlStatus, JobStatus } from '@prisma/client';
import type { NormalizedJob } from '@careeros/shared';
import { IngestService } from './ingest.service';

/**
 * The retirement drop guard (R-1), service level, against a mocked database:
 * what syncCompanyJobs asks the database for, writes and logs in each mode.
 * The same behaviour against a real database is retirement-guard.int.spec.ts.
 */

const COMPANY = 'company-1';
const SOURCE = 'breezy';
const STARTED = new Date('2026-11-11T05:00:00.000Z');

const job = (externalId: string): NormalizedJob => ({
  externalId,
  title: `Engineer ${externalId}`,
  description: '',
  url: `https://jobs.example.com/${externalId}`,
});
const jobsNamed = (n: number, prefix = 'job') =>
  Array.from({ length: n }, (_, i) => job(`${prefix}-${i}`));

interface Options {
  guardSwitch?: string;
  columns?: boolean; // does crawl_runs have complete/reconciled?
  reference?: number | null; // the previous valid crawl's jobsFound
  retired?: number; // what the retirement updateMany reports
  failUpsert?: boolean;
  failEmbed?: boolean;
  failRecording?: boolean;
}

function sqlOf(strings: TemplateStringsArray): string {
  return strings.join('?');
}

async function build(opts: Options = {}) {
  const calls = {
    referenceQueries: [] as unknown[][],
    referenceSql: [] as string[],
    runUpdates: [] as Record<string, unknown>[],
    runFlags: [] as {
      complete: unknown;
      reconciled: unknown;
      runId: unknown;
    }[],
    retirements: [] as Record<string, unknown>[],
    embeds: 0,
  };
  const prisma = {
    crawlRun: {
      create: jest.fn(async () => ({ id: 'run-1', startedAt: STARTED })),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => {
        calls.runUpdates.push(args.data);
        return {};
      }),
      findMany: jest.fn(async () => [{ status: CrawlStatus.SUCCEEDED }]),
    },
    company: {
      findUnique: jest.fn(async () => ({
        confidenceSignals: {},
        crawlTier: 'WARM',
      })),
      update: jest.fn(async () => ({})),
    },
    job: {
      findMany: jest.fn(async () => []),
      updateMany: jest.fn(async (args: { where: Record<string, unknown> }) => {
        calls.retirements.push(args.where);
        return { count: opts.retired ?? 0 };
      }),
    },
    $queryRaw: jest.fn(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = sqlOf(strings);
        if (sql.includes('information_schema.columns'))
          return [{ n: opts.columns ? 2 : 0 }];
        if (sql.includes('INSERT INTO jobs')) {
          if (opts.failUpsert) throw new Error('upsert failed');
          const ids = values[1] as string[]; // values[0] is the companyId
          return ids.map((id) => ({ id, inserted: true, description: '' }));
        }
        if (sql.includes('complete IS TRUE')) {
          calls.referenceQueries.push(values);
          calls.referenceSql.push(sql);
          return opts.reference == null ? [] : [{ found: opts.reference }];
        }
        if (sql.includes('company_watches')) {
          return [
            {
              active: 1n,
              new14: 0n,
              last_new: null,
              attempts: 1n,
              watched: 0n,
            },
          ];
        }
        throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
      },
    ),
    $executeRaw: jest.fn(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (!sqlOf(strings).includes('UPDATE crawl_runs SET complete')) {
          throw new Error('unexpected statement');
        }
        if (opts.failRecording) throw new Error('recording failed');
        const [complete, reconciled, runId] = values;
        calls.runFlags.push({ complete, reconciled, runId });
        return 1;
      },
    ),
  };
  const embedQueue = {
    add: jest.fn(async () => {
      if (opts.failEmbed) throw new Error('redis down');
      calls.embeds++;
    }),
  };
  const config = {
    get: (key: string) =>
      key === 'RETIREMENT_DROP_GUARD' ? opts.guardSwitch : undefined,
  };
  const service = new IngestService(
    prisma as never,
    {} as never,
    embedQueue as never,
    config as never,
  );
  await service.onModuleInit();
  return { service, prisma, calls };
}

let warn: jest.SpyInstance;
let error: jest.SpyInstance;
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  warn = jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);
  error = jest
    .spyOn(Logger.prototype, 'error')
    .mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('guard on, A-01 columns present', () => {
  it('R1-T01: a sudden drop retires nothing and is recorded as not reconciled', async () => {
    const { service, calls } = await build({
      guardSwitch: 'on',
      columns: true,
      reference: 2452,
    });

    const result = await service.syncCompanyJobs(COMPANY, SOURCE, [
      job('only'),
    ]);

    expect(calls.retirements).toEqual([]);
    expect(result.removed).toBe(0);
    // R1-D6: the run's start bounds both startedAt and finishedAt.
    expect(calls.referenceQueries).toEqual([
      [COMPANY, SOURCE, STARTED, STARTED],
    ]);
    expect(calls.referenceSql[0].replace(/\s+/g, ' ')).toContain(
      '"startedAt" < ? AND "finishedAt" < ?',
    );
    expect(calls.runUpdates[0]).toMatchObject({
      status: CrawlStatus.SUCCEEDED,
      jobsFound: 1,
      jobsRemoved: 0,
    });
    expect(calls.runFlags).toEqual([
      { complete: true, reconciled: false, runId: 'run-1' },
    ]);
  });

  it('R1-T13: every skip is logged with company, source, both counts and the reason', async () => {
    const { service } = await build({
      guardSwitch: 'on',
      columns: true,
      reference: 2452,
    });
    await service.syncCompanyJobs(COMPANY, SOURCE, [job('only')]);
    expect(warn).toHaveBeenCalledWith(
      `[breezy] company company-1: reconciliation skipped (SUDDEN_DROP) — existing jobs preserved; ` +
        `this crawl saw 1, the previous valid crawl 2452`,
    );

    const none = await build({
      guardSwitch: 'on',
      columns: true,
      reference: null,
    });
    await none.service.syncCompanyJobs(COMPANY, SOURCE, [job('only')]);
    expect(warn).toHaveBeenLastCalledWith(
      `[breezy] company company-1: reconciliation skipped (NO_REFERENCE) — existing jobs preserved; ` +
        `this crawl saw 1, no previous valid crawl`,
    );
  });

  it('retires normally at or above half the reference, and records reconciled', async () => {
    const { service, calls } = await build({
      guardSwitch: 'on',
      columns: true,
      reference: 100,
      retired: 50,
    });

    const result = await service.syncCompanyJobs(
      COMPANY,
      SOURCE,
      jobsNamed(50),
    );

    expect(result.removed).toBe(50);
    expect(calls.retirements).toHaveLength(1);
    expect(calls.retirements[0]).toMatchObject({
      companyId: COMPANY,
      source: SOURCE,
      status: JobStatus.ACTIVE,
    });
    expect(calls.runFlags).toEqual([
      { complete: true, reconciled: true, runId: 'run-1' },
    ]);
  });

  it('R1-T17: the seen count and jobsFound are distinct, so repeats cannot hide a truncation', async () => {
    const forty = jobsNamed(40);
    const { service, calls } = await build({
      guardSwitch: 'on',
      columns: true,
      reference: 100,
    });

    await service.syncCompanyJobs(COMPANY, SOURCE, [
      ...forty,
      ...forty,
      ...forty,
    ]);

    expect(calls.retirements).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('(SUDDEN_DROP)'));
    expect(calls.runUpdates[0]).toMatchObject({ jobsFound: 40 });
  });

  it('R1-T21: a partial walk is recorded complete=false, reconciled=false', async () => {
    const { service, calls } = await build({
      guardSwitch: 'on',
      columns: true,
      reference: 10,
    });
    await service.syncCompanyJobs(COMPANY, SOURCE, jobsNamed(10), false);
    expect(calls.retirements).toEqual([]);
    expect(calls.runFlags).toEqual([
      { complete: false, reconciled: false, runId: 'run-1' },
    ]);
  });

  it('R1-T21: an empty result is recorded with what the walk reported, reconciled=false', async () => {
    const { service, calls } = await build({
      guardSwitch: 'on',
      columns: true,
      reference: 10,
    });
    await service.syncCompanyJobs(COMPANY, SOURCE, []);
    expect(calls.runUpdates[0]).toMatchObject({ jobsFound: 0 });
    expect(calls.runFlags).toEqual([
      { complete: true, reconciled: false, runId: 'run-1' },
    ]);
  });
});

describe('guard off', () => {
  it('R1-T15: never reads a reference, and retires exactly as before', async () => {
    const { service, calls } = await build({
      guardSwitch: 'off',
      columns: true,
      reference: 2452,
      retired: 2451,
    });

    const result = await service.syncCompanyJobs(COMPANY, SOURCE, [
      job('only'),
    ]);

    expect(calls.referenceQueries).toEqual([]);
    expect(result.removed).toBe(2451);
    expect(calls.retirements[0]).toMatchObject({
      externalId: { notIn: ['only'] },
    });
  });

  it('still records the run flags and the distinct count while the columns exist', async () => {
    const { service, calls } = await build({
      guardSwitch: undefined,
      columns: true,
    });
    const twice = jobsNamed(5);
    await service.syncCompanyJobs(COMPANY, SOURCE, [...twice, ...twice]);
    expect(calls.runUpdates[0]).toMatchObject({ jobsFound: 5 });
    expect(calls.runFlags).toEqual([
      { complete: true, reconciled: true, runId: 'run-1' },
    ]);
  });
});

describe('the schema before A-01 (no complete/reconciled columns)', () => {
  it('writes nothing new and keeps the raw count, even with the switch on', async () => {
    const { service, calls, prisma } = await build({
      guardSwitch: 'on',
      columns: false,
      retired: 3,
    });
    const twice = jobsNamed(5);

    const result = await service.syncCompanyJobs(COMPANY, SOURCE, [
      ...twice,
      ...twice,
    ]);

    expect(calls.referenceQueries).toEqual([]);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(calls.runUpdates[0]).toMatchObject({
      jobsFound: 10,
      jobsRemoved: 3,
    });
    expect(result).toMatchObject({ found: 10, removed: 3 });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('the drop guard stays off'),
    );
  });
});

describe('failures', () => {
  it('an ingest failure is recorded FAILED with reconciled=false, and the error is rethrown', async () => {
    const { service, calls } = await build({
      guardSwitch: 'on',
      columns: true,
      failUpsert: true,
    });

    await expect(
      service.syncCompanyJobs(COMPANY, SOURCE, jobsNamed(3), false),
    ).rejects.toThrow('upsert failed');

    expect(calls.runUpdates.at(-1)).toMatchObject({
      status: CrawlStatus.FAILED,
      error: 'upsert failed',
    });
    expect(calls.runFlags).toEqual([
      { complete: false, reconciled: false, runId: 'run-1' },
    ]);
  });

  it('a failure after retirement ran is recorded FAILED with reconciled=true', async () => {
    const { service, calls } = await build({
      guardSwitch: 'on',
      columns: true,
      reference: 3,
      retired: 2,
      failEmbed: true,
    });

    await expect(
      service.syncCompanyJobs(COMPANY, SOURCE, jobsNamed(3)),
    ).rejects.toThrow('redis down');

    expect(calls.retirements).toHaveLength(1);
    expect(calls.runUpdates.map((d) => d.status)).toEqual([
      CrawlStatus.SUCCEEDED,
      CrawlStatus.FAILED,
    ]);
    expect(calls.runFlags.at(-1)).toEqual({
      complete: true,
      reconciled: true,
      runId: 'run-1',
    });
  });

  it("a recording failure on the failure path never masks the crawl's own error", async () => {
    const { service } = await build({
      guardSwitch: 'on',
      columns: true,
      failUpsert: true,
      failRecording: true,
    });

    await expect(
      service.syncCompanyJobs(COMPANY, SOURCE, jobsNamed(3)),
    ).rejects.toThrow('upsert failed');
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('could not record complete/reconciled'),
    );
  });

  it('a recording failure after success keeps the run SUCCEEDED and returns its result', async () => {
    // Regression (review of 11 Nov): this failure used to reach the crawl's
    // catch and turn a successful crawl into a FAILED one.
    const { service, calls, prisma } = await build({
      guardSwitch: 'on',
      columns: true,
      reference: 100,
      retired: 40,
      failRecording: true,
    });

    const result = await service.syncCompanyJobs(
      COMPANY,
      SOURCE,
      jobsNamed(60),
    );

    expect(result).toMatchObject({ found: 60, removed: 40 });
    // One run update, the SUCCEEDED one: the failure handler never ran.
    expect(calls.runUpdates).toEqual([
      expect.objectContaining({
        status: CrawlStatus.SUCCEEDED,
        jobsFound: 60,
        jobsRemoved: 40,
      }),
    ]);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(calls.runFlags).toEqual([]); // nothing recorded: never a reference
    expect(calls.embeds).toBe(1); // the steps after recording still ran
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        'the run keeps its status and cannot be a reference',
      ),
    );
  });
});
