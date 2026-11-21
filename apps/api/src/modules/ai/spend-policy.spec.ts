import { HttpException } from '@nestjs/common';
import { AiCallKind } from '@prisma/client';
import {
  AiSpendBlockedError,
  dailyBudget,
  parseCreditEnd,
  readSpendConfig,
  spendBlockReason,
  type SpendEnv,
} from './spend-policy';

const DURING_CREDIT = Date.parse('2026-11-10T06:00:00Z');
const AFTER_CREDIT = Date.parse('2026-11-26T06:00:00Z');

const ENV: SpendEnv = {
  AI_DAILY_BUDGET_USD: '1.5',
  AI_CREDIT_EXPIRES_AT: '2026-11-25',
  AI_DAILY_BUDGET_AFTER_CREDIT_USD: '0',
  AI_INTERACTIVE_RESERVE_USD: '0.25',
};

const without = (key: keyof SpendEnv): SpendEnv => {
  const env = { ...ENV };
  delete env[key];
  return env;
};

const check = (over: Partial<Parameters<typeof spendBlockReason>[0]> = {}) =>
  spendBlockReason({
    kind: AiCallKind.GENERATE,
    interactive: false,
    spentTodayUsd: 0,
    env: ENV,
    now: DURING_CREDIT,
    ...over,
  });

describe('parseCreditEnd: strict, so a typo cannot move the end of the credit', () => {
  it.each([
    ['2026-11-25', '2026-11-25T00:00:00.000Z'],
    ['2026-11-24T18:30Z', '2026-11-24T18:30:00.000Z'],
    ['2026-11-24T18:30:15.5Z', '2026-11-24T18:30:15.500Z'],
    ['2026-11-25T00:00+05:30', '2026-11-24T18:30:00.000Z'],
    ['2026-11-24T19:00:00-05:00', '2026-11-25T00:00:00.000Z'],
    ['2026-11-25T14:00+14:00', '2026-11-25T00:00:00.000Z'],
    ['2026-11-24T10:00-14:00', '2026-11-25T00:00:00.000Z'],
    ['2028-02-29', '2028-02-29T00:00:00.000Z'],
  ])('reads %s as %s', (raw, iso) => {
    expect(new Date(parseCreditEnd(raw)!).toISOString()).toBe(iso);
  });

  it.each([
    ['25-11-2026', 'day first'],
    ['Nov 25 2026', 'words (JavaScript reads it as LOCAL midnight)'],
    ['2026/11/25', 'slashes'],
    ['2026-11-25 10:00', 'a space instead of T'],
    [
      '2026-11-25T10:00',
      'a time with no zone (JavaScript reads it as local time)',
    ],
    [
      '2026-02-30',
      'a day the month does not have (JavaScript rolls it into March)',
    ],
    ['2027-02-29', 'not a leap year'],
    ['2026-13-01', 'month 13'],
    ['2026-11-25T24:00Z', 'hour 24'],
    ['2026-11-25T10:00+15:00', 'an offset beyond ±14:00'],
    ['2026-11-25T10:00+14:01', 'an offset one minute beyond +14:00'],
    ['2026-11-25T10:00-14:59', 'an offset beyond -14:00'],
    ['2026-11-25T10:00+14:30', 'an offset beyond +14:00 within the hour'],
    ['2026-11-25T10:00+05:60', 'minute 60 in the offset'],
    ['tomorrow', 'not a date'],
  ])('refuses %s (%s)', (raw) => {
    expect(parseCreditEnd(raw)).toBeNull();
  });
});

describe('readSpendConfig: fail closed', () => {
  it('reads a complete configuration with no problems', () => {
    expect(readSpendConfig(ENV)).toEqual({
      creditEndsAt: Date.parse('2026-11-25T00:00:00Z'),
      creditBudget: 1.5,
      postCreditBudget: 0,
      reserve: 0.25,
      problems: [],
    });
  });

  it.each([
    ['missing', undefined],
    ['blank', '   '],
    ['unreadable', '25-11-2026'],
  ])(
    'an end date that is %s is a problem and leaves no credit period',
    (_case, value) => {
      const config = readSpendConfig({ ...ENV, AI_CREDIT_EXPIRES_AT: value });
      expect(config.creditEndsAt).toBeNull();
      expect(config.problems.join()).toContain('AI_CREDIT_EXPIRES_AT');
    },
  );

  it('a missing or blank post-credit budget is 0, not $2', () => {
    expect(
      readSpendConfig(without('AI_DAILY_BUDGET_AFTER_CREDIT_USD'))
        .postCreditBudget,
    ).toBe(0);
    expect(
      readSpendConfig({ ...ENV, AI_DAILY_BUDGET_AFTER_CREDIT_USD: ' ' })
        .postCreditBudget,
    ).toBe(0);
  });

  it.each(['two', '-1', '2,5', 'Infinity', 'NaN'])(
    'an invalid post-credit budget (%s) is 0, and named as a problem',
    (value) => {
      const config = readSpendConfig({
        ...ENV,
        AI_DAILY_BUDGET_AFTER_CREDIT_USD: value,
      });
      expect(config.postCreditBudget).toBe(0);
      expect(config.problems.join()).toContain(
        'AI_DAILY_BUDGET_AFTER_CREDIT_USD',
      );
    },
  );

  it('an invalid credit-period budget pauses AI (0) instead of raising it to the $8 default', () => {
    const config = readSpendConfig({ ...ENV, AI_DAILY_BUDGET_USD: '1,5' });
    expect(config.creditBudget).toBe(0);
    expect(config.problems.join()).toContain('AI_DAILY_BUDGET_USD');
  });

  it('a blank credit-period budget is still "unset", not 0', () => {
    expect(
      readSpendConfig({ ...ENV, AI_DAILY_BUDGET_USD: '  ' }).creditBudget,
    ).toBe(8);
  });

  it('an invalid reserve keeps the 0.25 default', () => {
    expect(
      readSpendConfig({ ...ENV, AI_INTERACTIVE_RESERVE_USD: 'lots' }).reserve,
    ).toBe(0.25);
  });
});

describe('dailyBudget', () => {
  it('uses the credit-period budget before the credit ends', () => {
    expect(dailyBudget(ENV, DURING_CREDIT)).toEqual({
      budget: 1.5,
      regime: 'credit',
    });
  });

  it('switches to the post-credit budget at the very instant the credit ends', () => {
    const end = Date.parse('2026-11-25T00:00:00Z');
    expect(dailyBudget(ENV, end - 1).regime).toBe('credit');
    expect(dailyBudget(ENV, end)).toEqual({ budget: 0, regime: 'post-credit' });
  });

  it('has no budget at all without a valid end date', () => {
    expect(dailyBudget(without('AI_CREDIT_EXPIRES_AT'), DURING_CREDIT)).toEqual(
      {
        budget: 0,
        regime: 'misconfigured',
      },
    );
  });
});

describe('without a valid credit end date', () => {
  it.each([
    ['missing', without('AI_CREDIT_EXPIRES_AT')],
    ['unreadable', { ...ENV, AI_CREDIT_EXPIRES_AT: 'Nov 25 2026' }],
    [
      'unreadable, with a positive post-credit budget',
      {
        ...ENV,
        AI_CREDIT_EXPIRES_AT: 'soon',
        AI_DAILY_BUDGET_AFTER_CREDIT_USD: '5',
      },
    ],
  ])(
    '(%s) refuses every call: text, embedding, background and interactive',
    (_case, env) => {
      for (const kind of [AiCallKind.GENERATE, AiCallKind.EMBED]) {
        for (const interactive of [false, true]) {
          expect(check({ env, kind, interactive })).toContain(
            'AI_CREDIT_EXPIRES_AT',
          );
        }
      }
    },
  );
});

describe('during the credit period', () => {
  it('lets background work spend up to the budget minus the reserve', () => {
    expect(check({ spentTodayUsd: 1.24 })).toBeNull();
    expect(check({ spentTodayUsd: 1.25 })).toContain('daily AI budget reached');
  });

  it("lets the user's own actions use the reserve", () => {
    expect(check({ spentTodayUsd: 1.3, interactive: true })).toBeNull();
    expect(check({ spentTodayUsd: 1.5, interactive: true })).toContain(
      'daily AI budget reached',
    );
  });

  it('counts embeddings like any background call: they stop where the reserve begins', () => {
    expect(check({ kind: AiCallKind.EMBED, spentTodayUsd: 1.24 })).toBeNull();
    expect(check({ kind: AiCallKind.EMBED, spentTodayUsd: 1.25 })).toContain(
      'embedding',
    );
  });

  it('lets an embedding the user is waiting on (their resume) use the reserve', () => {
    expect(
      check({ kind: AiCallKind.EMBED, interactive: true, spentTodayUsd: 1.3 }),
    ).toBeNull();
  });

  it('never lets the reserve exceed the budget', () => {
    const env = { ...ENV, AI_DAILY_BUDGET_USD: '0.1' };
    expect(check({ env, spentTodayUsd: 0 })).toContain(
      'daily AI budget reached',
    );
    expect(check({ env, spentTodayUsd: 0.05, interactive: true })).toBeNull();
  });

  it('pauses everything when the credit-period budget is invalid', () => {
    expect(
      check({
        env: { ...ENV, AI_DAILY_BUDGET_USD: 'lots' },
        interactive: true,
      }),
    ).toContain('daily AI budget reached');
  });
});

describe('calls in flight and the worst case of this call', () => {
  it('lets a call through only if what is spent, in flight and its own worst case all fit', () => {
    // $1.10 spent + $0.07 in flight leaves $0.08 of the $1.25 background limit.
    expect(
      check({ spentTodayUsd: 1.1, pendingUsd: 0.07, callUsd: 0.09 }),
    ).toContain('for this call');
    expect(
      check({
        spentTodayUsd: 1.1,
        pendingUsd: 0.07,
        callUsd: 0.09,
        interactive: true,
      }),
    ).toBeNull();
    expect(
      check({ spentTodayUsd: 1.1, pendingUsd: 0.07, callUsd: 0.07 }),
    ).toBeNull();
  });

  it('a check before starting work counts the calls in flight', () => {
    expect(check({ spentTodayUsd: 1.2, pendingUsd: 0.06 })).toContain(
      'daily AI budget reached',
    );
    expect(check({ spentTodayUsd: 1.2, pendingUsd: 0.04 })).toBeNull();
  });

  it('says when the budget resets', () => {
    expect(check({ spentTodayUsd: 2 })).toContain('resets at 00:00 UTC');
  });
});

describe('after the credit period', () => {
  it('refuses every call when the post-credit budget is 0, so no real money is spent', () => {
    for (const kind of [AiCallKind.GENERATE, AiCallKind.EMBED]) {
      for (const interactive of [false, true]) {
        expect(
          check({ kind, interactive, spentTodayUsd: 0, now: AFTER_CREDIT }),
        ).toContain('credit period ended');
      }
    }
  });

  it('refuses every call when the post-credit budget is missing', () => {
    expect(
      check({
        env: without('AI_DAILY_BUDGET_AFTER_CREDIT_USD'),
        now: AFTER_CREDIT,
      }),
    ).toContain('credit period ended');
  });

  it('applies a positive post-credit budget only if one is deliberately configured, embeddings included', () => {
    const env = { ...ENV, AI_DAILY_BUDGET_AFTER_CREDIT_USD: '3' };
    expect(check({ env, now: AFTER_CREDIT, spentTodayUsd: 1 })).toBeNull();
    expect(check({ env, now: AFTER_CREDIT, spentTodayUsd: 3 })).toContain(
      'post-credit',
    );
    expect(
      check({
        env,
        now: AFTER_CREDIT,
        spentTodayUsd: 3,
        kind: AiCallKind.EMBED,
      }),
    ).toContain('post-credit');
  });
});

describe('AiSpendBlockedError', () => {
  it('is an HTTP 503 whose message is the reason', () => {
    const err = new AiSpendBlockedError('daily AI budget reached');
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(503);
    expect(err.message).toBe('daily AI budget reached');
    expect(err.name).toBe('AiSpendBlockedError');
  });
});
