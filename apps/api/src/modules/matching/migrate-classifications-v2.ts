/* eslint-disable no-console */
/**
 * Classifier v1 -> v2 without re-spending on 377 jobs.
 *
 * v2 changes exactly two things:
 *   - DATA_ENGINEERING exists as a role family (v1 normalised it to AMBIGUOUS)
 *   - developmentConfidence means "hands-on coding is core to THIS role", not
 *     "this role sits in an engineering org" (v1 gave Directors of Engineering
 *     confidence 90 with codingIntensity NONE)
 *
 * So only two kinds of row are affected: those v1 could not name, and those
 * whose confidence contradicts their coding intensity. Everything else is
 * copied forward unchanged.
 *
 *   node dist/modules/matching/migrate-classifications-v2.js
 */
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { VertexGeminiProvider } from '../ai/vertex-gemini.provider';
import { AiUsageService } from '../ai/ai-usage.service';
import { CLASSIFIER_VERSION, JobClassifierService, type ClassifiedJob } from './job-classifier.service';

const PREVIOUS_VERSION = CLASSIFIER_VERSION - 1;

async function main() {
  const prisma = new PrismaClient();
  const config = new ConfigService();
  const classifier = new JobClassifierService(
    new VertexGeminiProvider(config, new AiUsageService(prisma as never)),
  );

  const previous = await prisma.jobClassification.findMany({
    where: { classifierVersion: PREVIOUS_VERSION },
    include: { job: { select: { id: true, title: true, description: true } } },
  });
  console.log(`${previous.length} rows at v${PREVIOUS_VERSION}`);

  const affected = previous.filter(
    (c) =>
      c.roleFamily === 'AMBIGUOUS' ||
      c.primaryFunction === 'AMBIGUOUS' ||
      (c.developmentConfidence >= 70 &&
        ['OCCASIONAL', 'INCIDENTAL', 'NONE'].includes(c.codingIntensity)),
  );
  const unaffected = previous.filter((c) => !affected.includes(c));
  console.log(`reclassify ${affected.length}, copy forward ${unaffected.length}\n`);

  // Copy forward — no LLM, no cost.
  for (const c of unaffected) {
    await prisma.jobClassification.upsert({
      where: { jobId_classifierVersion: { jobId: c.jobId, classifierVersion: CLASSIFIER_VERSION } },
      create: {
        jobId: c.jobId,
        classifierVersion: CLASSIFIER_VERSION,
        primaryFunction: c.primaryFunction,
        roleFamily: c.roleFamily,
        specializations: c.specializations,
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
  console.log(`copied ${unaffected.length} rows forward`);

  if (affected.length === 0) {
    await prisma.$disconnect();
    return;
  }

  const started = new Date();
  const persist = async (batch: ClassifiedJob[]) => {
    for (const c of batch) {
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
  };

  const { classified, failedIds } = await classifier.classify(
    affected.map((c) => ({ id: c.job.id, title: c.job.title, description: c.job.description })),
    persist,
  );

  const cost = await prisma.aiUsage.aggregate({
    where: { createdAt: { gte: started }, kind: 'GENERATE' },
    _sum: { costUsd: true },
    _count: true,
  });

  console.log(`\nreclassified ${classified.length}, failed ${failedIds.length}`);
  console.log(`vertex: ${cost._count} calls, est $${Number(cost._sum.costUsd ?? 0).toFixed(4)}`);

  for (const c of classified) {
    const before = affected.find((a) => a.jobId === c.jobId);
    console.log(
      `  ${before?.job.title.slice(0, 44).padEnd(44)} ${before?.roleFamily}/${before?.developmentConfidence}% ` +
        `-> ${c.roleFamily}/${c.developmentConfidence}% coding=${c.codingIntensity}`,
    );
  }

  const total = await prisma.jobClassification.count({ where: { classifierVersion: CLASSIFIER_VERSION } });
  console.log(`\nv${CLASSIFIER_VERSION} rows: ${total}`);
  await prisma.$disconnect();
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
