import { Injectable, Logger } from '@nestjs/common';
import { AtsProvider } from '@prisma/client';
import { detectAts } from '../companies/ats-detector';
import { PrismaService } from '../../prisma/prisma.service';

export interface AtsConflict {
  companyId: string;
  company: string;
  stored: string;
  storedIdentifier: string | null;
  urlSays: string;
  urlIdentifier: string | null;
  evidenceUrl: string;
  crawlable: boolean;
}

export interface AtsConflictReport {
  companiesExamined: number;
  conflicts: number;
  corrected: number;
  rows: AtsConflict[];
}

/** Providers CareerOS has a working adapter for. Keep in step with the workers' ADAPTERS map. */
const CRAWLABLE = new Set([
  'GREENHOUSE',
  'LEVER',
  'ASHBY',
  'WORKABLE',
  'SMARTRECRUITERS',
  'RECRUITEE',
  'BREEZY',
  'KEKA',
]);

/**
 * Reconcile a company's stored ATS against the evidence in its own job URLs.
 *
 * The discovery prober guesses an ATS by slugging the company name and probing
 * each provider's API, accepting `Array.isArray(payload.jobs)` as proof. That
 * is true for `[]`, and large employers frequently hold an empty account on one
 * ATS while posting on another:
 *
 *     apply.workable.com/api/v1/widget/accounts/zensar   -> 200 {"jobs":[]}
 *     apply.workable.com/api/v1/widget/accounts/nonsense -> 404
 *
 * So the label was not fabricated — Zensar really does have a Workable account.
 * It is simply not where the jobs are. Measured 2026-08-16: 188 of 833
 * companies carry a provider their own apply URLs contradict, 66 of them
 * WORKABLE where the URL says WORKDAY (Barclays, Thermo Fisher, Airbus, Adobe).
 * Those 169 Workable-labelled companies produced 1,172 zero-find crawls out of
 * 1,426 — an 82% failure rate.
 *
 * Correcting the label to a provider CareerOS cannot crawl (Workday) is a WIN,
 * not a loss: it stops the wasted crawl rotation and stops asserting a board
 * that isn't there. It can no longer destroy jobs either way — see
 * crawl-reconciliation.ts.
 *
 * Reuses `detectAts` rather than adding a second detector.
 */
@Injectable()
export class AtsConflictService {
  private readonly logger = new Logger(AtsConflictService.name);

  constructor(private readonly prisma: PrismaService) {}

  async resolve(dryRun = true): Promise<AtsConflictReport> {
    const companies = await this.prisma.company.findMany({
      where: { aliasOfId: null },
      select: { id: true, name: true, atsProvider: true, atsIdentifier: true },
    });

    const rows: AtsConflict[] = [];
    let corrected = 0;

    for (const c of companies) {
      // Most recent job URL — the freshest evidence of where this employer
      // actually posts. One row per company keeps this cheap.
      const job = await this.prisma.job.findFirst({
        where: { companyId: c.id },
        orderBy: { firstSeenAt: 'desc' },
        select: { url: true },
      });
      if (!job?.url) continue;

      const d = detectAts(job.url);
      // UNKNOWN is not evidence of anything — aggregator links resolve here.
      if (d.provider === AtsProvider.UNKNOWN) continue;
      if (d.provider === c.atsProvider) continue;

      rows.push({
        companyId: c.id,
        company: c.name,
        stored: c.atsProvider,
        storedIdentifier: c.atsIdentifier,
        urlSays: d.provider,
        urlIdentifier: d.identifier,
        evidenceUrl: job.url,
        crawlable: CRAWLABLE.has(d.provider),
      });

      if (!dryRun) {
        await this.prisma.company.update({
          where: { id: c.id },
          data: { atsProvider: d.provider, atsIdentifier: d.identifier },
        });
        corrected++;
      }
    }

    this.logger.log(
      `ats conflicts${dryRun ? ' (dry run)' : ''}: ${rows.length} of ${companies.length} companies ` +
        `contradicted by their own apply URLs · corrected ${corrected}`,
    );
    return {
      companiesExamined: companies.length,
      conflicts: rows.length,
      corrected,
      rows,
    };
  }
}
