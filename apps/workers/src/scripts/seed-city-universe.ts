/**
 * Seed a CITY's company universe into CareerOS.
 *
 * THE MODEL THIS SERVES: a company is a long-lived asset; its jobs are
 * ephemeral. A company with zero matching openings today is still worth
 * holding, because three months from now it posts a Node role and CareerOS
 * already knows its career page, its ATS and where it is. That is the
 * difference between a job aggregator and a monitored company universe.
 *
 * Measured 2026-08-21, and the reason this script exists: a 250-company
 * Bangalore cohort put only SIX companies into CareerOS — the ones that
 * happened to yield crawlable jobs. The other 244 were discovered, verified and
 * then thrown away, including every company that simply is not hiring today.
 *
 * This is deliberately NOT a new engine. `POST /internal/discovery/bulk` already
 * models the whole lifecycle:
 *
 *   DISCOVERED ──probe──> WEBSITE_VERIFIED ──> CAREER_PAGE_FOUND ──> MONITORED
 *        └── re-probed every 7 days ──┘                └── crawled on the tick
 *
 * A company with no detectable ATS stays DISCOVERED and is re-probed, rather
 * than vanishing. CompanyCandidate already carries `city` and `country`, so the
 * engine is location-parameterised as it stands: Pune, Hyderabad, Indore and
 * the rest are a new SEED, not new architecture.
 *
 * The seed is a candidate worklist only. Everything downstream — website,
 * career page, ATS, jobs — is re-derived from each company's own site.
 *
 *   npx tsx src/scripts/seed-city-universe.ts <seed.tsv> "Bengaluru"
 *   npx tsx src/scripts/seed-city-universe.ts <seed.tsv> "Bengaluru" --apply
 *
 * seed.tsv: `Company Name<TAB>domain[<TAB>jobs_url]`, `#` comments ignored.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import type { CompanyCandidate } from '@careeros/shared';
import { ApiClient } from '../api-client';

async function main(): Promise<void> {
  const [file, city] = process.argv.slice(2);
  const apply = process.argv.includes('--apply');
  if (!file || !city) {
    console.error('usage: seed-city-universe.ts <seed.tsv> <City> [--apply]');
    process.exit(1);
  }
  // Namespaced by city so `discoveredBy` stays answerable per universe:
  // "which city's company universe produced interviews?" is a question we will
  // want, and it cannot be recovered later from a single 'map' label.
  const source = `city-${city.toLowerCase().replace(/\s+/g, '-')}`;

  const candidates: CompanyCandidate[] = readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const [name, domain, jobsUrl] = l.split('\t');
      return { name: (name ?? '').trim(), domain: (domain ?? '').trim(), jobsUrl: (jobsUrl ?? '').trim() };
    })
    .filter((r) => r.name && r.domain)
    .map((r) => ({
      name: r.name,
      website: `https://${r.domain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`,
      // Only a HINT. The API re-runs detectAts on it and keeps the result only
      // if it resolves — a careers URL that reveals nothing leaves the company
      // at DISCOVERED, which is the honest state.
      atsHintUrl: r.jobsUrl && /^https?:\/\//.test(r.jobsUrl) ? r.jobsUrl : null,
      city,
      country: 'IN',
    }));

  console.log(
    `${candidates.length} candidates | city=${city} | discoverySource=${source}\n` +
      `${candidates.filter((c) => c.atsHintUrl).length} carry a careers URL hint\n`,
  );

  if (!apply) {
    console.log('DRY RUN — nothing written. Sample:');
    for (const c of candidates.slice(0, 5)) {
      console.log(`  ${c.name.padEnd(28)} ${c.website}${c.atsHintUrl ? '  hint:' + c.atsHintUrl.slice(0, 40) : ''}`);
    }
    console.log('\nRe-run with --apply to seed.');
    return;
  }

  // ApiClient.bulkDiscover already chunks at 500 — the endpoint caps at 5000
  // per request, and a single oversized POST once 400'd an entire sweep.
  const api = new ApiClient();
  const { created, merged } = await api.bulkDiscover(source, candidates);

  console.log(`
=================================================
candidates offered   ${candidates.length}
created              ${created}   <- new to the universe
merged               ${merged}   <- already known, enriched

Companies with a resolvable ATS are MONITORED and crawl on the next tick.
The rest stay DISCOVERED and are re-probed every 7 days — a company that is
not hiring today does not leave the universe.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
