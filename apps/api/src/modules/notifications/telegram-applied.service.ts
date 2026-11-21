import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ApplicationStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ApplicationsService } from '../applications/applications.service';
import { TelegramChannel } from './channels';
import type { AppliedOutcome } from './telegram-callback';

/** What the user is told; each one says exactly what happened to the tap. */
export const APPLIED_REPLIES = {
  recorded: '✅ Recorded as applied.',
  alreadyRecorded: 'Already recorded as applied.',
  jobGone: 'That job is no longer in CareerOS.',
  failed: 'Could not record it; please tap again.',
} as const;

/**
 * True only for a lost race on the one application per (user, job): Prisma's P2002 on the
 * `applications (userId, jobId)` unique key. Every other error, including a P2002 on another
 * key, is a real failure.
 */
export function isDuplicateApplication(err: unknown): boolean {
  if (
    !(err instanceof Prisma.PrismaClientKnownRequestError) ||
    err.code !== 'P2002'
  )
    return false;
  const target = (err.meta as { target?: unknown } | undefined)?.target;
  if (Array.isArray(target)) {
    const fields = target.map(String);
    return (
      fields.length === 2 &&
      fields.includes('userId') &&
      fields.includes('jobId')
    );
  }
  return (
    typeof target === 'string' && target === 'applications_userId_jobId_key'
  );
}

/** Error name, Prisma code and the first line of the message: enough to act on, nothing more. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err).slice(0, 200);
  const code = (err as { code?: unknown }).code;
  const first = err.message.split('\n').find((line) => line.trim()) ?? '';
  return `${err.name}${typeof code === 'string' ? ` ${code}` : ''}: ${first.trim().slice(0, 200)}`;
}

/**
 * Turns a "✓ Applied" tap into an application, whichever transport delivered
 * it. The webhook and the poller both decide first (planAppliedCallback /
 * planPolledCallback) and then hand the plan here, so there is one writer.
 */
@Injectable()
export class TelegramAppliedService {
  private readonly logger = new Logger(TelegramAppliedService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly applications: ApplicationsService,
    private readonly telegram: TelegramChannel,
  ) {}

  /**
   * Records the tap, then answers it. The two steps fail separately: a tap that could not be
   * recorded is answered "please tap again", and an answer that could not be sent never turns a
   * recorded tap into a failure. Neither throws, so the caller's offset policy is unaffected.
   */
  async act(
    plan: AppliedOutcome,
    callbackId: string,
    via: 'webhook' | 'polling',
  ): Promise<void> {
    if (plan.action === 'IGNORE') {
      // Logged, never actioned. A rejected update that writes nothing is the
      // whole point of this branch.
      this.logger.warn(`telegram callback ignored (${via}): ${plan.reason}`);
      return;
    }

    let message: string;
    try {
      message = await this.recordApplied(plan.notificationId);
    } catch (err) {
      this.logger.error(
        `telegram tap (${via}) for notification ${plan.notificationId} could not be recorded: ${describeError(err)}`,
      );
      message = APPLIED_REPLIES.failed;
    }

    try {
      await this.telegram.answerCallback(callbackId, message);
    } catch (err) {
      this.logger.warn(
        `telegram tap (${via}) for notification ${plan.notificationId}: the answer could not be sent: ${describeError(err)}`,
      );
    }
  }

  /**
   * Resolve the notification, then record the application through the EXISTING
   * path — ApplicationsService.createFromJob already writes the application, its
   * status event, the resume version that applied, and the APPLIED analytics
   * event. Duplicating any of that here would create a second source of truth
   * for the outcome data this loop exists to collect.
   *
   * IDEMPOTENT. Telegram retries on timeout and a user can tap twice, so the
   * second call must be a no-op rather than an error or a duplicate row.
   *
   * Throws on a real failure (the database, anything unexpected); act() answers that one.
   */
  private async recordApplied(notificationId: string): Promise<string> {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      select: { userId: true, payload: true },
    });
    if (!notification) {
      this.logger.warn(
        `telegram callback: notification ${notificationId} not found`,
      );
      return 'That notification has expired.';
    }

    const payload = notification.payload as { jobId?: unknown } | null;
    const jobId = typeof payload?.jobId === 'string' ? payload.jobId : null;
    if (!jobId) {
      this.logger.warn(
        `telegram callback: notification ${notificationId} carries no jobId`,
      );
      return 'Could not identify the job.';
    }

    // The click means "I applied to the job you showed me", so the verdict is
    // not re-checked here — it was APPLY when we sent it, and a later
    // re-decision must not make an application the user really made
    // unrecordable. What IS checked is that the job was actually surfaced to
    // this user, which the notification row establishes.
    const existing = await this.trackedReply(notification.userId, jobId);
    if (existing) return existing;

    try {
      await this.applications.createFromJob(notification.userId, jobId, {
        status: ApplicationStatus.APPLIED,
        source: 'telegram',
      });
      return APPLIED_REPLIES.recorded;
    } catch (err) {
      // Two taps in flight: the unique (userId, jobId) rejects the second insert.
      // That is the idempotency guarantee holding, not a failure.
      if (isDuplicateApplication(err)) return APPLIED_REPLIES.alreadyRecorded;
      if (err instanceof NotFoundException) {
        this.logger.warn(`telegram callback: job ${jobId} no longer exists`);
        return APPLIED_REPLIES.jobGone;
      }
      // The other tap can also win between the check above and createFromJob's own, which then
      // refuses "Already APPLIED"; or the write can land before a later step fails. What the
      // database now holds decides: only when no application exists is this a failure.
      const now = await this.trackedReply(notification.userId, jobId);
      if (now) return now;
      throw err;
    }
  }

  /** The reply for an application that already exists for (user, job), or null when there is none. */
  private async trackedReply(
    userId: string,
    jobId: string,
  ): Promise<string | null> {
    const existing = await this.prisma.application.findUnique({
      where: { userId_jobId: { userId, jobId } },
      select: { id: true, status: true },
    });
    if (!existing) return null;
    return existing.status === ApplicationStatus.APPLIED
      ? APPLIED_REPLIES.alreadyRecorded
      : `Already tracked (${existing.status.toLowerCase()}).`;
  }
}
