import { Logger } from '@nestjs/common';
import { AiCallKind } from '@prisma/client';
import { AiUsageService, type AdmitRequest } from './ai-usage.service';
import { AiSpendBlockedError } from './spend-policy';

const KEYS = [
  'AI_DAILY_BUDGET_USD',
  'AI_CREDIT_EXPIRES_AT',
  'AI_DAILY_BUDGET_AFTER_CREDIT_USD',
  'AI_INTERACTIVE_RESERVE_USD',
];

function build(spentInDb: number) {
  const calls = { aggregates: 0, created: [] as Record<string, unknown>[] };
  const prisma = {
    aiUsage: {
      aggregate: () => {
        calls.aggregates++;
        return Promise.resolve({ _sum: { costUsd: spentInDb } });
      },
      create: (args: { data: Record<string, unknown> }) => {
        calls.created.push(args.data);
        return Promise.resolve({});
      },
    },
  };
  return { service: new AiUsageService(prisma as never), calls };
}

/** A text call whose worst case is 8,192 output tokens at $9 per million: about $0.074. */
const TEXT: AdmitRequest = {
  kind: AiCallKind.GENERATE,
  model: 'gemini-3.5-flash',
  inputTokens: 10,
  maxOutputTokens: 8192,
};

describe('AiUsageService spend guard', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.AI_DAILY_BUDGET_USD = '1.5';
    process.env.AI_INTERACTIVE_RESERVE_USD = '0.25';
    process.env.AI_DAILY_BUDGET_AFTER_CREDIT_USD = '0';
    process.env.AI_CREDIT_EXPIRES_AT = '2099-01-01';
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    jest.restoreAllMocks();
  });

  it('reads the database at most once a minute', async () => {
    const { service, calls } = build(0.5);

    await service.blockReason(AiCallKind.GENERATE);
    await service.blockReason(AiCallKind.GENERATE);
    await service.blockReason(AiCallKind.GENERATE, true);
    service.release(await service.admit(TEXT));

    expect(calls.aggregates).toBe(1);
  });

  it('counts calls recorded since the last read', async () => {
    const { service, calls } = build(1.0);
    await expect(service.blockReason(AiCallKind.GENERATE)).resolves.toBeNull();

    // 30,000 output tokens at $9 per million = $0.27, taking the day to $1.27.
    service.record({
      kind: AiCallKind.GENERATE,
      provider: 'vertex',
      model: 'gemini-3.5-flash',
      items: 1,
      inputTokens: 0,
      outputTokens: 30_000,
      ok: true,
      latencyMs: 1,
    });

    await expect(service.blockReason(AiCallKind.GENERATE)).resolves.toContain(
      'daily AI budget reached',
    );
    expect(calls.aggregates).toBe(1);
  });

  it('counts embeddings against the budget like any other call', async () => {
    const { service, calls } = build(1.3);

    await expect(service.blockReason(AiCallKind.EMBED)).resolves.toContain(
      'embedding',
    );
    await expect(
      service.blockReason(AiCallKind.EMBED, true),
    ).resolves.toBeNull();
    expect(calls.aggregates).toBe(1);
  });

  it('refuses embeddings too once the credit period is over with no post-credit budget', async () => {
    process.env.AI_CREDIT_EXPIRES_AT = '2020-01-01';
    const { service } = build(0);

    await expect(service.blockReason(AiCallKind.EMBED)).resolves.toContain(
      'credit period ended',
    );
  });

  describe('admit and release', () => {
    it('holds a call’s worst case while it runs, and frees it when it ends', async () => {
      const { service } = build(1.15);

      const first = await service.admit(TEXT);
      expect(first.usd).toBeCloseTo((10 * 1.5 + 8192 * 9) / 1e6, 9);
      // $1.15 + $0.074 in flight: a check before starting work still sees room…
      await expect(
        service.blockReason(AiCallKind.GENERATE),
      ).resolves.toBeNull();
      // …but a second worst case of $0.074 would pass $1.25.
      await expect(service.admit(TEXT)).rejects.toBeInstanceOf(
        AiSpendBlockedError,
      );

      service.release(first);
      const second = await service.admit(TEXT);
      service.release(second);
    });

    it('lets through only the calls that fit when several start at once', async () => {
      const { service } = build(1.1);

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => service.admit(TEXT)),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
      const refused = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect(refused).toHaveLength(3);
      for (const r of refused)
        expect(r.reason).toBeInstanceOf(AiSpendBlockedError);
    });

    it("lets the user's own call use the reserve that background calls may not", async () => {
      const { service } = build(1.2);

      await expect(service.admit(TEXT)).rejects.toBeInstanceOf(
        AiSpendBlockedError,
      );
      const own = await service.admit({ ...TEXT, interactive: true });
      service.release(own);
    });

    it('refuses a model with no price before reading or spending anything', async () => {
      const { service, calls } = build(0);

      await expect(
        service.admit({ ...TEXT, model: 'gemini-99-ultra' }),
      ).rejects.toThrow('has no price in PRICE_PER_MTOK');
      await expect(
        service.admit({
          kind: AiCallKind.EMBED,
          model: 'text-embedding-99',
          inputTokens: 5,
          maxOutputTokens: 0,
        }),
      ).rejects.toThrow('has no price in PRICE_PER_MTOK');
      expect(calls.aggregates).toBe(0);
    });

    it('refuses every call while the credit end date is missing', async () => {
      delete process.env.AI_CREDIT_EXPIRES_AT;
      const { service } = build(0);

      await expect(service.admit(TEXT)).rejects.toThrow('AI_CREDIT_EXPIRES_AT');
      await expect(
        service.admit({ ...TEXT, interactive: true }),
      ).rejects.toThrow('AI_CREDIT_EXPIRES_AT');
    });
  });

  describe('assertStillAllowed, before every attempt of an admitted call', () => {
    it('lets the attempt go while nothing has changed', async () => {
      const { service } = build(0);
      const admission = await service.admit(TEXT);

      expect(() => service.assertStillAllowed(admission)).not.toThrow();
      service.release(admission);
    });

    it('stops a call admitted during the credit once the credit has ended', async () => {
      const { service } = build(0);
      const admission = await service.admit(TEXT);

      process.env.AI_CREDIT_EXPIRES_AT = '2020-01-01';

      expect(() => service.assertStillAllowed(admission)).toThrow(
        'while this call was waiting',
      );
      service.release(admission);
    });

    it('stops it if the credit end date has become invalid', async () => {
      const { service } = build(0);
      const admission = await service.admit(TEXT);

      process.env.AI_CREDIT_EXPIRES_AT = 'soon';

      expect(() => service.assertStillAllowed(admission)).toThrow(
        AiSpendBlockedError,
      );
      service.release(admission);
    });
  });

  describe('an attempt with no confirmed outcome', () => {
    it('is charged at exactly its worst case, in a row of its own, and frees its reservation', async () => {
      const { service, calls } = build(1.15);
      const admission = await service.admit(TEXT);

      service.chargeUnconfirmed(admission, 'vertex', 'timeout', 1234);

      expect(calls.created).toEqual([
        expect.objectContaining({
          kind: 'GENERATE',
          provider: 'vertex',
          items: 1,
          inputTokens: 10,
          outputTokens: 8192,
          ok: false,
          errorCode: 'unconfirmed_timeout',
          latencyMs: 1234,
        }),
      ]);
      expect(calls.created[0].costUsd).toBeCloseTo(admission.usd, 12);
      // $1.15 + the $0.074 charge = $1.224: no reservation is left, but the charge counts as spent,
      // so a second worst case of $0.074 no longer fits under $1.25.
      await expect(
        service.blockReason(AiCallKind.GENERATE),
      ).resolves.toBeNull();
      await expect(service.admit(TEXT)).rejects.toBeInstanceOf(
        AiSpendBlockedError,
      );
    });

    it('can neither be charged twice nor released after it was charged', async () => {
      const { service, calls } = build(1.1);
      const other = await service.admit(TEXT);
      const admission = await service.admit(TEXT);

      service.chargeUnconfirmed(admission, 'vertex', 'timeout');
      service.chargeUnconfirmed(admission, 'vertex', 'timeout');
      service.release(admission);

      expect(calls.created).toHaveLength(1);
      // $1.10 + $0.074 charged + $0.074 still held for `other`: a third worst case does not fit. Had
      // the release after the charge freed `other`'s share too, it would.
      await expect(service.admit(TEXT)).rejects.toBeInstanceOf(
        AiSpendBlockedError,
      );
      service.release(other);
    });

    it('is released only once however often release() is called', async () => {
      const { service } = build(1.1);
      const first = await service.admit(TEXT);
      const second = await service.admit(TEXT);

      service.release(first);
      service.release(first);

      // `second` is still held: $1.10 + $0.074 held + $0.074 new = $1.247 fits, a third would not.
      const third = await service.admit(TEXT);
      await expect(service.admit(TEXT)).rejects.toBeInstanceOf(
        AiSpendBlockedError,
      );
      service.release(second);
      service.release(third);
    });
  });

  describe('a request cover, around every attempt', () => {
    it('re-checks before the first attempt and releases at the end', async () => {
      const { service } = build(1.15);
      const cover = await service.cover(TEXT, 'vertex');

      await cover.beforeAttempt();
      cover.end();
      cover.end();

      // Nothing is held any more ($1.15 + $0.074 fits); had end() kept the reservation, it would not.
      service.release(await service.admit(TEXT));
    });

    it('after a charged attempt, admits the retry again, and refuses it without room', async () => {
      const { service, calls } = build(1.1);
      const cover = await service.cover(TEXT, 'vertex');
      await cover.beforeAttempt();

      cover.unconfirmed('http_503');
      await cover.beforeAttempt(); // $1.10 + $0.074 charged + $0.074 = $1.247: fits
      cover.unconfirmed('http_503');
      await expect(cover.beforeAttempt()).rejects.toBeInstanceOf(
        AiSpendBlockedError,
      );
      cover.end();

      expect(calls.created.map((r) => r.errorCode)).toEqual([
        'unconfirmed_http_503',
        'unconfirmed_http_503',
      ]);
    });
  });

  describe('configuration problems', () => {
    it('are logged once when the API starts, and not again on every call', async () => {
      process.env.AI_DAILY_BUDGET_AFTER_CREDIT_USD = 'two';
      const errors = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const { service } = build(0);

      service.onModuleInit();
      await service.blockReason(AiCallKind.GENERATE);
      service.release(await service.admit(TEXT));

      const about = errors.mock.calls.filter((c) =>
        String(c[0]).includes('AI_DAILY_BUDGET_AFTER_CREDIT_USD'),
      );
      expect(about).toHaveLength(1);
    });
  });
});
