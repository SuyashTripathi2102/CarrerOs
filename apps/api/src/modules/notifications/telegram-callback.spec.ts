import {
  CALLBACK_DATA_MAX_BYTES,
  decodeAppliedToken,
  encodeAppliedToken,
  extractCallback,
  isAuthorizedUpdate,
  planAppliedCallback,
} from './telegram-callback';

/**
 * This is an inbound, JWT-less endpoint that writes to the database, so these
 * tests are mostly about what must NOT happen.
 *
 * The loop it closes was audited on 2026-09-09: 104 of 107 APPLY matches had
 * been notified and `applications` had never held a row, because the Telegram
 * message was a one-way broadcast ending in a raw employer URL. `applied_total
 * = 0` measured the absence of a mechanism, not the user's behaviour.
 */

const SECRET = 'careeros-callback:12345:AAH-bot-token';
const WEBHOOK_SECRET = 'a-long-random-webhook-secret';
const CHAT_ID = '987654321';
const NOTIF = 'cmtu225100df6f5j4uxbfl82l'; // a real cuid shape

const CONFIGURED = { webhookSecret: WEBHOOK_SECRET, chatId: CHAT_ID, callbackSecret: SECRET };

const update = (data: string, fromId: string | number = CHAT_ID) => ({
  callback_query: { id: 'cb-1', data, from: { id: fromId } },
});

describe('the callback token', () => {
  it('round-trips', () => {
    expect(decodeAppliedToken(encodeAppliedToken(NOTIF, SECRET), SECRET)).toBe(NOTIF);
  });

  it('fits inside Telegram’s 64-byte callback_data limit', () => {
    // Exceeding it fails at SEND time, so every notification would lose the
    // button and the loop would quietly reopen.
    const token = encodeAppliedToken(NOTIF, SECRET);
    expect(Buffer.byteLength(token, 'utf8')).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
  });

  it('refuses to build a token that would not fit', () => {
    expect(() => encodeAppliedToken('x'.repeat(80), SECRET)).toThrow(/exceeds/);
  });

  it('rejects a tampered notification id', () => {
    const token = encodeAppliedToken(NOTIF, SECRET);
    const tampered = token.replace(NOTIF, 'cmtOTHERaaaaaaaaaaaaaaaaa');
    expect(decodeAppliedToken(tampered, SECRET)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const foreign = encodeAppliedToken(NOTIF, 'someone-elses-bot-token');
    expect(decodeAppliedToken(foreign, SECRET)).toBeNull();
  });

  it('rejects malformed input without throwing', () => {
    for (const bad of ['', 'a', 'a:b', 'a:b:c:d', 'x:' + NOTIF + ':aaaaaaaaaa', undefined]) {
      expect(decodeAppliedToken(bad as string | undefined, SECRET)).toBeNull();
    }
  });

  it('rejects everything when no secret is configured', () => {
    expect(decodeAppliedToken(encodeAppliedToken(NOTIF, SECRET), '')).toBeNull();
  });
});

describe('isAuthorizedUpdate', () => {
  it('accepts the configured secret and chat', () => {
    expect(isAuthorizedUpdate(WEBHOOK_SECRET, CHAT_ID, CONFIGURED)).toEqual({ ok: true });
  });

  it('rejects a wrong or missing secret header', () => {
    expect(isAuthorizedUpdate('wrong-secret-of-same-len!!!!', CHAT_ID, CONFIGURED).ok).toBe(false);
    expect(isAuthorizedUpdate(undefined, CHAT_ID, CONFIGURED).ok).toBe(false);
  });

  it('rejects a stranger who somehow has the secret', () => {
    // Two independent checks on purpose: the URL can leak, the chat cannot.
    expect(isAuthorizedUpdate(WEBHOOK_SECRET, '111111', CONFIGURED).ok).toBe(false);
  });

  it('rejects everything when the secret is not configured', () => {
    // Fail closed. An unset secret must not mean "allow all".
    expect(isAuthorizedUpdate('anything', CHAT_ID, { chatId: CHAT_ID }).ok).toBe(false);
  });

  it('accepts a numeric chat id from Telegram against a string in config', () => {
    expect(isAuthorizedUpdate(WEBHOOK_SECRET, Number(CHAT_ID), CONFIGURED)).toEqual({ ok: true });
  });
});

describe('extractCallback', () => {
  it('ignores updates that are not callback queries', () => {
    for (const u of [null, undefined, {}, { message: { text: 'hello' } }, 'string', 42]) {
      expect(extractCallback(u)).toBeNull();
    }
  });

  it('ignores a callback query with no data', () => {
    expect(extractCallback({ callback_query: { id: '1', from: { id: CHAT_ID } } })).toBeNull();
  });
});

describe('planAppliedCallback — RECORD is the narrow path', () => {
  it('records a valid, signed, authorized callback', () => {
    const token = encodeAppliedToken(NOTIF, SECRET);
    expect(planAppliedCallback(update(token), { secret: WEBHOOK_SECRET }, CONFIGURED)).toEqual({
      action: 'RECORD',
      notificationId: NOTIF,
    });
  });

  it.each([
    ['a plain message', { message: { text: '/applied' } }, WEBHOOK_SECRET],
    ['an empty update', {}, WEBHOOK_SECRET],
  ])('IGNOREs %s', (_label, u, secret) => {
    expect(planAppliedCallback(u, { secret }, CONFIGURED).action).toBe('IGNORE');
  });

  it('IGNOREs a valid token from an unauthorized sender', () => {
    // The exact attack the chat-id check exists for: correct signature, wrong
    // person. Signing alone would have let this through.
    const token = encodeAppliedToken(NOTIF, SECRET);
    const plan = planAppliedCallback(update(token, '55555'), { secret: WEBHOOK_SECRET }, CONFIGURED);
    expect(plan).toEqual({ action: 'IGNORE', reason: 'sender is not the configured chat' });
  });

  it('IGNOREs a valid token with a bad webhook secret', () => {
    const token = encodeAppliedToken(NOTIF, SECRET);
    expect(planAppliedCallback(update(token), { secret: 'nope' }, CONFIGURED).action).toBe('IGNORE');
  });

  it('IGNOREs an unsigned identifier — the payload is not authority', () => {
    // Someone naming a raw notification id, or a job id, gets nothing.
    for (const raw of [NOTIF, `a:${NOTIF}`, 'a:some-job-uuid:0000000000']) {
      expect(planAppliedCallback(update(raw), { secret: WEBHOOK_SECRET }, CONFIGURED).action).toBe(
        'IGNORE',
      );
    }
  });

  it('IGNOREs when nothing is configured at all', () => {
    const token = encodeAppliedToken(NOTIF, SECRET);
    expect(planAppliedCallback(update(token), { secret: WEBHOOK_SECRET }, {}).action).toBe('IGNORE');
  });
});
