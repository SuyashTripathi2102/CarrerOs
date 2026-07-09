/* eslint-disable no-console */
/**
 * SHADOW MODE: what the new eligibility gate would decide, compared with what
 * production currently recommends. Reads only. Changes nothing.
 *
 *   node dist/modules/matching/shadow-report.js
 */
import { PrismaClient } from '@prisma/client';
import { CLASSIFIER_VERSION } from './job-classifier.service';
import {
  DEFAULT_ROLE_PROFILE,
  eligibility,
  experienceVerdict,
  targetFit,
  type JobClassification,
  type RoleProfile,
} from './role-classification';

const PROFILE: RoleProfile = { ...DEFAULT_ROLE_PROFILE, yearsExperience: 2 };
const MIN_SIMILARITY = 0.45; // the reconcile gate we intend to restore

/** Titles that are often genuine engineering despite naming no technology. */
const UNUSUAL_TITLES =
  /\b(sde|software engineer|member of technical staff|product engineer|founding engineer|application (engineer|developer)|platform engineer|solutions engineer|implementation engineer|integration engineer|technology associate|technical consultant)\b/i;

/** Target-stack evidence: a NON_TARGET job containing these deserves a look. */
const TARGET_STACK =
  /\b(node\.?js|express\.?js|react\.?js|javascript|typescript|rest apis?|micro-?services|full[\s-]?stack|mysql|mongodb|postgres)/i;

const prisma = new PrismaClient();

interface Row {
  jobId: string;
  title: string;
  company: string;
  location: string | null;
  url: string;
  ageDays: number;
  description: string;
  opportunityScore: number | null;
  overallScore: number | null;
  similarity: number | null;
  cls: JobClassification;
}

function pad(s: string, n: number) {
  return (s.length > n ? s.slice(0, n - 1) + '…' : s).padEnd(n);
}

function currentVerdict(opp: number | null) {
  return opp == null ? 'UNSCORED' : opp >= 75 ? 'APPLY' : opp >= 60 ? 'CONSIDER' : 'SKIP';
}

function table(t: Record<string, number>) {
  return Object.entries(t)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${String(v).padStart(4)}  ${k}`)
    .join('\n');
}

async function load(): Promise<Row[]> {
  // Similarity is computed against the ACTIVE resume embedding, in SQL, so the
  // MIN_SIMILARITY audit uses the same distance the reconcile query would.
  return prisma.$queryRawUnsafe<Row[]>(`
    WITH active AS (
      SELECT rv.id FROM resume_versions rv
      JOIN resumes r ON r.id = rv."resumeId"
      WHERE r."isPrimary" AND rv."activatedAt" IS NOT NULL
      ORDER BY rv."versionNumber" DESC LIMIT 1
    ), re AS (
      SELECT vector FROM resume_embeddings WHERE "resumeVersionId" = (SELECT id FROM active)
    )
    SELECT j.id AS "jobId", j.title, co.name AS company, j.location, j.url,
           now()::date - COALESCE(j."postedAt", j."firstSeenAt")::date AS "ageDays",
           j.description,
           m."opportunityScore", m."overallScore",
           CASE WHEN je.vector IS NULL THEN NULL
                ELSE 1 - (je.vector <=> (SELECT vector FROM re)) END AS similarity,
           c."primaryFunction", c."roleFamily", c.specializations, c."codingIntensity",
           c."developmentConfidence", c.seniority, c."minimumYears", c."maximumYears",
           c."requiredSkills", c."preferredSkills", c.responsibilities,
           c."developmentEvidence", c."nonDevelopmentEvidence", c."classificationReason"
    FROM job_classifications c
    JOIN jobs j ON j.id = c."jobId"
    JOIN companies co ON co.id = j."companyId"
    LEFT JOIN job_embeddings je ON je."jobId" = j.id
    LEFT JOIN job_matches m ON m."jobId" = j.id AND m."resumeVersionId" = (SELECT id FROM active)
    WHERE c."classifierVersion" = ${CLASSIFIER_VERSION}
  `);
}

async function main() {
  const raw = await load();
  const rows: Row[] = raw.map((r) => ({
    ...r,
    similarity: r.similarity == null ? null : Number(r.similarity),
    cls: {
      ...(r as unknown as JobClassification),
      specialization: (r as unknown as { specializations: string[] }).specializations ?? [],
    },
  }));

  const outcome: Record<string, number> = {};
  const reject: Record<string, number> = {};
  const family: Record<string, number> = {};
  const seniority: Record<string, number> = {};
  const freshness: Record<string, number> = {};

  const targetPool: Row[] = [];
  const needsReview: Row[] = [];
  const roleTargetExpBlocked: Row[] = [];
  const falseNegativeRisk: Row[] = [];
  const unusualTitles: Row[] = [];
  const similarityLoss: Row[] = [];
  const disagreements: string[] = [];
  const newlyEligible: Row[] = [];

  for (const r of rows) {
    const e = eligibility(r.cls, PROFILE);
    const fit = targetFit(r.cls, PROFILE);
    const exp = experienceVerdict(r.cls, PROFILE.yearsExperience);
    const before = currentVerdict(r.opportunityScore);
    const after = e.eligible ? 'ELIGIBLE' : e.needsReview ? 'NEEDS_REVIEW' : 'REJECT';

    outcome[after] = (outcome[after] ?? 0) + 1;
    family[r.cls.roleFamily] = (family[r.cls.roleFamily] ?? 0) + 1;
    seniority[r.cls.seniority] = (seniority[r.cls.seniority] ?? 0) + 1;
    const bucket = r.ageDays <= 7 ? '0-7d' : r.ageDays <= 30 ? '8-30d' : '31-45d';
    freshness[bucket] = (freshness[bucket] ?? 0) + 1;

    if (after === 'REJECT') {
      const why = /outside your target families/.test(e.reason)
        ? 'wrong specialization'
        : /senior role|lead role|staff role|principal role|years/i.test(e.reason)
          ? 'too senior / experience'
          : /not a primary responsibility/.test(e.reason)
            ? 'low coding responsibility'
            : 'not a development role';
      reject[why] = (reject[why] ?? 0) + 1;
    }

    if (e.eligible) targetPool.push(r);
    if (e.needsReview) needsReview.push(r);

    // Role is TARGET/ADJACENT but experience blocks it — report separately, so a
    // Node.js role asking 5-8 years is never mislabelled "non-target".
    if ((fit === 'TARGET' || fit === 'ADJACENT') && !exp.eligible) roleTargetExpBlocked.push(r);

    // Rejected/uncertain jobs whose JD names the target stack.
    if (after !== 'ELIGIBLE' && TARGET_STACK.test(r.description ?? '')) falseNegativeRisk.push(r);

    if (UNUSUAL_TITLES.test(r.title)) unusualTitles.push(r);

    if (e.eligible && r.similarity != null && r.similarity < MIN_SIMILARITY) similarityLoss.push(r);

    if ((before === 'APPLY' || before === 'CONSIDER') && after !== 'ELIGIBLE') {
      disagreements.push(
        `${before.padEnd(8)} ${String(Math.round(r.opportunityScore ?? 0)).padStart(3)} -> ${after.padEnd(12)} | ${pad(r.company, 16)} ${pad(r.title, 40)} | ${e.reason}`,
      );
    }
    if (before !== 'APPLY' && before !== 'CONSIDER' && after === 'ELIGIBLE') newlyEligible.push(r);
  }

  const detail = (r: Row) => {
    const e = eligibility(r.cls, PROFILE);
    const exp = experienceVerdict(r.cls, PROFILE.yearsExperience);
    const c = r.cls;
    console.log(
      `\n${c.roleFamily} · ${c.primaryFunction}\n` +
        `  ${r.company} — ${r.title}\n` +
        `  ${r.location ?? 'location unknown'} · posted ${r.ageDays}d ago\n` +
        `  coding=${c.codingIntensity} confidence=${c.developmentConfidence}% seniority=${c.seniority} ` +
        `years=${c.minimumYears ?? '-'}–${c.maximumYears ?? '-'}\n` +
        `  fit=${targetFit(c, PROFILE)} roleRelevance=${e.roleRelevance}% similarity=${r.similarity?.toFixed(2) ?? 'n/a'}\n` +
        `  experience: ${exp.eligible ? 'ELIGIBLE' : 'INELIGIBLE'}${exp.capsAtConsider ? ' (caps at CONSIDER)' : ''} — ${exp.reason}\n` +
        `  required: ${c.requiredSkills.slice(0, 8).join(', ') || '—'}\n` +
        `  preferred: ${c.preferredSkills.slice(0, 6).join(', ') || '—'}\n` +
        `  evidence: ${c.developmentEvidence.slice(0, 2).join(' | ') || '—'}\n` +
        `  against: ${c.nonDevelopmentEvidence.slice(0, 2).join(' | ') || '—'}\n` +
        `  now: ${currentVerdict(r.opportunityScore)} ${Math.round(r.opportunityScore ?? 0)}/resume ${Math.round(r.overallScore ?? 0)}%  ->  proposed: ${e.eligible ? 'ELIGIBLE FOR SCORING' : e.needsReview ? 'NEEDS REVIEW' : 'REJECT'}\n` +
        `  ${r.url}`,
    );
  };

  const cost = await prisma.aiUsage.aggregate({
    where: { kind: 'GENERATE', createdAt: { gte: new Date(Date.now() - 6 * 3600_000) } },
    _sum: { costUsd: true, inputTokens: true, outputTokens: true },
    _count: true,
  });

  console.log(`=== CLASSIFIED ${rows.length} jobs (classifier v${CLASSIFIER_VERSION}) ===\n`);
  console.log('--- coverage by freshness ---\n' + table(freshness));
  console.log('\n--- outcome under the new gate ---\n' + table(outcome));
  console.log('\n--- why rejected ---\n' + table(reject));
  console.log('\n--- role family distribution ---\n' + table(family));
  console.log('\n--- seniority distribution ---\n' + table(seniority));
  console.log(
    `\n--- vertex usage (last 6h) --- ${cost._count} calls, ` +
      `${cost._sum.inputTokens ?? 0} in / ${cost._sum.outputTokens ?? 0} out, est $${Number(cost._sum.costUsd ?? 0).toFixed(4)}`,
  );

  console.log(`\n\n=== TARGET POOL: every job that would be eligible for scoring (${targetPool.length}) ===`);
  targetPool.sort((a, b) => a.ageDays - b.ageDays).forEach(detail);

  console.log(`\n\n=== NEEDS REVIEW (${needsReview.length}) ===`);
  needsReview.forEach(detail);

  console.log(
    `\n\n=== TARGET/ADJACENT ROLE, BLOCKED ON EXPERIENCE (${roleTargetExpBlocked.length}) ===\n` +
      `(role is right, seniority is not — never reported as "non-target")`,
  );
  roleTargetExpBlocked.forEach((r) =>
    console.log(
      `  ${pad(r.company, 18)} ${pad(r.title, 44)} ${pad(r.cls.roleFamily, 22)} ` +
        `${r.cls.seniority.padEnd(9)} ${r.cls.minimumYears ?? '-'}–${r.cls.maximumYears ?? '-'}y`,
    ),
  );

  console.log(`\n\n=== UNUSUAL SOFTWARE TITLES — classified on the JD, not the name (${unusualTitles.length}) ===`);
  unusualTitles.forEach((r) => {
    const e = eligibility(r.cls, PROFILE);
    console.log(
      `  ${e.eligible ? 'ELIGIBLE' : e.needsReview ? 'REVIEW  ' : 'REJECT  '} ${pad(r.title, 44)} ` +
        `${pad(r.cls.roleFamily, 24)} code=${pad(r.cls.codingIntensity, 12)} conf=${String(r.cls.developmentConfidence).padStart(3)} | ${e.reason}`,
    );
  });

  console.log(
    `\n\n=== FALSE-NEGATIVE RISK: rejected/uncertain but the JD names your stack (${falseNegativeRisk.length}) ===`,
  );
  falseNegativeRisk.slice(0, 40).forEach((r) => {
    const e = eligibility(r.cls, PROFILE);
    const hits = (r.description.match(TARGET_STACK) ?? []).slice(0, 1);
    console.log(
      `  ${pad(r.company, 16)} ${pad(r.title, 42)} ${pad(r.cls.roleFamily, 22)} conf=${String(r.cls.developmentConfidence).padStart(3)} ` +
        `hit=${hits[0] ?? ''} | ${e.reason}`,
    );
  });

  console.log(
    `\n\n=== SIMILARITY LOSS: eligible target jobs below MIN_SIMILARITY=${MIN_SIMILARITY} (${similarityLoss.length}) ===\n` +
      `(these would be dropped if similarity gated the reconcile — inspect before enabling)`,
  );
  similarityLoss.forEach((r) =>
    console.log(`  sim=${r.similarity?.toFixed(3)} ${pad(r.company, 18)} ${pad(r.title, 44)} ${r.cls.roleFamily}`),
  );

  console.log(`\n\n=== DISAGREEMENTS: recommended today, blocked under the gate (${disagreements.length}) ===`);
  disagreements.forEach((d) => console.log('  ' + d));

  console.log(`\n\n=== NEWLY ELIGIBLE: invisible today, passes the gate (${newlyEligible.length}) ===`);
  newlyEligible.forEach(detail);

  await prisma.$disconnect();
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
