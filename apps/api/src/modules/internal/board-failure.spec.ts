import { BadRequestException, Logger } from '@nestjs/common';
import { CrawlStatus } from '@prisma/client';
import { BOARD_SOURCES } from '@careeros/shared';
import { IngestService } from './ingest.service';
import { BoardFailureSchema, InternalController } from './internal.controller';

/** What IngestService.recordBoardFailure passes to prisma.crawlRun.create. */
interface CreateRunArgs {
  data: {
    source: string;
    status: CrawlStatus;
    startedAt: Date;
    finishedAt: Date;
    error: string;
    jobsFound?: number;
  };
}

/** An IngestService over a fake crawl_runs table that keeps every create call, typed. */
function ingestOverFakeRuns() {
  const created: CreateRunArgs[] = [];
  const prisma = {
    crawlRun: {
      create: (args: CreateRunArgs) => {
        created.push(args);
        return Promise.resolve({ id: 'run-1' });
      },
    },
  };
  return {
    service: new IngestService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    ),
    created,
  };
}

/** The controller with only the ingest dependency real enough to observe. */
function controller() {
  const recorded: [string, string][] = [];
  const ingest = {
    recordBoardFailure: (source: string, reason: string) => {
      recorded.push([source, reason]);
      return Promise.resolve({ crawlRunId: 'run-1' });
    },
  };
  return {
    controller: new InternalController(
      ingest as never,
      {} as never,
      {} as never,
      {} as never,
    ),
    recorded,
  };
}

describe('IngestService.recordBoardFailure', () => {
  beforeEach(() =>
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
  );
  afterEach(() => jest.restoreAllMocks());

  it('records an unreachable board as a FAILED run with zero jobs, never as a success', async () => {
    const { service, created } = ingestOverFakeRuns();

    const result = await service.recordBoardFailure(
      'freehire',
      'freehire: all 6 requests failed (EAI_AGAIN ×6)',
    );

    expect(result).toEqual({ crawlRunId: 'run-1' });
    expect(created).toHaveLength(1);
    const { data } = created[0];
    expect(data).toMatchObject({
      source: 'freehire',
      status: CrawlStatus.FAILED,
      error: 'freehire: all 6 requests failed (EAI_AGAIN ×6)',
    });
    expect(data.finishedAt).toBeInstanceOf(Date);
    expect(data.jobsFound ?? 0).toBe(0);
  });
});

describe('POST /internal/boards/failed: the source must be a known board', () => {
  it.each(BOARD_SOURCES)('accepts %s', (source) => {
    expect(
      BoardFailureSchema.safeParse({
        source,
        reason: `${source}: request failed (HTTP 503)`,
      }).success,
    ).toBe(true);
  });

  it.each(['freehrie', 'FreeHire', 'hn', '', 'remoteok ', 'linkedin'])(
    'refuses the source "%s"',
    (source) => {
      expect(
        BoardFailureSchema.safeParse({
          source,
          reason: 'x: request failed (HTTP 503)',
        }).success,
      ).toBe(false);
    },
  );

  it('refuses an empty reason and one over 300 characters', () => {
    expect(
      BoardFailureSchema.safeParse({ source: 'jooble', reason: '' }).success,
    ).toBe(false);
    expect(
      BoardFailureSchema.safeParse({
        source: 'jooble',
        reason: 'x'.repeat(301),
      }).success,
    ).toBe(false);
    expect(
      BoardFailureSchema.safeParse({
        source: 'jooble',
        reason: 'x'.repeat(300),
      }).success,
    ).toBe(true);
  });

  it('answers 400 for an unknown source and records nothing', () => {
    const { controller: c, recorded } = controller();

    expect(() =>
      c.recordBoardFailure({
        source: 'freehrie',
        reason: 'freehrie: request failed (HTTP 503)',
      }),
    ).toThrow(BadRequestException);
    expect(recorded).toEqual([]);
  });

  it('records a known source through IngestService', async () => {
    const { controller: c, recorded } = controller();

    await c.recordBoardFailure({
      source: 'jooble',
      reason: 'jooble: all 6 requests failed (EAI_AGAIN ×6)',
    });

    expect(recorded).toEqual([
      ['jooble', 'jooble: all 6 requests failed (EAI_AGAIN ×6)'],
    ]);
  });
});
