import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { jobMatchesCountries, locationTags } from '../matching/location-filter';
import { companyTier, isEvergreen } from '../opportunity/company-tier';
import {
  readScoreModules,
  type ScoreModule,
} from '../opportunity/opportunity.service';
import {
  abandoned,
  afterSend,
  inAppOnly,
  isDue,
  isStale,
  parseDelivery,
  queued,
  RECHECK_DELAY_MS,
  STALE_SENDING_MS,
  startSending,
  withDelivery,
  type DeliveryState,
  type SendOutcome,
} from './alert-delivery';
import { InlineButton, TelegramChannel, TelegramSendError } from './channels';
import { publicDashboardUrl } from './dashboard-url';
import { encodeAppliedToken } from './telegram-callback';

// Telegram caps a message at 4096 characters; the rest of the card needs room.
import { decide, Decision, salaryLine } from './decision';
import { ageLabel, cleanJobUrl, formatAlert, PLACEHOLDER_TITLE } from './telegram-format';

const RENOTIFY_SCORE_DELTA = 5; // re-notify only if the opportunity improved this much

const RETRY_WINDOW_MS = 7 * 86_400_000; // older undelivered alerts are not worth interrupting for
const RETRY_BATCH = 20; // sends per retry pass, oldest due first
const SETTLE_BATCH = 50; // records that need no send (arrived, or a dead send), settled per pass
const RECORD_TRIES = 3; // writing a send's outcome is retried this often before giving up
const MALFORMED_SHOWN = 5; // malformed records named in one retry-pass warning
/** Exactly the form toISOString() writes, so these times compare as text in SQL. */
const ISO_TIME_SQL =
  '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z$';

/** What one delivery call did. */
type Delivery = 'sent' | 'already-sent' | 'held';

type Claim =
  | { kind: 'send'; rowId: string; state: DeliveryState }
  | { kind: 'in-app' }
  | { kind: 'already-sent' }
  | { kind: 'held'; reason: string };

/** The newest row of an alert whose match is still unsent, as the retry pass reads it. */
type OpenAlert = {
  matchId: string;
  rowId: string;
  userId: string;
  payload: unknown;
  createdAt: Date;
  /** Which bounded part of the query returned it. */
  bucket?: 'send' | 'settle' | 'malformed';
  /** On malformed rows: how many malformed records the window holds. */
  malformedTotal?: bigint | number | null;
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly minScore: number;
  private readonly maxAgeDays: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramChannel,
    private readonly config: ConfigService,
  ) {
    this.minScore = Number(config.get('NOTIFY_MIN_SCORE', 70));
    this.maxAgeDays = Number(config.get('NOTIFY_MAX_AGE_DAYS')) || 30;
    this.dashboardUrl = publicDashboardUrl(config.get<string>('DASHBOARD_URL'));
  }

  private readonly dashboardUrl: string | null;

  /**
   * Notification gate + memory (the "don't spam me" contract):
   * - only matches at/above NOTIFY_MIN_SCORE;
   * - never twice for the same match, UNLESS the job's content changed
   *   (salary appeared, title changed) or the opportunity score improved
   *   meaningfully — then exactly once more.
   */
  async maybeNotifyMatch(matchId: string): Promise<boolean> {
    const match = await this.prisma.jobMatch.findUnique({
      where: { id: matchId },
      include: {
        job: {
          include: {
            company: {
              select: {
                name: true,
                atsProvider: true,
                atsIdentifier: true,
                careerPageUrl: true,
              },
            },
          },
        },
        user: { select: { id: true, preference: { select: { countries: true } } } },
      },
    });
    if (!match || match.opportunityScore == null) return false;
    if (match.opportunityScore < this.minScore) return false;

    // Preferred-countries gate (defense in depth — matching also filters, but
    // pre-existing matches and rescore sweeps must respect it too).
    const countries = match.user.preference?.countries ?? [];
    if (!jobMatchesCountries(countries, match.job)) {
      this.logger.log(
        `holding notification for ${match.job.company.name} — outside preferred countries [${countries.join(',')}]`,
      );
      return false;
    }

    // Staleness gate — context-aware: evergreen employers (big tech) and
    // companies observably still hiring get a longer window; everyone else's
    // stale postings stay searchable but never interrupt your phone.
    const tier = companyTier(match.job.company.name);
    const recentJobs14d = await this.prisma.job.count({
      where: {
        companyId: match.job.companyId,
        firstSeenAt: { gte: new Date(Date.now() - 14 * 86_400_000) },
      },
    });
    const evergreen = isEvergreen(tier);
    const activelyHiring = recentJobs14d >= 3;
    const effectiveMaxAge = evergreen || activelyHiring ? this.maxAgeDays * 2 : this.maxAgeDays;

    const ageDays =
      (Date.now() - (match.job.postedAt ?? match.job.firstSeenAt).getTime()) / 86_400_000;
    if (ageDays > effectiveMaxAge) {
      this.logger.log(
        `holding notification for "${match.job.title}" — posted ${Math.round(ageDays)}d ago (max ${effectiveMaxAge}d${evergreen ? ', evergreen' : ''})`,
      );
      return false;
    }

    // A recruiter's placeholder ("Referral - Dummy ID") or a test requisition is not an opening.
    if (PLACEHOLDER_TITLE.test(match.job.title)) {
      this.logger.log(`holding notification for "${match.job.title}" — a placeholder posting`);
      return false;
    }
    // Board copy of a directly-crawled company? Hold — the official posting
    // (with the real apply link + full description) arrives within the
    // company's crawl-tier interval and notifies then. Never send a user to
    // an aggregator when we monitor the source.
    const isBoardCopy = match.job.externalId.startsWith('remoteok-');
    if (isBoardCopy && match.job.company.atsIdentifier) {
      this.logger.log(
        `holding board-copy notification for ${match.job.company.name} — official posting incoming`,
      );
      return false;
    }

    if (match.notifiedAt) {
      const prev = (match.scoreBreakdown as { notifiedScore?: number } | null) ?? {};
      const notifiedScore =
        typeof prev.notifiedScore === 'number' ? prev.notifiedScore : match.opportunityScore;
      const improved = match.opportunityScore >= notifiedScore + RENOTIFY_SCORE_DELTA;
      if (!improved) return false; // memory holds — stay silent
    }

    // Twin-posting hint: same company re-lists the same role (onsite/remote
    // variants). Without this, two identical scores look like a bug
    // (2026-07-08, the Brigit "66 × 2" confusion).
    const titleRoot = match.job.title.split(',')[0].trim();
    const twinCount = await this.prisma.job.count({
      where: {
        companyId: match.job.companyId,
        status: 'ACTIVE',
        title: { startsWith: titleRoot },
      },
    });

    // The decision gate reads the STORED verdict — it does not recompute one.
    // Until 2026-07-10 this path called decide() while the dashboard filtered
    // on opportunityScore, so a marketing role blocked here still appeared
    // under "Apply today". One decision, one source, every consumer.
    //
    // Only APPLY interrupts. NEEDS_REVIEW is visible on the dashboard and
    // never pushed; SKIP stays in-app as audit history.
    if (match.verdict !== 'APPLY') {
      this.logger.log(
        `holding notification for "${match.job.title}" — verdict ${match.verdict ?? 'UNDECIDED'} ` +
          `(${match.verdictCode ?? 'no code'}: ${match.verdictReason?.split('\n')[0] ?? 'no reason recorded'})`,
      );
      return false;
    }

    // Already acted on it? Never tell someone to apply to a job they applied
    // to (2026-07-10). SAVED means "later" and may still be nudged; anything
    // past it means done.
    if (await this.alreadyActedOn(match.user.id, match.jobId)) {
      this.logger.log(`holding notification for "${match.job.title}" — already in your applications`);
      return false;
    }

    const decision: Decision = {
      verdict: 'APPLY',
      code: (match.verdictCode as Decision['code']) ?? 'TARGET_ROLE_ELIGIBLE',
      banner: `🟢 ${Math.round(match.opportunityScore ?? 0)}/100`,
      action: '✅ APPLY',
      reasons: match.verdictReason?.split('\n').filter(Boolean) ?? [],
    };

    const text = this.formatMatch(match, twinCount, decision);
    const delivery = await this.deliver(
      match.id,
      match.user.id,
      match.notifiedAt,
      text,
      {
        matchId: match.id,
        jobId: match.jobId,
        opportunityScore: match.opportunityScore,
      },
      this.buildButtons(match.job),
    );
    if (delivery === 'held') return false;

    // Also reached for 'already-sent': the alert's record says it arrived but
    // notifiedAt was never written, so this repairs the match without a second
    // message. If this write fails, the record still says SENT and the next
    // pass repairs it — it can never cause another send.
    await this.markNotified(match);
    return delivery === 'sent';
  }

  /**
   * Re-attempts alerts whose send did not go through, and settles alerts whose
   * outcome is already known.
   *
   * Driven by the alerts' delivery records, not by unsent matches: an APPLY
   * match held by a gate (countries, staleness, already applied) has no record
   * and never enters this queue. One query reads the newest row of each alert
   * from the last RETRY_WINDOW_MS whose match is still unsent, in three bounded
   * parts, so a pass never reads more than RETRY_BATCH + SETTLE_BATCH +
   * MALFORMED_SHOWN rows however many alerts are open:
   *   - send: QUEUED and due RETRY records, oldest due first, at most
   *     RETRY_BATCH, and none at all while sending is held. A record the pass
   *     picked but did not send (a gate held it, or sending became held
   *     part-way through the pass) is moved RECHECK_DELAY_MS back, behind every
   *     record now due, so the same records cannot fill every pass;
   *   - settle: SENT records (and rows from before the record existed) whose
   *     match was never marked, and SENDING records too old for a live attempt,
   *     oldest first, at most SETTLE_BATCH. Settled with no channel and no gate:
   *     the gates decide whether to send, and these only record what already
   *     happened. Each one settled leaves the query, so the next pass reaches
   *     the next ones;
   *   - malformed: at most MALFORMED_SHOWN, with the total, for one warning.
   *     Never sent, never written, and never in the other two parts.
   * The query casts nothing from a record: times are compared as text, and a
   * record counts as well-formed in SQL only in the exact form this code writes,
   * which parseDelivery() also accepts. The code then reads every row again
   * with parseDelivery(), which has the final word; a row the two judge
   * differently is reported and only ever handled the safe way.
   */
  async retryUndelivered(): Promise<number> {
    // createdAt is a UTC timestamp without a zone; AT TIME ZONE 'UTC' makes the
    // window independent of the session's timezone. Times in the delivery
    // record are ISO strings in UTC, compared as text: they have the same width
    // and layout, so with byte order (COLLATE "C") text order is time order.
    const now = new Date();
    const nowIso = now.toISOString();
    const staleIso = new Date(now.getTime() - STALE_SENDING_MS).toISOString();
    const windowSec = RETRY_WINDOW_MS / 1000;
    const sendable =
      !this.telegram.isConfigured() || this.telegram.heldReason() === null;
    // Built to stay cheap whatever the planner's statistics say. Each alert's
    // match and job are looked up by primary key in a scalar subquery, which
    // Postgres cannot turn into a join: as a join, a freshly loaded database
    // with no statistics yet planned "latest" as the inner side of a nested
    // loop and re-sorted every notification once per match. And only the
    // record is sorted and filtered; full payloads are read by id for the rows
    // returned.
    const rows = await this.prisma.$queryRaw<OpenAlert[]>`
      WITH latest AS (
        SELECT DISTINCT ON (n.payload->>'matchId')
               n.payload->>'matchId' AS "matchId", n.id AS "rowId",
               n.payload->'delivery' AS d,
               to_char(n."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_iso
        FROM notifications n
        WHERE n."createdAt" AT TIME ZONE 'UTC' >= now() - ${windowSec} * interval '1 second'
          AND n.payload->>'matchId' IS NOT NULL
        ORDER BY n.payload->>'matchId', n."createdAt" DESC
      ),
      open AS MATERIALIZED (
        SELECT l.*,
               COALESCE(
                 jsonb_typeof(l.d) = 'object'
                 AND jsonb_typeof(l.d->'status') = 'string'
                 AND l.d->>'status' IN ('QUEUED', 'SENDING', 'SENT', 'RETRY', 'FAILED', 'UNKNOWN')
                 AND jsonb_typeof(l.d->'version') = 'number'
                 AND l.d->>'version' ~ '^[1-9][0-9]{0,14}$'
                 AND jsonb_typeof(l.d->'attempts') = 'number'
                 AND l.d->>'attempts' ~ '^(0|[1-9][0-9]{0,14})$'
                 AND jsonb_typeof(l.d->'updatedAt') = 'string'
                 AND l.d->>'updatedAt' ~ ${ISO_TIME_SQL}
                 AND pg_input_is_valid(l.d->>'updatedAt', 'timestamptz')
                 AND (l.d->'nextAttemptAt' IS NULL
                      OR (jsonb_typeof(l.d->'nextAttemptAt') = 'string'
                          AND l.d->>'nextAttemptAt' ~ ${ISO_TIME_SQL}
                          AND pg_input_is_valid(l.d->>'nextAttemptAt', 'timestamptz')))
                 AND (l.d->'lastError' IS NULL OR jsonb_typeof(l.d->'lastError') = 'string')
                 AND (l.d->'channel' IS NULL
                      OR (jsonb_typeof(l.d->'channel') = 'string'
                          AND l.d->>'channel' IN ('telegram', 'in-app'))),
                 false) AS well_formed
        FROM latest l
        WHERE (SELECT m."notifiedAt" IS NULL AND m.verdict = 'APPLY' AND j.status = 'ACTIVE'
               FROM job_matches m JOIN jobs j ON j.id = m."jobId"
               WHERE m.id = l."matchId")
      ),
      picked AS (
        (SELECT 'send' AS bucket, "rowId", NULL::bigint AS "malformedTotal"
         FROM open
         WHERE ${sendable} AND well_formed AND d->>'status' IN ('QUEUED', 'RETRY')
           AND COALESCE(d->>'nextAttemptAt', created_iso) COLLATE "C" <= ${nowIso}
         ORDER BY COALESCE(d->>'nextAttemptAt', created_iso) COLLATE "C", "matchId"
         LIMIT ${RETRY_BATCH})
        UNION ALL
        (SELECT 'settle', "rowId", NULL
         FROM open
         WHERE d IS NULL
            OR (well_formed AND (d->>'status' = 'SENT'
                                 OR (d->>'status' = 'SENDING'
                                     AND d->>'updatedAt' COLLATE "C" < ${staleIso})))
         ORDER BY created_iso COLLATE "C", "matchId"
         LIMIT ${SETTLE_BATCH})
        UNION ALL
        (SELECT 'malformed', "rowId", count(*) OVER ()
         FROM open
         WHERE d IS NOT NULL AND NOT well_formed
         ORDER BY created_iso COLLATE "C", "matchId"
         LIMIT ${MALFORMED_SHOWN})
      )
      SELECT p.bucket, n.payload->>'matchId' AS "matchId", n.id AS "rowId",
             n."userId" AS "userId", n.payload, n."createdAt" AS "createdAt",
             p."malformedTotal"
      FROM picked p
      JOIN notifications n ON n.id = p."rowId"`;

    const bookkeeping: OpenAlert[] = [];
    const sends: { alert: OpenAlert; state: DeliveryState; dueAt: number }[] =
      [];
    const malformed: string[] = [];
    let malformedTotal = 0;
    for (const alert of rows) {
      const read = parseDelivery(alert.payload);
      const bucket: OpenAlert['bucket'] = !read.ok
        ? 'malformed'
        : read.state.status === 'SENT' || isStale(read.state, now)
          ? 'settle'
          : sendable && isDue(read.state, now)
            ? 'send'
            : undefined;
      if (alert.bucket && alert.bucket !== bucket)
        this.logger.error(
          `alert retry: notification ${alert.rowId} (match ${alert.matchId}) was read as ` +
            `${alert.bucket} by the query and as ${bucket ?? 'nothing to do'} by parseDelivery; handled as the latter`,
        );
      if (!read.ok) {
        malformed.push(
          `notification ${alert.rowId} (match ${alert.matchId}): ${read.problem}`,
        );
        malformedTotal = Math.max(
          malformedTotal,
          Number(alert.malformedTotal ?? 0),
        );
      } else if (bucket === 'settle') {
        bookkeeping.push(alert);
      } else if (bucket === 'send') {
        sends.push({
          alert,
          state: read.state,
          dueAt: read.state.nextAttemptAt
            ? Date.parse(read.state.nextAttemptAt)
            : alert.createdAt.getTime(),
        });
      }
    }
    if (malformed.length > 0)
      this.logger.warn(
        `alert retry: ${Math.max(malformedTotal, malformed.length)} malformed delivery record(s), held and never sent: ` +
          malformed.slice(0, MALFORMED_SHOWN).join('; ') +
          (malformedTotal > MALFORMED_SHOWN ? '; …' : ''),
      );

    for (const alert of bookkeeping.slice(0, SETTLE_BATCH)) {
      try {
        await this.settle(alert);
      } catch (err) {
        this.logger.error(
          `alert settle for ${alert.matchId}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    sends.sort(
      (a, b) =>
        a.dueAt - b.dueAt || a.alert.matchId.localeCompare(b.alert.matchId),
    );
    const batch = sends.slice(0, RETRY_BATCH);
    let resent = 0;
    let deferred = 0;
    for (const { alert, state } of batch) {
      let sent = false;
      try {
        sent = await this.maybeNotifyMatch(alert.matchId);
      } catch (err) {
        this.logger.error(
          `alert retry for ${alert.matchId}: ${err instanceof Error ? err.message : err}`,
        );
      }
      if (sent) resent++;
      else if (await this.deferIfUnchanged(alert, state)) deferred++;
    }
    if (batch.length > 0)
      this.logger.log(
        `alert retry: delivered ${resent} of ${batch.length} due` +
          (deferred > 0
            ? `; ${deferred} not sent now, looked at again in ${RECHECK_DELAY_MS / 60_000} min`
            : ''),
      );
    return resent;
  }

  /**
   * Settles a record whose outcome is already known, with no channel and no
   * gate: one that says the alert arrived marks the match notified, and a
   * SENDING record no live attempt could still own becomes UNKNOWN (never
   * re-sent). Under the same per-alert lock as claim(); the write is a
   * compare-and-set on the version read, because record() does not take that
   * lock: if the send's own outcome lands in between, it is kept, and the next
   * pass settles what it says. A record that changed into anything else since
   * the pass read it is left alone.
   */
  private async settle(alert: OpenAlert): Promise<void> {
    const arrived = await this.prisma.$transaction(async (tx) => {
      await this.lockAlert(tx, alert.matchId);
      const row = await tx.notification.findUnique({
        where: { id: alert.rowId },
        select: { payload: true },
      });
      const read = row ? parseDelivery(row.payload) : null;
      if (!row || !read || !read.ok) return false;
      if (read.state.status === 'SENT') return true;
      const now = new Date();
      if (isStale(read.state, now)) {
        const written = await this.writeIfVersion(
          tx,
          alert.rowId,
          read.state.version,
          withDelivery(row.payload, abandoned(read.state, now)),
        );
        if (written)
          this.logger.warn(
            `alert for match ${alert.matchId}: an interrupted send was found; marked UNKNOWN, not re-sent`,
          );
        else
          this.logger.log(
            `alert for match ${alert.matchId}: the interrupted send recorded its outcome meanwhile; that outcome is kept`,
          );
      }
      return false;
    });
    if (!arrived) return;
    const match = await this.prisma.jobMatch.findUnique({
      where: { id: alert.matchId },
      select: {
        id: true,
        notifiedAt: true,
        opportunityScore: true,
        scoreBreakdown: true,
      },
    });
    if (match && !match.notifiedAt) await this.markNotified(match);
  }

  /**
   * Moves a record this pass picked, and left exactly as it found it, behind
   * every record now due. Compare-and-set on the whole record: if anything
   * wrote it meanwhile (this pass's own send, another pass), nothing changes.
   * Never throws: a record that could not be moved is only picked again.
   */
  private async deferIfUnchanged(
    alert: OpenAlert,
    state: DeliveryState,
  ): Promise<boolean> {
    const selected = (alert.payload as { delivery: unknown }).delivery;
    const now = new Date();
    const patch = {
      version: state.version + 1,
      updatedAt: now.toISOString(),
      nextAttemptAt: new Date(now.getTime() + RECHECK_DELAY_MS).toISOString(),
    };
    try {
      const changed = await this.prisma.$executeRaw`
        UPDATE notifications
        SET payload = jsonb_set(payload, '{delivery}', (payload->'delivery') || ${JSON.stringify(patch)}::jsonb)
        WHERE id = ${alert.rowId} AND payload->'delivery' = ${JSON.stringify(selected)}::jsonb`;
      return changed === 1;
    } catch (err) {
      this.logger.error(
        `alert for match ${alert.matchId}: its next look could not be moved back (${err instanceof Error ? err.message : err})`,
      );
      return false;
    }
  }

  /**
   * Marks a match notified once its alert arrived. Wraps the NORMALIZED
   * modules, never the raw column: on a re-notify the column is already an
   * envelope, and wrapping it again would bury the modules a level deeper on
   * every send.
   */
  private async markNotified(match: {
    id: string;
    opportunityScore: number | null;
    scoreBreakdown: unknown;
  }): Promise<void> {
    await this.prisma.jobMatch.update({
      where: { id: match.id },
      data: {
        notifiedAt: new Date(),
        scoreBreakdown: {
          modules: readScoreModules(match.scoreBreakdown),
          notifiedScore: match.opportunityScore,
        } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Writes `payload` over the row only if its delivery record is still at
   * `version`: every write to an existing record goes through here or through
   * record(), which checks the same way. Every write bumps the version, so a
   * writer can never overwrite a record that changed after it read it.
   */
  private async writeIfVersion(
    db: Prisma.TransactionClient,
    rowId: string,
    version: number,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    const { count } = await db.notification.updateMany({
      where: {
        id: rowId,
        payload: { path: ['delivery', 'version'], equals: version },
      },
      data: { payload: payload as Prisma.InputJsonValue },
    });
    return count === 1;
  }

  /** The per-alert lock claim() and settle() hold for the rest of their transaction. */
  private lockAlert(tx: Prisma.TransactionClient, matchId: string) {
    return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`careeros-alert:${matchId}`}, 0))`;
  }

  /**
   * Has the user already acted on this job? SAVED is a bookmark, not an action,
   * so it does not suppress a nudge — every later status does.
   */
  private async alreadyActedOn(userId: string, jobId: string): Promise<boolean> {
    const application = await this.prisma.application.findUnique({
      where: { userId_jobId: { userId, jobId } },
      select: { status: true },
    });
    return application != null && application.status !== 'SAVED';
  }

  /**
   * Decision-first format, v2 (23 Nov 2026; layout in telegram-format.ts): the decision and one
   * score, the title as the apply link, one line of facts, only the reasons specific to this job,
   * and a short analysis. The full analysis stays on the dashboard.
   */
  private formatMatch(
    match: {
      opportunityScore: number | null;
      overallScore: number;
      missingSkills: string[];
      scoreBreakdown: unknown;
      reasoning: string | null;
      job: {
        title: string;
        url: string;
        externalId: string;
        location: string | null;
        workMode: string | null;
        postedAt: Date | null;
        firstSeenAt: Date;
        salaryMin: number | null;
        salaryMax: number | null;
        currency: string | null;
        company: {
          name: string;
          atsProvider: string;
          atsIdentifier: string | null;
          careerPageUrl: string | null;
        };
      };
    },
    twinCount = 1,
    decision: Decision,
  ): string {
    const { job } = match;
    const listed = job.salaryMin != null || job.salaryMax != null;
    return formatAlert({
      action: decision.action,
      fitPct: match.overallScore,
      title: job.title,
      applyUrl: this.applyUrlFor(job),
      company: job.company.name,
      place: locationTags(job.location, job.workMode) || null,
      age: `posted ${ageLabel(job.postedAt, job.firstSeenAt)}`,
      salary: listed
        ? salaryLine(job.salaryMin, job.salaryMax, job.currency).replace(/^💰\s*/u, '')
        : null,
      reasons: decision.reasons,
      missingSkills: match.missingSkills,
      analysis: match.reasoning,
      twinCount,
    });
  }

  /**
   * The official-link rule: never route through an aggregator when a better link exists. A
   * direct-crawl job already carries the official URL; a board copy falls back to the company's
   * ATS board, then its career page, then the board's own link. The title link, the Apply button
   * and the "Apply via" line all use this one URL.
   */
  private applyUrlFor(job: {
    url: string;
    externalId: string;
    company: { atsProvider: string; atsIdentifier: string | null; careerPageUrl: string | null };
  }): string {
    if (!job.externalId.startsWith('remoteok-')) return job.url;
    const career = job.company.careerPageUrl;
    return (
      boardRootUrl(job.company.atsProvider, job.company.atsIdentifier) ??
      (career && !career.toLowerCase().includes('remoteok') ? career : null) ??
      job.url
    );
  }

  /** URL buttons (callback buttons need bot polling — Phase D-4). */
  private buildButtons(job: {
    id: string;
    url: string;
    externalId: string;
    company: { atsProvider: string; atsIdentifier: string | null; careerPageUrl: string | null };
  }) {
    const applyUrl = cleanJobUrl(this.applyUrlFor(job));

    const rows = [[{ text: '🚀 Apply', url: applyUrl }]];
    // "Read more": full description + why + track-application, on the dashboard.
    if (this.dashboardUrl) {
      rows[0].push({ text: '📄 Details', url: `${this.dashboardUrl}/jobs/${job.id}` });
    }
    // "All openings" MUST point at the ATS board we actually crawl — not the
    // company's branded careers page, which shows different/cached jobs and
    // makes the notified job look "missing" (2026-07-09, AbhiBus report).
    const boardUrl =
      boardRootUrl(job.company.atsProvider, job.company.atsIdentifier) ??
      job.company.careerPageUrl;
    if (boardUrl && boardUrl !== applyUrl) {
      rows.push([{ text: '🏢 All openings', url: boardUrl }]);
    }
    return rows;
  }

  private async deliver(
    matchId: string,
    userId: string,
    notifiedAt: Date | null,
    text: string,
    payload: Record<string, unknown>,
    buttons?: InlineButton[][],
  ): Promise<Delivery> {
    const claim = await this.claim(matchId, userId, notifiedAt, {
      text,
      ...payload,
    });
    if (claim.kind === 'in-app') {
      this.logger.log(
        `[notification] (telegram not configured)\n${text.replace(/<[^>]+>/g, '')}`,
      );
      return 'sent';
    }
    if (claim.kind === 'already-sent') return 'already-sent';
    if (claim.kind === 'held') {
      this.logger.log(
        `alert for match ${matchId} not sent now: ${claim.reason}`,
      );
      return 'held';
    }

    const withApplied = this.appendAppliedButton(buttons, claim.rowId, payload);
    let outcome: SendOutcome;
    try {
      await this.telegram.send(text, { buttons: withApplied });
      outcome = { ok: true };
    } catch (err) {
      outcome =
        err instanceof TelegramSendError
          ? {
              ok: false,
              failure: err.failure,
              error: err.message,
              retryAfterSec: err.retryAfterSec,
            }
          : {
              ok: false,
              failure: 'ambiguous',
              error: err instanceof Error ? err.message : String(err),
            };
    }

    const next = afterSend(claim.state, outcome, new Date());
    await this.record(claim.rowId, claim.state.version, next);
    if (!outcome.ok) {
      const when =
        next.status === 'RETRY' ? `; next try after ${next.nextAttemptAt}` : '';
      this.logger.error(
        `telegram delivery for match ${matchId}: ${outcome.error} -> ${next.status}${when}`,
      );
    }
    return outcome.ok ? 'sent' : 'held';
  }

  /**
   * Decides, for one alert, whether a send may start now, and if so marks it
   * SENDING before returning. Runs in a transaction holding a per-alert advisory
   * lock: two retry passes, or a pass and a rescore, take turns here, and the
   * second one finds the first one's SENDING record instead of sending again.
   *
   * The alert's row is the newest one for this match created after notifiedAt
   * (a re-notify on a higher score is a new alert with a new row).
   */
  private claim(
    matchId: string,
    userId: string,
    notifiedAt: Date | null,
    content: Record<string, unknown>,
  ): Promise<Claim> {
    const inAppOnlyChannel = !this.telegram.isConfigured();
    const held = inAppOnlyChannel ? null : this.telegram.heldReason();

    return this.prisma.$transaction(async (tx) => {
      await this.lockAlert(tx, matchId);
      const row = await tx.notification.findFirst({
        where: {
          userId,
          payload: { path: ['matchId'], equals: matchId },
          ...(notifiedAt ? { createdAt: { gt: notifiedAt } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, payload: true },
      });
      const now = new Date();
      const read = row ? parseDelivery(row.payload) : null;
      if (row && read && !read.ok) {
        // Fail closed: the row may describe an alert that arrived.
        this.logger.warn(
          `alert for match ${matchId}: the delivery record on notification ${row.id} is malformed ` +
            `(${read.problem}); held, never sent automatically and never overwritten`,
        );
        return { kind: 'held', reason: 'its delivery record is malformed' };
      }
      const state = read?.ok ? read.state : null;

      // A new row is created; an existing one is written only if its record is
      // still the version read here. The lock keeps other claims out, but
      // record() and the retry pass's move-back do not take it.
      const save = async (next: DeliveryState): Promise<string | null> => {
        if (!row)
          return (
            await tx.notification.create({
              data: {
                userId,
                type: NotificationType.NEW_MATCHES,
                payload: withDelivery(content, next) as Prisma.InputJsonValue,
              },
              select: { id: true },
            })
          ).id;
        const written = await this.writeIfVersion(
          tx,
          row.id,
          state?.version ?? 0,
          withDelivery({ ...(row.payload as object), ...content }, next),
        );
        return written ? row.id : null;
      };
      const changed = {
        kind: 'held',
        reason:
          'its delivery record changed while it was read; it is looked at again later',
      } as const;

      if (state) {
        if (state.status === 'SENT') return { kind: 'already-sent' };
        if (state.status === 'FAILED')
          return {
            kind: 'held',
            reason: `undeliverable (${state.lastError ?? 'refused'})`,
          };
        if (state.status === 'UNKNOWN')
          return {
            kind: 'held',
            reason: 'an earlier send may have arrived; not re-sent',
          };
        if (state.status === 'SENDING') {
          if (!isStale(state, now))
            return { kind: 'held', reason: 'a send is in flight' };
          if (!(await save(abandoned(state, now))))
            return {
              kind: 'held',
              reason:
                'the interrupted send recorded its outcome meanwhile; that outcome is kept',
            };
          this.logger.warn(
            `alert for match ${matchId}: an interrupted send was found; marked UNKNOWN, not re-sent`,
          );
          return {
            kind: 'held',
            reason: 'an interrupted send may have arrived; not re-sent',
          };
        }
        if (!isDue(state, now))
          return {
            kind: 'held',
            reason: `retry not due before ${state.nextAttemptAt}`,
          };
      }

      if (inAppOnlyChannel) {
        if (!(await save(inAppOnly(state, now)))) return changed;
        return { kind: 'in-app' };
      }
      if (held) {
        if (!row) await save(queued(now));
        return { kind: 'held', reason: held };
      }

      const sending = startSending(state, now);
      const rowId = await save(sending);
      if (!rowId) return changed;
      return { kind: 'send', rowId, state: sending };
    });
  }

  /**
   * Writes a send's outcome, but only over the SENDING record that send claimed:
   * the version must still match. The one exception is SENT over UNKNOWN, which
   * is only ever more accurate (the laptop slept mid-send and a pass gave up on
   * the attempt). Never throws. If the outcome cannot be written, the record
   * stays SENDING, is later resolved to UNKNOWN, and is not re-sent.
   */
  private async record(
    rowId: string,
    claimedVersion: number,
    next: DeliveryState,
  ): Promise<void> {
    for (let attempt = 1; attempt <= RECORD_TRIES; attempt++) {
      try {
        const row = await this.prisma.notification.findUnique({
          where: { id: rowId },
          select: { payload: true },
        });
        const read = row ? parseDelivery(row.payload) : null;
        const current = read?.ok ? read.state : null;
        const ours =
          current &&
          (current.version === claimedVersion ||
            (next.status === 'SENT' && current.status === 'UNKNOWN'));
        if (!row || !current || !ours) {
          this.logger.warn(
            `delivery record ${rowId} changed under a send` +
              (read && !read.ok ? ` and is malformed (${read.problem})` : '') +
              `; its outcome ${next.status} is not written`,
          );
          return;
        }
        const { count } = await this.prisma.notification.updateMany({
          where: {
            id: rowId,
            payload: { path: ['delivery', 'version'], equals: current.version },
          },
          data: {
            payload: withDelivery(row.payload, {
              ...next,
              version: current.version + 1,
            }) as Prisma.InputJsonValue,
          },
        });
        if (count === 1) return;
        // The record moved between the read and the write: read it again.
      } catch (err) {
        if (attempt === RECORD_TRIES) {
          this.logger.error(
            `delivery record ${rowId}: outcome ${next.status} not written (${err instanceof Error ? err.message : err}); ` +
              'it stays SENDING and will be marked UNKNOWN, so it is not re-sent',
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      }
    }
  }

  /**
   * Adds "✓ Applied" to a job notification — the only inbound signal CareerOS
   * has.
   *
   * Audited 2026-09-09: 104 of 107 APPLY matches were notified and `applications`
   * had never held a row, because the message was a one-way broadcast ending in
   * a raw employer URL. `applied_total = 0` measured the absence of a mechanism,
   * not the user's behaviour.
   *
   * Returns the buttons unchanged when there is no job to attribute or no
   * callback secret configured — a message without the button is the previous
   * behaviour, which is a fine fallback. Never throws: a formatting problem
   * here must not cost the user the notification itself.
   */
  private appendAppliedButton(
    buttons: InlineButton[][] | undefined,
    notificationId: string,
    payload: Record<string, unknown>,
  ): InlineButton[][] | undefined {
    const jobId = typeof payload.jobId === 'string' ? payload.jobId : null;
    const secret = this.callbackSecret();
    if (!jobId || !secret) return buttons;
    try {
      return [
        ...(buttons ?? []),
        [{ text: '✓ Applied', callback_data: encodeAppliedToken(notificationId, secret) }],
      ];
    } catch (err) {
      this.logger.warn(`applied button skipped: ${err instanceof Error ? err.message : err}`);
      return buttons;
    }
  }

  /**
   * Derived from the bot token rather than configured separately: the signature
   * only has to be unforgeable by outsiders, and requiring a new env var would
   * mean the button silently never appears on an otherwise working install.
   */
  private callbackSecret(): string | null {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    return token ? `careeros-callback:${token}` : null;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Cut long reasoning at the last complete sentence inside `max`. Falls back to
 * a word boundary only when the text has no sentence break at all — never
 * mid-word, and never mid-sentence.
 */
export function truncateAtSentence(
  s: string,
  max: number,
): { text: string; truncated: boolean } {
  const trimmed = s.trim();
  if (trimmed.length <= max) return { text: trimmed, truncated: false };

  const slice = trimmed.slice(0, max);
  // Refuse any boundary so early it would throw away most of the explanation —
  // a four-character "Ok.…" is not a summary.
  const floor = max * 0.4;

  const sentence = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('.\n'),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('? '),
  );
  if (sentence > floor) return { text: slice.slice(0, sentence + 1), truncated: true };

  const word = slice.lastIndexOf(' ');
  if (word > floor) return { text: `${slice.slice(0, word).trimEnd()}…`, truncated: true };

  // A single unbroken run of text: cut it and say so.
  return { text: `${slice.slice(0, max - 1).trimEnd()}…`, truncated: true };
}

/** Public board roots per ATS — official landing pages for a company's jobs. */
function boardRootUrl(provider: string, identifier: string | null): string | null {
  if (!identifier) return null;
  switch (provider) {
    case 'GREENHOUSE':
      return `https://boards.greenhouse.io/${identifier}`;
    case 'LEVER':
      return `https://jobs.lever.co/${identifier}`;
    case 'ASHBY':
      return `https://jobs.ashbyhq.com/${identifier}`;
    case 'WORKABLE':
      return `https://apply.workable.com/${identifier}`;
    case 'SMARTRECRUITERS':
      return `https://jobs.smartrecruiters.com/${identifier}`;
    case 'RECRUITEE':
      return `https://${identifier}.recruitee.com`;
    case 'BREEZY':
      return `https://${identifier}.breezy.hr`;
    default:
      return null;
  }
}
