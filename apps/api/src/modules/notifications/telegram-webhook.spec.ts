import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TelegramWebhookController } from './telegram-webhook.controller';
import { TelegramAppliedService } from './telegram-applied.service';
import { encodeAppliedToken } from './telegram-callback';

/** What Prisma throws when the unique (userId, jobId) rejects the second of two taps. */
const duplicateApplication = () =>
  new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed on the fields: (`userId`,`jobId`)',
    {
      code: 'P2002',
      clientVersion: Prisma.prismaVersion.client,
      meta: { modelName: 'Application', target: ['userId', 'jobId'] },
    },
  );

/**
 * The controller's job is to write an application EXACTLY once, and to write
 * nothing at all for every other input.
 *
 * The fakes below count writes rather than mocking a result, because the
 * property under test is "did anything reach the database", not "was a value
 * returned".
 */

const BOT_TOKEN = '12345:AAH-bot-token';
const CALLBACK_SECRET = `careeros-callback:${BOT_TOKEN}`;
const WEBHOOK_SECRET = 'a-long-random-webhook-secret';
const CHAT_ID = '987654321';
const NOTIF = 'cmtu225100df6f5j4uxbfl82l';
const USER = 'user-1';
const JOB = 'job-abc';

function build(opts: {
  notification?: { userId: string; payload: unknown } | null;
  existingApplication?: { id: string; status: string } | null;
  createError?: Error;
  inbound?: string;
}) {
  const calls = { created: [] as unknown[], answered: [] as string[] };
  const prisma = {
    notification: { findUnique: async () => opts.notification ?? null },
    application: { findUnique: async () => opts.existingApplication ?? null },
  };
  const applications = {
    createFromJob: async (userId: string, jobId: string, o: unknown) => {
      if (opts.createError) throw opts.createError;
      calls.created.push({ userId, jobId, o });
      return { id: 'app-1' };
    },
  };
  const telegram = {
    answerCallback: async (_id: string, text: string) => {
      calls.answered.push(text);
    },
  };
  const config = {
    get: (k: string) =>
      ({
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
        TELEGRAM_CHAT_ID: CHAT_ID,
        TELEGRAM_INBOUND: opts.inbound,
      })[k],
  };
  const applied = new TelegramAppliedService(
    prisma as never,
    applications as never,
    telegram as never,
  );
  const controller = new TelegramWebhookController(applied, config as never);
  return { controller, calls };
}

const validUpdate = (fromId: string = CHAT_ID) => ({
  callback_query: {
    id: 'cb-1',
    data: encodeAppliedToken(NOTIF, CALLBACK_SECRET),
    from: { id: fromId },
  },
});

const NOTIFICATION = { userId: USER, payload: { jobId: JOB, text: 'x' } };

describe('valid callback', () => {
  it('records the application through the EXISTING applications path', async () => {
    // Not a parallel writer: ApplicationsService.createFromJob also writes the
    // status event, the resume version that applied, and the APPLIED analytics
    // event. Duplicating that here would fork the outcome data.
    const { controller, calls } = build({ notification: NOTIFICATION });
    await expect(controller.webhook(validUpdate(), WEBHOOK_SECRET)).resolves.toEqual({ ok: true });
    expect(calls.created).toHaveLength(1);
    expect(calls.created[0]).toMatchObject({
      userId: USER,
      jobId: JOB,
      o: { source: 'telegram' },
    });
  });

  it('acknowledges in Telegram so the button stops spinning', async () => {
    const { controller, calls } = build({ notification: NOTIFICATION });
    await controller.webhook(validUpdate(), WEBHOOK_SECRET);
    expect(calls.answered[0]).toMatch(/Recorded as applied/i);
  });

  it('takes the job from the NOTIFICATION, never from the caller', async () => {
    // The callback names a notification we wrote; the job comes from that row.
    // A caller cannot record an application against a job of its choosing.
    const { controller, calls } = build({
      notification: { userId: USER, payload: { jobId: 'the-real-job' } },
    });
    await controller.webhook(validUpdate(), WEBHOOK_SECRET);
    expect(calls.created[0]).toMatchObject({ jobId: 'the-real-job' });
  });
});

describe('idempotency — Telegram retries and users double-tap', () => {
  it('does not create a second application when one already exists', async () => {
    const { controller, calls } = build({
      notification: NOTIFICATION,
      existingApplication: { id: 'app-1', status: 'APPLIED' },
    });
    await controller.webhook(validUpdate(), WEBHOOK_SECRET);
    expect(calls.created).toHaveLength(0);
    expect(calls.answered[0]).toMatch(/Already recorded/i);
  });

  it('reports the existing state when the application moved on', async () => {
    const { controller, calls } = build({
      notification: NOTIFICATION,
      existingApplication: { id: 'app-1', status: 'INTERVIEWING' },
    });
    await controller.webhook(validUpdate(), WEBHOOK_SECRET);
    expect(calls.created).toHaveLength(0);
    expect(calls.answered[0]).toMatch(/interviewing/i);
  });

  it('treats a lost race as success, not an error', async () => {
    // Two taps in flight: the unique (userId, jobId) rejects the second insert.
    // That is the guarantee holding — the user must not see a failure.
    const { controller, calls } = build({
      notification: NOTIFICATION,
      createError: duplicateApplication(),
    });
    await expect(
      controller.webhook(validUpdate(), WEBHOOK_SECRET),
    ).resolves.toEqual({ ok: true });
    expect(calls.answered).toEqual(['Already recorded as applied.']);
  });

  it('says the job is gone when it no longer exists, and records nothing', async () => {
    const { controller, calls } = build({
      notification: NOTIFICATION,
      createError: new NotFoundException('Job not found'),
    });
    await expect(
      controller.webhook(validUpdate(), WEBHOOK_SECRET),
    ).resolves.toEqual({ ok: true });
    expect(calls.created).toHaveLength(0);
    expect(calls.answered).toEqual(['That job is no longer in CareerOS.']);
  });

  it('asks for another tap when the database fails, instead of claiming success', async () => {
    const { controller, calls } = build({
      notification: NOTIFICATION,
      createError: new Error("Can't reach database server at localhost:5434"),
    });
    await expect(
      controller.webhook(validUpdate(), WEBHOOK_SECRET),
    ).resolves.toEqual({ ok: true });
    expect(calls.created).toHaveLength(0);
    expect(calls.answered).toEqual(['Could not record it; please tap again.']);
  });
});

describe('no mutation on anything unauthorized or unrecognised', () => {
  it.each([
    ['a wrong webhook secret', () => validUpdate(), 'wrong-secret-here-padding!!'],
    ['a missing webhook secret', () => validUpdate(), undefined],
    ['an unauthorized sender', () => validUpdate('55555'), WEBHOOK_SECRET],
  ])('writes nothing for %s', async (_label, mk, secret) => {
    const { controller, calls } = build({ notification: NOTIFICATION });
    await expect(controller.webhook(mk(), secret as string | undefined)).resolves.toEqual({
      ok: true,
    });
    expect(calls.created).toHaveLength(0);
    expect(calls.answered).toHaveLength(0);
  });

  it('writes nothing for an unsigned or forged token', async () => {
    const { controller, calls } = build({ notification: NOTIFICATION });
    const forged = {
      callback_query: { id: 'cb', data: `a:${NOTIF}:0000000000`, from: { id: CHAT_ID } },
    };
    await controller.webhook(forged, WEBHOOK_SECRET);
    expect(calls.created).toHaveLength(0);
  });

  it('writes nothing for a plain message or junk body', async () => {
    const { controller, calls } = build({ notification: NOTIFICATION });
    for (const body of [{ message: { text: 'applied' } }, {}, null, 'nonsense']) {
      await expect(controller.webhook(body, WEBHOOK_SECRET)).resolves.toEqual({ ok: true });
    }
    expect(calls.created).toHaveLength(0);
  });

  it('writes nothing when the notification no longer exists', async () => {
    const { controller, calls } = build({ notification: null });
    await controller.webhook(validUpdate(), WEBHOOK_SECRET);
    expect(calls.created).toHaveLength(0);
    expect(calls.answered[0]).toMatch(/expired/i);
  });

  it('writes nothing when the notification carries no jobId', async () => {
    // A daily-brief style notification has no single job to attribute.
    const { controller, calls } = build({ notification: { userId: USER, payload: { text: 'x' } } });
    await controller.webhook(validUpdate(), WEBHOOK_SECRET);
    expect(calls.created).toHaveLength(0);
    expect(calls.answered[0]).toMatch(/could not identify/i);
  });
});

describe('one inbound transport at a time', () => {
  it('acts on nothing while TELEGRAM_INBOUND=polling, even a valid signed callback', async () => {
    const { controller, calls } = build({
      notification: NOTIFICATION,
      inbound: 'polling',
    });
    await expect(
      controller.webhook(validUpdate(), WEBHOOK_SECRET),
    ).resolves.toEqual({ ok: true });
    expect(calls.created).toHaveLength(0);
    expect(calls.answered).toHaveLength(0);
  });
});

describe('always answers 200', () => {
  it('never returns non-2xx, so Telegram does not retry an ignored update', async () => {
    const { controller } = build({ notification: null });
    for (const body of [null, {}, validUpdate('999')]) {
      await expect(controller.webhook(body, 'bad')).resolves.toEqual({ ok: true });
    }
  });
});
