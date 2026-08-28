/**
 * Build an India company WORKLIST from bangalorestartupmap.com.
 *
 * WHAT THIS TAKES, AND WHAT IT DELIBERATELY DOES NOT
 * ---------------------------------------------------
 * The site is a curated directory of Bengaluru companies by Aditi Tibarewal.
 * Its robots.txt is `User-Agent: * / Allow: /` and it states no terms, licence
 * or scraping prohibition. That permits fetching pages. It is NOT a licence to
 * republish the dataset, so this draws a line:
 *
 *   TAKEN — factual pointers, each independently re-verifiable from the
 *   company's own site, and none of them her creation:
 *       name, website, jobs_url
 *
 *   NOT TAKEN — the analytical dataset that IS the curation work:
 *       lat, lng, area, hsr_location, sector, stage, status, tags,
 *       total_funding, investors, team_size, founders, founder_links,
 *       founded_year, logo, tagline, description, twitter, linkedin
 *
 * The output is a candidate worklist, exactly as FreeHire's harvest-boards
 * treats a seed: "every new slug is probed against the platform's official
 * public API and kept only if it returns jobs, so the committed file is our own
 * validated fact set, not a redistributed dataset." Nothing here is ingested;
 * downstream the career page, the ATS and every posting are re-derived from
 * each company's own site.
 *
 * She has said she plans to add a job board. This worklist is for measuring
 * whether an India-first company universe improves CareerOS's supply — not for
 * reproducing her product.
 *
 *   node scripts/seed-from-startup-map.mjs > scripts/seeds/bangalore-full.tsv
 */
const UA = 'CareerOS-Research/0.1 (+personal job-search tool; respects robots.txt)';
/**
 * PER-SOURCE PERMISSION IS NOT INHERITED. Everything documented above applies
 * to bangalorestartupmap.com. Each additional site is checked on its own terms
 * before it is passed to this script:
 *
 *   delhistartupmap.com - checked 2026-08-29. Its terms permit browsing and
 *     search "for personal or professional research", and forbid scraping that
 *     OVERLOADS the site or republishing THE FULL DATASET without permission.
 *     A single homepage fetch does not overload it, and the output file is
 *     gitignored exactly as bangalore-full.tsv is, so nothing is republished.
 *     NOTE: it covers Delhi NCR, not Delhi proper. Do not label its companies
 *     "Delhi" - city is re-derived downstream from the postings themselves.
 *
 *   hyderabadstartupsmap.lol - checked 2026-08-29. NOT PERMITTED, do not seed.
 *     Its robots.txt allows /startups/, but robots.txt governs crawler
 *     politeness, not licensing, and its Terms section 7 is explicit: "You may
 *     not copy, scrape, or commercially exploit the directory without prior
 *     written permission." The same reasoning that PERMITTED bangalore (it
 *     states no prohibition) FORBIDS this one. 263 startup pages were located
 *     via the sitemap and deliberately never fetched. Permission can be asked
 *     for at hey@nikhilsai.in; until it is granted in writing, this source is
 *     UNSUPPORTED - which is a recorded state, not a gap to route around.
 *
 * A site whose company list is NOT in the page payload cannot be seeded here
 * at all. hyderabadstartupsmap.lol keeps its list behind per-startup pages and
 * its robots.txt disallows /api/, so it needs a sitemap-driven seeder instead.
 */
const SRC = process.argv[2] ?? 'https://bangalorestartupmap.com/';

/** Deterministic robots.txt check — never delegated to a model. */
async function robotsAllows(origin, path) {
  const r = await fetch(origin + '/robots.txt', { headers: { 'user-agent': UA } });
  if (!r.ok) return true;
  const body = await r.text();
  let applies = false;
  for (const raw of body.split('\n')) {
    const line = raw.split('#')[0].trim();
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    if (k === 'user-agent') applies = v === '*';
    else if (applies && k === 'disallow' && v && path.startsWith(v)) return false;
  }
  return true;
}

const origin = new URL(SRC).origin;
if (!(await robotsAllows(origin, '/'))) {
  console.error('robots.txt disallows /. Stopping.');
  process.exit(1);
}

const res = await fetch(SRC, { headers: { 'user-agent': UA } });
if (!res.ok) {
  console.error(`fetch failed: HTTP ${res.status}`);
  process.exit(1);
}
const html = await res.text();

/**
 * The page is a Next.js App Router document: records arrive inside the RSC
 * flight payload, pushed as JS string literals across MANY chunks.
 *
 * Unescaping with a blunt `.replace(/\\"/g, '"')` looks like it works and
 * quietly loses 17% of records — an escaped backslash before a quote is
 * corrupted, and objects straddling a chunk boundary are truncated. Measured:
 * 159 of 957 dropped, with no error. So each chunk is unescaped by JSON.parse
 * (the only correct unescaper for a JS string literal) and the chunks are
 * concatenated BEFORE any object is read, which repairs boundary splits too.
 */
const chunks = [];
for (const m of html.matchAll(/self\.__next_f\.push\(\[\d+,\s*("(?:[^"\\]|\\.)*")\s*\]\)/g)) {
  try {
    chunks.push(JSON.parse(m[1]));
  } catch {
    /* a chunk that is not a plain string literal carries no records */
  }
}
const flat = chunks.join('');

/**
 * Balance braces from `start` and JSON.parse the object found there.
 *
 * A regex window CANNOT do this correctly, and the first version of this script
 * proved it: `"name"` occurs 1143 times against 957 records because founders
 * and investors carry names too, so a fixed-size window paired the founder
 * "Pranav Pai" with 56secure.com and "Accel India" with accenture.com. A seed
 * with wrong name->domain pairs is worse than no seed — every downstream
 * verification would be checking the wrong company.
 */
function objectAt(s, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

const seen = new Set();
const rows = [];
let anchors = 0;
let parseFailures = 0;
// `slug` occurs exactly 957 times — once per company record — so it is the
// reliable anchor. Walk back to the object's opening brace, then parse the
// whole record so fields can never be borrowed across boundaries.
for (const m of flat.matchAll(/"slug":"/g)) {
  anchors++;
  const open = flat.lastIndexOf('{', m.index);
  if (open < 0) { parseFailures++; continue; }
  const rec = objectAt(flat, open);
  if (!rec || typeof rec.name !== 'string') { parseFailures++; continue; }

  const name = rec.name.trim();
  const website = typeof rec.website === 'string' ? rec.website : '';
  const jobsUrl = typeof rec.jobs_url === 'string' ? rec.jobs_url : '';
  if (!name || !website) continue;

  let domain;
  try {
    domain = new URL(website.startsWith('http') ? website : 'https://' + website).hostname
      .replace(/^www\./, '');
  } catch {
    continue;
  }
  if (seen.has(domain)) continue;
  seen.add(domain);
  rows.push([name, domain, jobsUrl]);
}

// Report losses explicitly. A silent drop is the failure mode this script
// already had once: it looked healthy while discarding 159 of 957 records.
console.error(
  `records seen ${anchors} | unreadable ${parseFailures} | ` +
    `kept ${rows.length} unique (name + domain + jobs_url only)`,
);
if (parseFailures > anchors * 0.02) {
  console.error(
    `WARNING: ${parseFailures} records (${Math.round((parseFailures / anchors) * 100)}%) ` +
      `could not be read. The seed is INCOMPLETE — do not treat it as the full universe.`,
  );
}
console.log(`# Worklist from ${new URL(SRC).hostname} — names/domains/jobs_url only.`);
console.log('# Curation (location, sector, stage, funding, investors, team) NOT taken.');
console.log('# Every claim downstream is re-derived from the company\'s own site.');
for (const [name, domain, jobsUrl] of rows) {
  console.log(`${name}\t${domain}\t${jobsUrl}`);
}
