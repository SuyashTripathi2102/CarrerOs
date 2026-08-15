import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizeCompanyName } from '../companies/company-name';
import {
  identityConfidence,
  identityTokenFromUrl,
  shouldAutoMerge,
  type IdentityConfidence,
} from './company-identity';

export interface AliasCandidate {
  key: string;
  canonicalId: string;
  canonicalName: string;
  duplicateId: string;
  duplicateName: string;
  confidence: IdentityConfidence;
  canonicalToken: string | null;
  duplicateToken: string | null;
  jobs: number;
}

export interface ResolveReport {
  groupsExamined: number;
  merged: number;
  escalated: number;
  candidates: AliasCandidate[];
}

/**
 * ADR-11 company identity resolution.
 *
 * Names propose, ATS tenancy confirms, and only STRONG automates. Everything
 * else is reported for review rather than guessed, because over-merging fuses
 * two companies' funding, hiring velocity, contacts and outcomes invisibly and
 * unrecoverably, while under-merging costs a visible duplicate row.
 */
@Injectable()
export class CompanyIdentityService {
  private readonly logger = new Logger(CompanyIdentityService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Derive each company's identity token from the apply URLs of its own jobs.
   *
   * A company's jobs can legitimately span hosts (its own careers page plus an
   * aggregator mirror), so the token is the MOST COMMON non-null token across
   * its jobs. A company whose jobs only ever arrived through aggregators gets
   * null — which means UNKNOWN, never "different company".
   */
  async backfillIdentityTokens(): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ companyId: string; url: string }[]>`
      SELECT "companyId", url FROM jobs
    `;
    const byCompany = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const t = identityTokenFromUrl(r.url);
      if (!t) continue;
      const counts = byCompany.get(r.companyId) ?? new Map<string, number>();
      counts.set(t.token, (counts.get(t.token) ?? 0) + 1);
      byCompany.set(r.companyId, counts);
    }

    let written = 0;
    for (const [companyId, counts] of byCompany) {
      const [token] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      await this.prisma.company.update({ where: { id: companyId }, data: { identityToken: token } });
      written++;
    }
    this.logger.log(`identity tokens: ${written} companies resolved from apply URLs`);
    return written;
  }

  /**
   * Find alias candidates and act only on STRONG evidence.
   *
   * `dryRun` reports without writing — the default, so this can be inspected
   * before it ever merges anything.
   */
  async resolve(dryRun = true): Promise<ResolveReport> {
    const companies = await this.prisma.company.findMany({
      where: { aliasOfId: null },
      select: {
        id: true,
        name: true,
        website: true,
        identityToken: true,
        _count: { select: { jobs: true } },
      },
    });

    // Group by the shared name key: this PROPOSES, it never decides.
    const groups = new Map<string, typeof companies>();
    for (const c of companies) {
      const key = normalizeCompanyName(c.name);
      if (!key) continue;
      const g = groups.get(key) ?? [];
      g.push(c);
      groups.set(key, g);
    }

    const candidates: AliasCandidate[] = [];
    let merged = 0;
    let escalated = 0;
    let groupsExamined = 0;

    for (const [key, members] of groups) {
      if (members.length < 2) continue;
      groupsExamined++;

      // Canonical = most jobs. Keeps the row that already carries the history,
      // so the alias points at the richer record.
      const sorted = [...members].sort((a, b) => b._count.jobs - a._count.jobs);
      const canonical = sorted[0];

      for (const dup of sorted.slice(1)) {
        const confidence = identityConfidence(
          { name: canonical.name, token: canonical.identityToken, domain: canonical.website },
          { name: dup.name, token: dup.identityToken, domain: dup.website },
        );
        candidates.push({
          key,
          canonicalId: canonical.id,
          canonicalName: canonical.name,
          duplicateId: dup.id,
          duplicateName: dup.name,
          confidence,
          canonicalToken: canonical.identityToken,
          duplicateToken: dup.identityToken,
          jobs: dup._count.jobs,
        });

        if (shouldAutoMerge(confidence)) {
          if (!dryRun) {
            await this.prisma.company.update({
              where: { id: dup.id },
              data: { aliasOfId: canonical.id, aliasConfidence: confidence },
            });
          }
          merged++;
        } else {
          escalated++;
        }
      }
    }

    this.logger.log(
      `identity resolve${dryRun ? ' (dry run)' : ''}: ${groupsExamined} groups · ` +
        `${merged} STRONG merge${merged === 1 ? '' : 's'} · ${escalated} escalated to review`,
    );
    return { groupsExamined, merged, escalated, candidates };
  }

  /** Everything awaiting a human identity decision. Read-only audit surface. */
  async pendingReview(): Promise<AliasCandidate[]> {
    const { candidates } = await this.resolve(true);
    return candidates.filter((c) => !shouldAutoMerge(c.confidence));
  }
}
