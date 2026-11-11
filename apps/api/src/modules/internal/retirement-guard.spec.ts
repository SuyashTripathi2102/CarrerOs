import {
  parseRetirementDropGuard,
  resolveRetirementGuard,
} from './retirement-guard';

function logSpy() {
  const lines: { level: 'log' | 'warn' | 'error'; message: string }[] = [];
  return {
    lines,
    log: (message: string) => lines.push({ level: 'log', message }),
    warn: (message: string) => lines.push({ level: 'warn', message }),
    error: (message: string) => lines.push({ level: 'error', message }),
  };
}

describe('parseRetirementDropGuard', () => {
  it('is off when unset, empty or "off"', () => {
    for (const raw of [undefined, '', '  ', 'off', 'OFF', ' Off ']) {
      expect(parseRetirementDropGuard(raw)).toEqual({
        on: false,
        invalid: false,
      });
    }
  });

  it('is on only for "on"', () => {
    for (const raw of ['on', 'ON', ' on ']) {
      expect(parseRetirementDropGuard(raw)).toEqual({
        on: true,
        invalid: false,
      });
    }
  });

  it('reads anything else as off, and flags it', () => {
    for (const raw of ['true', '1', 'yes', 'enabled', 'onn']) {
      expect(parseRetirementDropGuard(raw)).toEqual({
        on: false,
        invalid: true,
      });
    }
  });
});

describe('resolveRetirementGuard (the startup check)', () => {
  const columns = (present: boolean) => async () => present;

  it('switch off, columns present: records, but does not guard', async () => {
    const log = logSpy();
    await expect(
      resolveRetirementGuard('off', columns(true), log),
    ).resolves.toEqual({
      recording: true,
      dropGuard: false,
    });
    expect(log.lines).toEqual([
      {
        level: 'log',
        message: 'retirement guard: recording on, drop guard off',
      },
    ]);
  });

  it('switch on, columns present: records and guards', async () => {
    await expect(
      resolveRetirementGuard('on', columns(true), logSpy()),
    ).resolves.toEqual({
      recording: true,
      dropGuard: true,
    });
  });

  it('switch off, no columns (the schema before A-01): everything off, silently', async () => {
    const log = logSpy();
    await expect(
      resolveRetirementGuard(undefined, columns(false), log),
    ).resolves.toEqual({
      recording: false,
      dropGuard: false,
    });
    expect(log.lines.filter((l) => l.level !== 'log')).toEqual([]);
  });

  it('switch on, no columns: refuses to guard, and says so as an error', async () => {
    const log = logSpy();
    await expect(
      resolveRetirementGuard('on', columns(false), log),
    ).resolves.toEqual({
      recording: false,
      dropGuard: false,
    });
    expect(log.lines.filter((l) => l.level === 'error')).toHaveLength(1);
    expect(log.lines[0].message).toContain('the drop guard stays off');
  });

  it('a failing check turns everything off, and says so as an error', async () => {
    const log = logSpy();
    const failing = async () => {
      throw new Error('connection refused');
    };
    await expect(resolveRetirementGuard('on', failing, log)).resolves.toEqual({
      recording: false,
      dropGuard: false,
    });
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0].level).toBe('error');
    expect(log.lines[0].message).toContain('connection refused');
  });

  it('warns about an unrecognised value without echoing it', async () => {
    const log = logSpy();
    await expect(
      resolveRetirementGuard('enabled', columns(true), log),
    ).resolves.toEqual({
      recording: true,
      dropGuard: false,
    });
    const warning = log.lines.find((l) => l.level === 'warn');
    expect(warning?.message).toContain('treated as off');
    expect(warning?.message).not.toContain('enabled');
  });
});
