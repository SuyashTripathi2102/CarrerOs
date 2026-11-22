import { Logger } from '@nestjs/common';
import {
  DailyBriefService,
  formatLargeRetirements,
  LARGE_RETIREMENT_MIN,
  type LargeRetirement,
} from './daily-brief.service';

/** The 8 AM brief's large-retirement section (retirement drop guard, R1-T18). */

const row = (
  company: string,
  removed: number,
  found: number,
  referenceFound: number | null,
): LargeRetirement => ({
  company,
  source: 'breezy',
  found,
  removed,
  referenceFound,
});

describe('formatLargeRetirements', () => {
  it('R1-T18: lists each retirement with both counts, in the order given (largest first)', () => {
    expect(
      formatLargeRetirements(
        [row('Acme', 2451, 1, 1), row('Beta', 60, 120, 180)],
        0,
      ),
    ).toEqual([
      '🧹 <b>Large retirements (last 24 h)</b>',
      '• Acme (breezy): 2,451 retired · this crawl saw 1 · the previous valid crawl saw 1',
      '• Beta (breezy): 60 retired · this crawl saw 120 · the previous valid crawl saw 180',
    ]);
  });

  it('R1-T18: with none, there is no section at all', () => {
    expect(formatLargeRetirements([], 0)).toEqual([]);
  });

  it('R1-T18: with 7, five lines and "and 2 more"', () => {
    const five = [900, 800, 700, 600, 500].map((n, i) =>
      row(`Co${i}`, n, 10, 10),
    );
    const lines = formatLargeRetirements(five, 2);
    expect(lines).toHaveLength(7);
    expect(lines[6]).toBe('and 2 more');
  });

  it('says so when there was no earlier valid crawl', () => {
    expect(formatLargeRetirements([row('Acme', 75, 5, null)], 0)[1]).toBe(
      '• Acme (breezy): 75 retired · this crawl saw 5 · no earlier valid crawl',
    );
  });

  it('escapes company names for Telegram HTML', () => {
    expect(
      formatLargeRetirements([row('A&B <Labs>', 50, 1, 1)], 0)[1],
    ).toContain('A&amp;B &lt;Labs&gt;');
  });

  it('uses Indian digit grouping, like the rest of the brief', () => {
    expect(formatLargeRetirements([row('Big', 245100, 3, 3)], 0)[1]).toContain(
      '2,45,100 retired',
    );
  });
});

function build(
  opts: { guard?: string; rows?: unknown[]; queryThrows?: boolean } = {},
) {
  const sent: string[] = [];
  const queries: string[] = [];
  const params: unknown[][] = [];
  const prisma = {
    user: { findMany: async () => [{ id: 'user-1', name: 'Test User' }] },
    $queryRaw: jest.fn(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        queries.push(strings.join('?'));
        params.push(values);
        if (opts.queryThrows)
          throw new Error('column r.reconciled does not exist');
        return opts.rows ?? [];
      },
    ),
  };
  const telegram = {
    isConfigured: () => true,
    send: async (text: string) => {
      sent.push(text);
    },
  };
  const config = {
    get: (key: string) =>
      key === 'RETIREMENT_DROP_GUARD' ? opts.guard : undefined,
  };
  const service = new DailyBriefService(
    prisma as never,
    telegram as never,
    config as never,
  );
  // data()'s real shape: the v2 brief reads mustApply and worthALook as well.
  jest.spyOn(service, 'data').mockResolvedValue({
    newJobs24h: 0,
    indiaNew24h: 0,
    recommended24h: 0,
    topOpps: [],
    mustApply: [],
    worthALook: [],
    trending: [],
    missingSkills: [],
    followUps: [],
  });
  return { service, sent, queries, params, prisma };
}

describe('largeRetirements', () => {
  it('reads the required filters and the previous valid crawl, and counts what was left out', async () => {
    const { service, queries } = build({
      guard: 'on',
      rows: [
        {
          company: 'Acme',
          source: 'breezy',
          found: 1,
          removed: 2451,
          referenceFound: 1,
          total: 7,
        },
      ],
    });

    const result = await service.largeRetirements();

    expect(result).toEqual({ rows: [row('Acme', 2451, 1, 1)], more: 6 });
    const sql = queries[0].replace(/\s+/g, ' ');
    expect(sql).toContain('r.reconciled IS TRUE');
    expect(sql).toContain('r."jobsRemoved" >= ?');
    expect(sql).toContain(`r."finishedAt" > now() - interval '24 hours'`);
    expect(sql).toContain(
      `p.status = 'SUCCEEDED' AND p.complete IS TRUE AND p."jobsFound" > 0`,
    );
    expect(sql).toContain('p."startedAt" < r."startedAt"');
    expect(sql).toContain('p."finishedAt" < r."startedAt"'); // R1-D6
    expect(sql).toContain('ORDER BY r."jobsRemoved" DESC');
  });

  it('R1-D5: lists a retirement only at 50 or more jobs AND more than the crawl kept', async () => {
    // The definition is pinned here on purpose: changing either half must
    // fail this test and go through review.
    const { service, queries, params } = build({ guard: 'on' });

    await service.largeRetirements();

    expect(LARGE_RETIREMENT_MIN).toBe(50);
    const sql = queries[0].replace(/\s+/g, ' ');
    expect(sql).toContain(
      'AND r."jobsRemoved" >= ? AND r."jobsRemoved" > r."jobsFound" AND',
    );
    expect(params[0]).toEqual([50, 5]); // the threshold, then the line limit
  });
});

describe('the section inside the brief', () => {
  beforeEach(() =>
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
  );
  afterEach(() => jest.restoreAllMocks());

  it('appears when the switch is on and there is something to list', async () => {
    const { service, sent } = build({
      guard: 'on',
      rows: [
        {
          company: 'Acme',
          source: 'breezy',
          found: 1,
          removed: 2451,
          referenceFound: 1,
          total: 1,
        },
      ],
    });
    await service.sendAll();
    expect(sent[0]).toContain('🧹 <b>Large retirements (last 24 h)</b>');
    expect(sent[0]).toContain('• Acme (breezy): 2,451 retired');
  });

  it('is never queried with the switch off', async () => {
    const { service, sent, prisma } = build({ guard: 'off' });
    await service.sendAll();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(sent[0]).not.toContain('Large retirements');
  });

  it('a failing query costs the section, not the brief', async () => {
    const { service, sent } = build({ guard: 'on', queryThrows: true });
    await expect(service.sendAll()).resolves.toEqual({ sent: 1 });
    expect(sent[0]).toContain('Daily Brief');
    expect(sent[0]).not.toContain('Large retirements');
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining('large-retirements section left out'),
    );
  });
});
