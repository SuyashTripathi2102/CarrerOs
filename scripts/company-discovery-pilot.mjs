/**
 * Company Discovery Pilot — FETCH ONLY. Ingests nothing, writes nothing.
 *
 * THE QUESTION: does an India-first company universe produce enough
 * INDEPENDENT, relevant opportunity supply to deserve scaling?
 *
 * Not "can we crawl Bangalore". We already know company-first discovery works.
 * Measured 2026-08-21: the 33 YC companies that actually post India jobs yield
 * 0.152 actionable/company — 11.7x YC's headline 0.013, which was dragged down
 * by 190 companies with no active jobs at all and 175 that post nothing in
 * India. A Bangalore universe is India-posting by construction, so 0.152 is
 * the number to beat and freehire's 0.376 is the ceiling worth aiming at.
 *
 * EVIDENCE HIERARCHY. A 200 means the server answered, not that this is the
 * company's real board. Slug guessing produced 640 of our 805 ATS assignments
 * (79.5%), and is what let an empty Workable account for Zensar cost 606 jobs.
 * This pilot refuses to promote a guess:
 *
 *   TIER_1_SITE_LINK   the company's own site links to the board   STRONG
 *   TIER_2_KNOWN_POST  the board carries a posting we expected     STRONG
 *   TIER_3_PAGE_JOBS   its own career page yields real postings    MEDIUM
 *   TIER_4_SLUG_GUESS  a guessed slug answered 200                 NEVER ACCEPTED
 *
 * Anything unproven stays UNKNOWN. Uncertainty is a state, not a weak yes.
 *
 * Usage:
 *   node scripts/company-discovery-pilot.mjs seeds/bangalore.tsv
 *
 * Seed file: `Company Name<TAB>domain` per line; `#` comments ignored. The seed
 * is a CANDIDATE WORKLIST ONLY — every claim is re-derived from the company's
 * own site, so what this reports is our own verified fact set, never a
 * redistribution of whoever compiled the list.
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { detectAts } from '../packages/shared/dist/ats.js';

const UA = 'CareerOS-Research/0.1 (+personal job-search tool; respects robots.txt)';
const TIMEOUT_MS = 20_000;
const CAREER_PATHS = ['/careers', '/jobs', '/careers/', '/company/careers', '/about/careers'];
const INDIA_RE =
  /india|bengaluru|bangalore|mumbai|pune|new delhi|delhi|hyderabad|chennai|noida|gurgaon|gurugram|indore|kolkata|ahmedabad|jaipur|kochi/i;

async function get(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': UA },
      redirect: 'follow',
      signal: ctl.signal,
    });
    return { ok: r.ok, status: r.status, url: r.url, body: r.ok ? await r.text() : '' };
  } catch (e) {
    return { ok: false, status: 0, url, body: '', error: String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * robots.txt, parsed deterministically. Never by asking a model — ScrapeGraphAI
 * decides this by substring-matching an LLM's prose, which is exactly the wrong
 * design for the one check that must not be wrong.
 */
async function robotsAllows(origin, path) {
  const r = await get(origin + '/robots.txt');
  if (!r.ok) return true; // nothing stated is not a prohibition
  let applies = false;
  for (const raw of r.body.split('\n')) {
    const line = raw.split('#')[0].trim();
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim().toLowerCase();
    const v = line.slice(idx + 1).trim();
    if (k === 'user-agent') applies = v === '*';
    else if (applies && k === 'disallow' && v && path.startsWith(v)) return false;
  }
  return true;
}

/** Every outbound link on a page, absolutised. */
function links(html, base) {
  const out = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)) {
    try {
      out.push(new URL(m[1], base).toString());
    } catch {
      /* unparseable href */
    }
  }
  return out;
}

function psql(sql) {
  return execSync(
    'docker exec -i careeros-postgres-1 psql -U careeros -d careeros -t -A -c ' +
      JSON.stringify(sql),
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  )
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

const seedPath = process.argv[2];
if (!seedPath) {
  console.error('usage: company-discovery-pilot.mjs <seed.tsv>');
  process.exit(1);
}

const seeds = readFileSync(seedPath, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .map((l) => {
    const [name, domain] = l.split('\t');
    return { name: (name ?? '').trim(), domain: (domain ?? '').trim() };
  })
  .filter((s) => s.name && s.domain);

console.log(`seed: ${seeds.length} companies from ${seedPath}\n`);

// The INCREMENTAL question. 500 jobs discovered where 470 already exist is a
// channel worth 30, not 500.
const existingCompanies = new Set(
  psql('SELECT lower(name) FROM companies WHERE "aliasOfId" IS NULL'),
);
const existingAts = new Set(
  psql(
    'SELECT lower("atsProvider" || \'/\' || "atsIdentifier") FROM companies WHERE "atsIdentifier" IS NOT NULL',
  ),
);
console.log(`corpus: ${existingCompanies.size} companies, ${existingAts.size} known ATS boards\n`);

const rows = [];
for (const seed of seeds) {
  const row = {
    name: seed.name,
    domain: seed.domain,
    alreadyKnown: existingCompanies.has(seed.name.toLowerCase()),
    siteReached: false,
    careerPage: null,
    atsProvider: 'UNKNOWN',
    atsIdentifier: null,
    verifiedBy: 'NONE',
    boardAlreadyKnown: false,
    robotsBlocked: false,
    error: null,
  };
  const origin = 'https://' + seed.domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');

  const home = await get(origin);
  row.siteReached = home.ok;
  if (!home.ok) {
    row.error = `home ${home.status}${home.error ? ' ' + home.error : ''}`;
    rows.push(row);
    console.log(`  ${seed.name.padEnd(22)} site=FAIL ${row.error}`);
    continue;
  }

  // TIER 1 — the company's own site links to its board. The strongest evidence
  // available: the employer asserts it, we do not infer it.
  const takeAts = (href, tier) => {
    const d = detectAts(href);
    if (d.provider === 'UNKNOWN' || !d.identifier) return false;
    row.atsProvider = d.provider;
    row.atsIdentifier = d.identifier;
    row.verifiedBy = tier;
    row.boardAlreadyKnown = existingAts.has(`${d.provider}/${d.identifier}`.toLowerCase());
    return true;
  };

  for (const href of links(home.body, home.url)) {
    if (takeAts(href, 'TIER_1_SITE_LINK')) {
      row.careerPage = href;
      break;
    }
  }

  // Otherwise find a careers page and look one hop further in.
  if (row.verifiedBy === 'NONE') {
    const careerHref = links(home.body, home.url).find((h) =>
      /careers?|jobs|hiring|join-us|work-with-us/i.test(h),
    );
    const candidates = careerHref ? [careerHref] : CAREER_PATHS.map((p) => origin + p);

    for (const cand of candidates) {
      let u;
      try {
        u = new URL(cand);
      } catch {
        continue;
      }
      if (!(await robotsAllows(u.origin, u.pathname))) {
        row.robotsBlocked = true;
        continue;
      }
      const page = await get(cand);
      if (!page.ok) continue;
      row.careerPage = page.url;

      for (const href of links(page.body, page.url)) {
        if (takeAts(href, 'TIER_1_SITE_LINK')) break;
      }
      // MEDIUM only: the page exists and talks about India roles, but we have
      // not identified a machine-readable board. Never promoted to an ATS.
      if (row.verifiedBy === 'NONE' && INDIA_RE.test(page.body)) {
        row.verifiedBy = 'TIER_3_PAGE_JOBS';
      }
      break;
    }
  }

  rows.push(row);
  console.log(
    `  ${seed.name.padEnd(22)} site=ok  ats=${String(row.atsProvider).padEnd(16)}` +
      `via=${row.verifiedBy.padEnd(18)}${row.boardAlreadyKnown ? 'BOARD-ALREADY-KNOWN' : ''}`,
  );
}

const n = (f) => rows.filter(f).length;
console.log(`
=============== PILOT FUNNEL ===============
companies attempted             ${rows.length}
  already in CareerOS           ${n((r) => r.alreadyKnown)}   <- not independent supply
  new to CareerOS               ${n((r) => !r.alreadyKnown)}
site reached                    ${n((r) => r.siteReached)}
career page found               ${n((r) => r.careerPage)}
ATS identified                  ${n((r) => r.atsProvider !== 'UNKNOWN')}
  of which board already known  ${n((r) => r.boardAlreadyKnown)}   <- duplicate supply
  NEW board                     ${n((r) => r.atsProvider !== 'UNKNOWN' && !r.boardAlreadyKnown)}
evidence:
  TIER_1 site link (STRONG)     ${n((r) => r.verifiedBy === 'TIER_1_SITE_LINK')}
  TIER_3 page only  (MEDIUM)    ${n((r) => r.verifiedBy === 'TIER_3_PAGE_JOBS')}
  UNKNOWN, stays unknown        ${n((r) => r.verifiedBy === 'NONE')}
robots-blocked (respected)      ${n((r) => r.robotsBlocked)}
site unreachable                ${n((r) => !r.siteReached)}

Zero slug guesses. A guessed slug answering 200 is never accepted here.
Baselines, actionable/company: YC-India 0.152 | jooble 0.320 | freehire 0.376
`);

const byProvider = {};
for (const r of rows) {
  if (r.atsProvider !== 'UNKNOWN') byProvider[r.atsProvider] = (byProvider[r.atsProvider] ?? 0) + 1;
}
if (Object.keys(byProvider).length > 0) {
  console.log('provider breakdown:');
  for (const [p, c] of Object.entries(byProvider).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${p.padEnd(18)} ${c}`);
  }
}

console.log('\nunresolved (candidates for a career-page extractor, not for guessing):');
for (const r of rows.filter((x) => x.verifiedBy !== 'TIER_1_SITE_LINK').slice(0, 15)) {
  console.log(
    `  ${r.name.padEnd(22)} ${r.error ? 'ERR ' + r.error : r.careerPage ? 'page: ' + r.careerPage.slice(0, 60) : 'no career page found'}`,
  );
}
