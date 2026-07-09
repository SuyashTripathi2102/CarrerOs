/* eslint-disable no-console */
/**
 * Classify every actionable India job and persist the objective result.
 *
 * Writes only to job_classifications. Nothing reads that table yet, so this
 * changes no recommendation — it is the full dry run before the gate is wired.
 *
 *   node dist/modules/matching/backfill-classifications.js [--limit N]
 */
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { VertexGeminiProvider } from '../ai/vertex-gemini.provider';
import { AiUsageService } from '../ai/ai-usage.service';
import { CLASSIFIER_VERSION, JobClassifierService } from './job-classifier.service';
import {
  DEFAULT_ROLE_PROFILE,
  eligibility,
  type JobClassification,
  type RoleProfile,
} from './role-classification';

const INDIA = `(j.country = 'IN' OR j.location ~* 'india|bengaluru|bangalore|mumbai|pune|delhi|hyderabad|chennai|noida|gurgaon|gurugram|indore|ahmedabad|kolkata')`;
const MAX_AGE_DAYS = 45;

async function main() {
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 1000;

  const prisma = new PrismaClient();
  const config = new ConfigService();
  const usage = new AiUsageService(prisma as never);
  const classifier = new JobClassifierService(new VertexGeminiProvider(config, usage));

  const jobs = await prisma.$queryRawUnsafe<{ id: string; title: string; description: string }[]>(`
    SELECT j.id, j.title, j.description
    FROM jobs j
    WHERE j.status = 'ACTIVE'
      AND now()::date - COALESCE(j."postedAt", j."firstSeenAt")::date <= ${MAX_AGE_DAYS}
      AND ${INDIA}
      AND NOT EXISTS (
        SELECT 1 FROM job_classifications c
        WHERE c."jobId" = j.id AND c."classifierVersion" = ${CLASSIFIER_VERSION}
      )
    ORDER BY COALESCE(j."postedAt", j."firstSeenAt") DESC
    LIMIT ${limit}
  `);

  console.log(`${jobs.length} jobs need classification at version ${CLASSIFIER_VERSION}\n`);
  if (jobs.length === 0) {
    await prisma.$disconnect();
    return;
  }

  const started = new Date();
  const { classified, failedIds } = await classifier.classify(jobs);

  for (const c of classified) {
    await prisma.jobClassification.upsert({
      where: { jobId_classifierVersion: { jobId: c.jobId, classifierVersion: CLASSIFIER_VERSION } },
      create: {
        jobId: c.jobId,
        classifierVersion: CLASSIFIER_VERSION,
        primaryFunction: c.primaryFunction,
        roleFamily: c.roleFamily,
        specializations: c.specialization,
        codingIntensity: c.codingIntensity,
        developmentConfidence: c.developmentConfidence,
        seniority: c.seniority,
        minimumYears: c.minimumYears,
        maximumYears: c.maximumYears,
        requiredSkills: c.requiredSkills,
        preferredSkills: c.preferredSkills,
        responsibilities: c.responsibilities,
        developmentEvidence: c.developmentEvidence,
        nonDevelopmentEvidence: c.nonDevelopmentEvidence,
        classificationReason: c.classificationReason,
      },
      update: {},
    });
  }

  const cost = await prisma.aiUsage.aggregate({
    where: { createdAt: { gte: started }, kind: 'GENERATE' },
    _sum: { costUsd: true, inputTokens: true, outputTokens: true },
    _count: true,
  });

  console.log(`classified=${classified.length}  failed=${failedIds.length}`);
  console.log(
    `vertex: ${cost._count} calls, ${cost._sum.inputTokens ?? 0} in / ${cost._sum.outputTokens ?? 0} out, ` +
      `est $${Number(cost._sum.costUsd ?? 0).toFixed(4)}`,
  );

  // Eligibility is derived per user; the table stores none of it.
  const profile: RoleProfile = { ...DEFAULT_ROLE_PROFILE, yearsExperience: 2 };
  const buckets: Record<string, number> = {};
  const bump = (k: string) => (buckets[k] = (buckets[k] ?? 0) + 1);

  for (const c of classified) {
    const e = eligibility(c as JobClassification, profile);
    if (e.eligible) bump('ELIGIBLE');
    else if (e.needsReview) bump('NEEDS_REVIEW');
    else if (/years|senior|lead|staff|principal/i.test(e.reason)) bump('REJECT_experience');
    else if (/outside your target families/.test(e.reason)) bump('REJECT_specialization');
    else if (/not a primary responsibility|not the core responsibility/.test(e.reason)) bump('REJECT_not_development');
    else bump('REJECT_other');
  }

  console.log('\n--- eligibility for this user (derived, not stored) ---');
  for (const [k, v] of Object.entries(buckets).sort((a, b) => b[1] - a[1])) {
    console.log(`${String(v).padStart(4)}  ${k}`);
  }

  await prisma.$disconnect();
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
