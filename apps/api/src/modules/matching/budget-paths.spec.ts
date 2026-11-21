import { AiUsageService } from '../ai/ai-usage.service';
import { AiSpendBlockedError } from '../ai/spend-policy';
import { MatchingService } from './matching.service';

/**
 * Every automatic AI path must stop at the daily ceiling. Before 2026-11-10 only
 * the evaluation belt checked it: the incremental path judged each new job with
 * no limit, and resume activation could re-score 400 jobs on top of a spent day.
 *
 * The property under test is "was any work started", so the fakes count the
 * first query each path makes before it would reach the LLM.
 */

const ENV_KEYS = [
  'AI_DAILY_BUDGET_USD',
  'AI_CREDIT_EXPIRES_AT',
  'AI_DAILY_BUDGET_AFTER_CREDIT_USD',
  'AI_INTERACTIVE_RESERVE_USD',
];

function build(spentUsd: number) {
  const calls = { userQueries: 0, jobQueries: 0, retries: 0 };
  const prisma = {
    user: {
      findMany: () => {
        calls.userQueries++;
        return Promise.resolve([]);
      },
    },
    job: {
      findMany: () => {
        calls.jobQueries++;
        return Promise.resolve([]);
      },
    },
    aiUsage: {
      aggregate: () => Promise.resolve({ _sum: { costUsd: spentUsd } }),
    },
  };
  const notifications = {
    retryUndelivered: () => {
      calls.retries++;
      return Promise.resolve(0);
    },
  };
  const ai = new AiUsageService(prisma as never);
  const unused = {} as never;
  const service = new MatchingService(
    prisma as never,
    unused,
    unused,
    unused,
    notifications as never,
    unused,
    unused,
    ai,
  );
  return { service, calls };
}

describe('daily AI budget on every automatic path', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.AI_DAILY_BUDGET_USD = '10';
    process.env.AI_INTERACTIVE_RESERVE_USD = '0';
    process.env.AI_CREDIT_EXPIRES_AT = '2099-01-01';
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('incremental matching starts no work once the budget is spent', async () => {
    const { service, calls } = build(10);

    await expect(service.matchNewJobs(['job-1', 'job-2'])).resolves.toEqual({
      notified: 0,
      matched: 0,
    });

    expect(calls.userQueries).toBe(0);
  });

  it('incremental matching runs while under budget', async () => {
    const { service, calls } = build(9.99);

    await service.matchNewJobs(['job-1']);

    expect(calls.userQueries).toBe(1);
  });

  it('the evaluation belt skips once the budget is spent, and says why', async () => {
    const { service, calls } = build(12);

    const res = await service.reconcileAll(100);

    expect(res.skipped).toContain(
      'daily AI budget reached ($12.00/$10.00, credit',
    );
    expect(calls.userQueries).toBe(0);
  });

  it('alert retries still run when the budget is spent, because they cost no AI call', async () => {
    const { service, calls } = build(12);

    await service.reconcileAll(100);

    expect(calls.retries).toBe(1);
  });

  it('resume activation does not start a re-score once the budget is spent', async () => {
    const { service, calls } = build(12);

    await expect(
      service.reconcileForUser('user-1', 400),
    ).rejects.toBeInstanceOf(AiSpendBlockedError);

    expect(calls.userQueries).toBe(0);
  });

  it('uses the post-credit ceiling once the credit has expired', async () => {
    process.env.AI_CREDIT_EXPIRES_AT = '2020-01-01';
    process.env.AI_DAILY_BUDGET_AFTER_CREDIT_USD = '2';
    const { service, calls } = build(3);

    await service.matchNewJobs(['job-1']);

    expect(calls.userQueries).toBe(0);
  });

  it('defers embeddings quietly once the credit is over with no post-credit budget', async () => {
    process.env.AI_CREDIT_EXPIRES_AT = '2020-01-01';
    process.env.AI_DAILY_BUDGET_AFTER_CREDIT_USD = '0';
    const { service, calls } = build(0);

    await expect(service.embedJobsByIds(['job-1'])).resolves.toBe(0);

    expect(calls.jobQueries).toBe(0);
  });

  it('defers embedding once the budget is spent: embeddings count like every other call', async () => {
    const { service, calls } = build(10);

    await expect(service.embedJobsByIds(['job-1'])).resolves.toBe(0);

    expect(calls.jobQueries).toBe(0);
  });

  it('embeds while under the budget', async () => {
    const { service, calls } = build(9.99);

    await service.embedJobsByIds(['job-1']);

    expect(calls.jobQueries).toBe(1);
  });

  it('starts no automatic AI work at all while the credit end date is missing', async () => {
    delete process.env.AI_CREDIT_EXPIRES_AT;
    const { service, calls } = build(0);

    await service.matchNewJobs(['job-1']);
    const belt = await service.reconcileAll(100);
    await expect(service.embedJobsByIds(['job-1'])).resolves.toBe(0);

    expect(belt.skipped).toContain('AI_CREDIT_EXPIRES_AT');
    expect(calls.userQueries).toBe(0);
    expect(calls.jobQueries).toBe(0);
  });
});
