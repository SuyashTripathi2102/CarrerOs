import { ServiceUnavailableException } from '@nestjs/common';
import { AiCallKind } from '@prisma/client';

/**
 * Thrown before a provider call the spending policy refuses. Nothing was sent, so nothing is billed.
 *
 * An HTTP 503 with the reason as its message: when a person's request is refused (a draft, a
 * re-score), they are told why, instead of getting a bare "Internal server error". Outside HTTP
 * (queues, schedules) it is an ordinary error, recognised with `instanceof`.
 */
export class AiSpendBlockedError extends ServiceUnavailableException {
  constructor(reason: string) {
    super(reason);
    this.name = 'AiSpendBlockedError';
  }
}

export interface SpendEnv {
  AI_DAILY_BUDGET_USD?: string;
  AI_CREDIT_EXPIRES_AT?: string;
  AI_DAILY_BUDGET_AFTER_CREDIT_USD?: string;
  AI_INTERACTIVE_RESERVE_USD?: string;
}

/**
 * The spending settings as read, with every problem named.
 *
 * Fail closed: a setting that is present but invalid takes its safe value, never a larger one, and
 * a missing or invalid credit end date leaves `creditEndsAt` null, which refuses every call. Only
 * an explicitly configured positive post-credit budget can ever let a call bill the card.
 */
export interface SpendConfig {
  /** When the credit period ends, ms since epoch; null when missing or invalid. */
  creditEndsAt: number | null;
  /** Daily budget while the credit lasts. Missing: 8. Invalid: 0. */
  creditBudget: number;
  /** Daily budget after the credit. Missing or invalid: 0, so the card is never billed by default. */
  postCreditBudget: number;
  /** Kept back from background work for the user's own actions. Missing or invalid: 0.25. */
  reserve: number;
  problems: string[];
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * An instant from YYYY-MM-DD (00:00 UTC that day) or YYYY-MM-DDTHH:MM[:SS[.sss]] with Z or ±HH:MM
 * (at most ±14:00), or null. Strict on purpose: JavaScript's Date accepts "Nov 25 2026", rolls 30 February into March
 * and reads a time without a zone as local time, and any of those would move the end of the credit.
 */
export function parseCreditEnd(raw: string): number | null {
  const date = DATE_ONLY.exec(raw);
  const full = date ? null : DATE_TIME.exec(raw);
  const m = date ?? full;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [h, mi, s] = full
    ? [Number(full[4]), Number(full[5]), Number(full[6] ?? 0)]
    : [0, 0, 0];
  const msPart = full?.[7] ? Number(full[7].padEnd(3, '0')) : 0;
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59) return null;
  const wall = Date.UTC(y, mo - 1, d, h, mi, s, msPart);
  const back = new Date(wall);
  if (
    back.getUTCFullYear() !== y ||
    back.getUTCMonth() !== mo - 1 ||
    back.getUTCDate() !== d
  )
    return null;
  let offsetMin = 0;
  const zone = full?.[8];
  if (zone && zone !== 'Z') {
    const oh = Number(zone.slice(1, 3));
    const om = Number(zone.slice(4, 6));
    // Real offsets run from -12:00 to +14:00; ±14:00 is the bound accepted here, in both directions.
    if (om > 59 || oh * 60 + om > 14 * 60) return null;
    offsetMin = (zone.startsWith('-') ? -1 : 1) * (oh * 60 + om);
  }
  return wall - offsetMin * 60_000;
}

/** A dollar amount: blank means "not set" (the default); anything not a finite number ≥ 0 is a problem. */
function amount(
  env: SpendEnv,
  key: keyof SpendEnv,
  ifMissing: number,
  ifInvalid: number,
  problems: string[],
): number {
  const raw = env[key]?.trim();
  if (!raw) return ifMissing;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  problems.push(`${key} "${raw}" is not an amount in USD; using ${ifInvalid}`);
  return ifInvalid;
}

export function readSpendConfig(env: SpendEnv): SpendConfig {
  const problems: string[] = [];
  const rawEnd = env.AI_CREDIT_EXPIRES_AT?.trim();
  let creditEndsAt: number | null = null;
  if (!rawEnd) {
    problems.push(
      'AI_CREDIT_EXPIRES_AT is not set; every AI call is refused until it is',
    );
  } else {
    creditEndsAt = parseCreditEnd(rawEnd);
    if (creditEndsAt === null) {
      problems.push(
        `AI_CREDIT_EXPIRES_AT "${rawEnd}" is not YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS] with Z or ±HH:MM; every AI call is refused until it is`,
      );
    }
  }
  return {
    creditEndsAt,
    creditBudget: amount(env, 'AI_DAILY_BUDGET_USD', 8, 0, problems),
    postCreditBudget: amount(
      env,
      'AI_DAILY_BUDGET_AFTER_CREDIT_USD',
      0,
      0,
      problems,
    ),
    reserve: amount(env, 'AI_INTERACTIVE_RESERVE_USD', 0.25, 0.25, problems),
    problems,
  };
}

/**
 * Today's ceiling in recorded USD. Until the credit ends every call draws on the GCP credit; from
 * that instant the same calls would bill the attached card, so the post-credit budget applies.
 * With no valid end date there is no budget at all.
 */
export function dailyBudget(
  env: SpendEnv,
  now: number,
): { budget: number; regime: 'credit' | 'post-credit' | 'misconfigured' } {
  const config = readSpendConfig(env);
  if (config.creditEndsAt === null)
    return { budget: 0, regime: 'misconfigured' };
  return now >= config.creditEndsAt
    ? { budget: config.postCreditBudget, regime: 'post-credit' }
    : { budget: config.creditBudget, regime: 'credit' };
}

/**
 * Why an AI call must not be made, or null when it may.
 *
 * - A missing or invalid credit end date refuses every call: without it nothing can tell credit
 *   from card.
 * - After the credit period with a post-credit budget of 0 (the default), nothing is allowed. This
 *   is the guarantee that CareerOS never spends real money once the credit is gone.
 * - Background work, embeddings included, stops a reserve short of the daily budget, so the user's
 *   own actions (parsing their resume, drafting a message) still work after the belt has spent its
 *   share. Embeddings count like every other call.
 * - `pendingUsd` is what calls already in flight may still cost, and `callUsd` this call's worst
 *   case. A call is allowed only if all of it fits, so calls running at once cannot together
 *   overshoot the limit. Without `callUsd` (a check before starting work), the question is only
 *   whether anything is left.
 */
export function spendBlockReason(input: {
  kind: AiCallKind;
  interactive: boolean;
  spentTodayUsd: number;
  env: SpendEnv;
  now: number;
  pendingUsd?: number;
  callUsd?: number;
}): string | null {
  const config = readSpendConfig(input.env);
  if (config.creditEndsAt === null) {
    return `AI calls refused: ${config.problems.filter((p) => p.startsWith('AI_CREDIT_EXPIRES_AT')).join('; ')}`;
  }
  const { budget, regime } = dailyBudget(input.env, input.now);
  if (regime === 'post-credit' && budget === 0) {
    return `AI calls paused: the credit period ended (${input.env.AI_CREDIT_EXPIRES_AT?.trim()}) and the post-credit budget is 0`;
  }

  const reserve = Math.min(budget, config.reserve);
  const limit = input.interactive ? budget : budget - reserve;
  const committed = input.spentTodayUsd + (input.pendingUsd ?? 0);
  const callUsd = input.callUsd ?? 0;
  const fits = callUsd > 0 ? committed + callUsd <= limit : committed < limit;
  if (fits) return null;
  const who = input.interactive ? '' : ', background work';
  const kind = input.kind === AiCallKind.EMBED ? ', embedding' : '';
  return (
    `daily AI budget reached ($${committed.toFixed(2)}` +
    (callUsd > 0 ? ` + $${callUsd.toFixed(3)} for this call` : '') +
    `/$${limit.toFixed(2)}, ${regime}${who}${kind}; resets at 00:00 UTC)`
  );
}
