import { DailyBriefService } from './daily-brief.service';

const LOCAL = 'http://localhost:3000';
const PUBLIC = 'https://careeros.example.com';

function build(opts: { dashboard?: string; sendThrows?: boolean } = {}) {
  const calls = { sends: [] as { buttons?: unknown[][] }[], marked: 0 };
  const prisma = {
    user: { findMany: () => Promise.resolve([{ id: 'user-1' }]) },
    $queryRaw: () =>
      Promise.resolve([
        {
          matchId: 'match-1',
          score: 66,
          title: 'Backend Engineer',
          company: 'Acme',
          jobId: 'job-1',
        },
      ]),
    jobMatch: {
      updateMany: () => {
        calls.marked++;
        return Promise.resolve({ count: 1 });
      },
    },
  };
  const telegram = {
    isConfigured: () => true,
    send: (_text: string, sendOpts: { buttons?: unknown[][] }) => {
      if (opts.sendThrows)
        return Promise.reject(
          new Error('Telegram sendMessage -> 400: rejected'),
        );
      calls.sends.push(sendOpts);
      return Promise.resolve();
    },
  };
  const config = {
    get: (key: string) =>
      ({ CORS_ORIGIN: LOCAL, DASHBOARD_URL: opts.dashboard })[key],
  };
  const service = new DailyBriefService(
    prisma as never,
    telegram as never,
    config as never,
  );
  return { service, calls };
}

describe('CONSIDER digest', () => {
  it('sends with no dashboard button for a localhost dashboard', async () => {
    const { service, calls } = build({ dashboard: LOCAL });

    await expect(service.sendConsiderDigest()).resolves.toEqual({ sent: 1 });

    expect(calls.sends[0].buttons).toBeUndefined();
  });

  it('sends with no dashboard button when none is configured, regardless of CORS_ORIGIN', async () => {
    const { service, calls } = build();

    await service.sendConsiderDigest();

    expect(calls.sends[0].buttons).toBeUndefined();
  });

  it('links to a public dashboard', async () => {
    const { service, calls } = build({ dashboard: PUBLIC });

    await service.sendConsiderDigest();

    expect(calls.sends[0].buttons).toEqual([
      [{ text: '📊 Open Mission Control', url: PUBLIC }],
    ]);
  });

  it('marks jobs notified after a successful send', async () => {
    const { service, calls } = build();

    await service.sendConsiderDigest();

    expect(calls.marked).toBe(1);
  });

  it('marks nothing when the send fails, so tomorrow retries them', async () => {
    const { service, calls } = build({ sendThrows: true });

    await expect(service.sendConsiderDigest()).rejects.toThrow('rejected');

    expect(calls.marked).toBe(0);
  });
});
