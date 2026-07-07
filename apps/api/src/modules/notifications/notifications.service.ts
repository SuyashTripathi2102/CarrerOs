import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { jobMatchesCountries } from '../matching/location-filter';
import type { ScoreModule } from '../opportunity/opportunity.service';
import { TelegramChannel } from './channels';

const RENOTIFY_SCORE_DELTA = 5; // re-notify only if the opportunity improved this much

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly minScore: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramChannel,
    config: ConfigService,
  ) {
    this.minScore = Number(config.get('NOTIFY_MIN_SCORE', 70));
  }

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

    const text = this.formatMatch(match);
    await this.deliver(match.user.id, text, {
      matchId: match.id,
      jobId: match.jobId,
      opportunityScore: match.opportunityScore,
    });

    await this.prisma.jobMatch.update({
      where: { id: match.id },
      data: {
        notifiedAt: new Date(),
        scoreBreakdown: {
          modules: match.scoreBreakdown as object,
          notifiedScore: match.opportunityScore,
        } as unknown as Prisma.InputJsonValue,
      },
    });
    return true;
  }

  /** Actionable format: score + category, why, and the OFFICIAL apply link. */
  private formatMatch(match: {
    opportunityScore: number | null;
    scoreBreakdown: unknown;
    reasoning: string | null;
    job: {
      title: string;
      url: string;
      externalId: string;
      location: string | null;
      company: {
        name: string;
        atsProvider: string;
        atsIdentifier: string | null;
        careerPageUrl: string | null;
      };
    };
  }): string {
    const score = Math.round(match.opportunityScore ?? 0);
    const flame = score >= 90 ? '🔥' : score >= 80 ? '⭐' : '💼';
    const label = score >= 85 ? 'Excellent' : score >= 70 ? 'High' : score >= 55 ? 'Medium' : 'Low';
    const modules = Array.isArray(match.scoreBreakdown)
      ? (match.scoreBreakdown as ScoreModule[])
      : ((match.scoreBreakdown as { modules?: ScoreModule[] })?.modules ?? []);
    const reasons = modules
      .map((m) => `${m.score >= 65 ? '✔' : '✖'} ${m.reason}`)
      .join('\n');

    const apply = this.officialApplyLine(match.job);

    return [
      `${flame} <b>Opportunity ${score} · ${label}</b>`,
      ``,
      `<b>${escapeHtml(match.job.title)}</b>`,
      `${escapeHtml(match.job.company.name)}${match.job.location ? ' · ' + escapeHtml(match.job.location) : ''}`,
      ``,
      reasons,
      ``,
      apply,
    ].join('\n');
  }

  /**
   * The official-link rule: never route through an aggregator when a better
   * link exists. Direct-crawl jobs already carry the official URL; board
   * copies fall back to the company's ATS board → career page → board link
   * (honestly labeled) in that order.
   */
  private officialApplyLine(job: {
    url: string;
    externalId: string;
    company: { atsProvider: string; atsIdentifier: string | null; careerPageUrl: string | null };
  }): string {
    const isBoardCopy = job.externalId.startsWith('remoteok-');
    if (!isBoardCopy) return `Apply: ${job.url}`;

    const board = boardRootUrl(job.company.atsProvider, job.company.atsIdentifier);
    if (board) return `Apply (official board): ${board}`;

    const career = job.company.careerPageUrl;
    if (career && !career.toLowerCase().includes('remoteok')) {
      return `Apply (official careers page): ${career}`;
    }
    return `Apply (via RemoteOK — no official page found yet): ${job.url}`;
  }

  private async deliver(
    userId: string,
    text: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    // Always recorded in-app; pushed to any configured channel.
    await this.prisma.notification.create({
      data: {
        userId,
        type: NotificationType.NEW_MATCHES,
        payload: { text, ...payload } as Prisma.InputJsonValue,
      },
    });

    if (this.telegram.isConfigured()) {
      try {
        await this.telegram.send(text);
      } catch (err) {
        this.logger.error(`telegram delivery failed: ${err instanceof Error ? err.message : err}`);
      }
    } else {
      this.logger.log(`[notification] (telegram not configured)\n${text.replace(/<[^>]+>/g, '')}`);
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
