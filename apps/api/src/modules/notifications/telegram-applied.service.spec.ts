import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  APPLIED_REPLIES,
  isDuplicateApplication,
  TelegramAppliedService,
} from './telegram-applied.service';

const NOTIF = 'cmtu225100df6f5j4uxbfl82l';
const RECORD = { action: 'RECORD', notificationId: NOTIF } as const;

/** A real Prisma P2002, as Prisma reports a unique violation on `target`. */
function p2002(target: unknown): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: Prisma.prismaVersion.client,
    meta: { modelName: 'Application', target },
  });
}

interface Options {
  lookup?: () => Promise<unknown>;
  create?: () => Promise<unknown>;
  answer?: () => Promise<void>;
  /** The application the second read finds (after createFromJob failed); none by default. */
  foundAfterwards?: { id: string; status: string };
}

function build(opts: Options = {}) {
  const calls = { created: 0, answered: [] as string[], reads: 0 };
  const prisma = {
    notification: {
      findUnique:
        opts.lookup ??
        (() =>
          Promise.resolve({ userId: 'user-1', payload: { jobId: 'job-1' } })),
    },
    application: {
      findUnique: () => {
        calls.reads++;
        return Promise.resolve(
          calls.reads > 1 ? (opts.foundAfterwards ?? null) : null,
        );
      },
    },
  };
  const applications = {
    createFromJob: () => {
      calls.created++;
      return opts.create ? opts.create() : Promise.resolve({ id: 'app-1' });
    },
  };
  const telegram = {
    answerCallback: (_id: string, text: string) => {
      calls.answered.push(text);
      return opts.answer ? opts.answer() : Promise.resolve();
    },
  };
  const service = new TelegramAppliedService(
    prisma as never,
    applications as never,
    telegram as never,
  );
  return { service, calls };
}

let logged: { level: string; message: string }[];
beforeEach(() => {
  logged = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    jest
      .spyOn(Logger.prototype, level)
      .mockImplementation((message: unknown) => {
        logged.push({ level, message: String(message) });
      });
  }
});
afterEach(() => jest.restoreAllMocks());

describe('isDuplicateApplication: only the (userId, jobId) unique key is a duplicate', () => {
  // [what Prisma reports, is it a duplicate application, the error]: the title prints the first two.
  it.each<[string, boolean, unknown]>([
    ['P2002 on the fields userId, jobId', true, p2002(['userId', 'jobId'])],
    [
      'P2002 on the fields in the other order',
      true,
      p2002(['jobId', 'userId']),
    ],
    [
      'P2002 on the constraint name',
      true,
      p2002('applications_userId_jobId_key'),
    ],
    ['P2002 on another unique key (email)', false, p2002(['email'])],
    [
      'P2002 on a wider key that merely contains them',
      false,
      p2002(['userId', 'jobId', 'resumeVersionId']),
    ],
    ['P2002 with no target at all', false, p2002(undefined)],
    [
      'another Prisma error (P2003)',
      false,
      new Prisma.PrismaClientKnownRequestError(
        'Foreign key constraint failed',
        {
          code: 'P2003',
          clientVersion: Prisma.prismaVersion.client,
        },
      ),
    ],
    [
      'a plain Error that says "Unique constraint failed"',
      false,
      new Error('Unique constraint failed'),
    ],
  ])('%s → duplicate: %s', (_label, expected, err) => {
    expect(isDuplicateApplication(err)).toBe(expected);
  });
});

describe('TelegramAppliedService: every outcome is told truthfully', () => {
  it('records a tap and says so', async () => {
    const { service, calls } = build();

    await service.act(RECORD, 'cb-1', 'polling');

    expect(calls.created).toBe(1);
    expect(calls.answered).toEqual([APPLIED_REPLIES.recorded]);
  });

  it('a lost race (P2002 on userId, jobId) is "Already recorded as applied."', async () => {
    const { service, calls } = build({
      create: () => Promise.reject(p2002(['userId', 'jobId'])),
    });

    await service.act(RECORD, 'cb-1', 'polling');

    expect(calls.answered).toEqual([APPLIED_REPLIES.alreadyRecorded]);
    expect(logged.filter((l) => l.level === 'error')).toEqual([]);
  });

  it('a P2002 on another key is a failure, not a duplicate', async () => {
    const { service, calls } = build({
      create: () => Promise.reject(p2002(['email'])),
    });

    await service.act(RECORD, 'cb-1', 'polling');

    expect(calls.answered).toEqual([APPLIED_REPLIES.failed]);
    expect(
      logged.some((l) => l.level === 'error' && l.message.includes('P2002')),
    ).toBe(true);
  });

  it('a race lost inside createFromJob ("Already APPLIED") is "Already recorded as applied.", read from the database', async () => {
    const { service, calls } = build({
      create: () => Promise.reject(new BadRequestException('Already APPLIED')),
      foundAfterwards: { id: 'app-1', status: 'APPLIED' },
    });

    await service.act(RECORD, 'cb-1', 'polling');

    expect(calls.reads).toBe(2);
    expect(calls.answered).toEqual([APPLIED_REPLIES.alreadyRecorded]);
  });

  it('a failure after the application landed reports what the database holds, not a failure', async () => {
    const { service, calls } = build({
      create: () => Promise.reject(new Error('connection reset after commit')),
      foundAfterwards: { id: 'app-1', status: 'APPLIED' },
    });

    await service.act(RECORD, 'cb-1', 'polling');

    expect(calls.answered).toEqual([APPLIED_REPLIES.alreadyRecorded]);
    expect(logged.filter((l) => l.level === 'error')).toEqual([]);
  });

  it('a job that no longer exists is "That job is no longer in CareerOS."', async () => {
    const { service, calls } = build({
      create: () => Promise.reject(new NotFoundException('Job not found')),
    });

    await service.act(RECORD, 'cb-1', 'webhook');

    expect(calls.answered).toEqual([APPLIED_REPLIES.jobGone]);
  });

  it('a database failure while writing is "please tap again", logged as an error', async () => {
    const { service, calls } = build({
      create: () =>
        Promise.reject(
          new Error("Can't reach database server at localhost:5434"),
        ),
    });

    await service.act(RECORD, 'cb-1', 'polling');

    expect(calls.answered).toEqual([APPLIED_REPLIES.failed]);
    expect(
      logged.filter((l) => l.level === 'error').map((l) => l.message),
    ).toEqual([
      `telegram tap (polling) for notification ${NOTIF} could not be recorded: Error: Can't reach database server at localhost:5434`,
    ]);
  });

  it('a database failure at the notification lookup is answered too, and act() does not throw (F2)', async () => {
    const { service, calls } = build({
      lookup: () =>
        Promise.reject(
          new Error("Can't reach database server at localhost:5434"),
        ),
    });

    await expect(
      service.act(RECORD, 'cb-1', 'polling'),
    ).resolves.toBeUndefined();

    expect(calls.created).toBe(0);
    expect(calls.answered).toEqual([APPLIED_REPLIES.failed]);
  });

  it('an answer that cannot be sent never turns a recorded tap into a failure', async () => {
    const { service, calls } = build({
      answer: () => Promise.reject(new TypeError('fetch failed')),
    });

    await expect(
      service.act(RECORD, 'cb-1', 'polling'),
    ).resolves.toBeUndefined();

    expect(calls.created).toBe(1);
    expect(calls.answered).toEqual([APPLIED_REPLIES.recorded]);
    expect(
      logged.some((l) => l.message.includes('could not be recorded')),
    ).toBe(false);
    expect(
      logged.some(
        (l) =>
          l.level === 'warn' &&
          l.message.includes('the answer could not be sent'),
      ),
    ).toBe(true);
  });

  it('an IGNORE plan writes nothing and answers nothing', async () => {
    const { service, calls } = build();

    await service.act(
      { action: 'IGNORE', reason: 'sender is not the configured chat' },
      'cb-1',
      'polling',
    );

    expect(calls.created).toBe(0);
    expect(calls.answered).toEqual([]);
  });
});
