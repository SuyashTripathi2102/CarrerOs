/**
 * Classify custom career pages by what it would ACTUALLY take to extract them.
 * FETCH ONLY — ingests nothing, writes nothing, renders nothing.
 *
 * WHY: the Bangalore pilot found 9 machine-readable ATS boards among 42
 * reachable companies (21%) and 25 career pages with no board at all (60%).
 * Darwinbox — the biggest ATS finding — was 6 companies and 14 fresh jobs. This
 * long tail is four times larger and entirely unmeasured, so it is where the
 * India supply gap most plausibly lives.
 *
 * THE QUESTION IS NOT "can an LLM read these". It is: how many need one?
 * "No machine-readable board" is not the same as "requires AI extraction". A
 * page emitting schema.org JobPosting, or a Next.js payload, or plainly
 * repeated job rows in server-rendered HTML, is a deterministic parse — and
 * per the extraction tier order, LLM is the LAST resort, never the default.
 *
 * Tiers, cheapest first:
 *
 *   JSONLD_JOBPOSTING  schema.org JobPosting in the HTML   parse, no LLM ever
 *   EMBEDDED_JSON      __NEXT_DATA__ / __NUXT__ / state    parse, no LLM ever
 *   ATS_IFRAME         embeds a board we already crawl     existing adapter
 *   STATIC_HTML        repeated job rows, server-rendered  one-time recipe
 *   JS_SHELL           no content without a browser        render, then recipe
 *   NO_JOBS_FOUND      career page with nothing job-like   probably not a board
 *
 * Usage: node scripts/career-page-classify.mjs scripts/seeds/bangalore-pilot.tsv
 */
import { readFileSync } from 'node:fs';
import { detectAts } from '../packages/shared/dist/ats.js';

const UA = 'CareerOS-Research/0.1 (+personal job-search tool; respects robots.txt)';
const TIMEOUT_MS = 20_000;
const CAREER_PATHS = ['/careers', '/jobs', '/careers/'];

async function get(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: ctl.signal });
    return { ok: r.ok, status: r.status, url: r.url, body: r.ok ? await r.text() : '' };
  } catch (e) {
    return { ok: false, status: 0, url, body: '', error: String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

function links(html, base) {
  const out = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)) {
    try { out.push(new URL(m[1], base).toString()); } catch { /* skip */ }
  }
  return out;
}

/** Visible text, crudely. Enough to tell a rendered page from a shell. */
function textOf(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const JOB_WORD = /\b(engineer|developer|manager|designer|analyst|scientist|architect|intern|lead|specialist|associate)\b/gi;
const INDIA_RE = /india|bengaluru|bangalore|mumbai|pune|hyderabad|chennai|noida|gurgaon|gurugram|kolkata/i;

function classify(html, base) {
  const signals = [];

  // Tier 1 — schema.org JobPosting. Deterministic forever, no LLM at any point.
  const ld = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  let jobPostings = 0;
  for (const m of ld) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const nodes = Array.isArray(parsed) ? parsed : [parsed, ...(parsed['@graph'] ?? [])];
      jobPostings += nodes.filter((n) => n && n['@type'] === 'JobPosting').length;
    } catch { /* malformed ld+json is common; ignore */ }
  }
  if (jobPostings > 0) return { tier: 'JSONLD_JOBPOSTING', detail: `${jobPostings} JobPosting`, signals };

  // Tier 2 — a framework payload already in the page.
  for (const [name, re] of [
    ['__NEXT_DATA__', /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i],
    ['__NUXT__', /window\.__NUXT__\s*=\s*([\s\S]{20,200000}?);?\s*<\/script>/i],
    ['INITIAL_STATE', /window\.__INITIAL_STATE__\s*=\s*([\s\S]{20,200000}?);?\s*<\/script>/i],
  ]) {
    const m = html.match(re);
    if (m && /"(jobs?|openings?|positions?|vacanc)/i.test(m[1])) {
      return { tier: 'EMBEDDED_JSON', detail: name, signals };
    }
    if (m) signals.push(`${name}(no job keys)`);
  }

  // Tier 3 — embeds a board we already crawl.
  for (const m of html.matchAll(/<iframe\b[^>]*src=["']([^"']+)["']/gi)) {
    const d = detectAts(new URL(m[1], base).toString());
    if (d.provider !== 'UNKNOWN') return { tier: 'ATS_IFRAME', detail: d.provider, signals };
  }

  // Tier 4/5 — is there server-rendered job content, or only a shell?
  const text = textOf(html);
  const jobWords = (text.match(JOB_WORD) ?? []).length;
  const scripts = (html.match(/<script\b/gi) ?? []).length;

  if (jobWords >= 5) {
    return { tier: 'STATIC_HTML', detail: `${jobWords} role words, ${text.length}b text`, signals };
  }
  if (text.length < 2500 || scripts >= 6) {
    return { tier: 'JS_SHELL', detail: `${text.length}b text, ${scripts} scripts`, signals };
  }
  return { tier: 'NO_JOBS_FOUND', detail: `${jobWords} role words, ${text.length}b text`, signals };
}

const seedPath = process.argv[2];
const raw = readFileSync(seedPath, 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

/**
 * Two input shapes, one classifier — so the sampled pilot and the full corpus
 * pass can never drift into two different definitions of the tiers.
 *
 *   name <TAB> domain              discover the career page, then classify
 *   id <TAB> name <TAB> pageUrl    classify that page directly
 */
const DIRECT = raw.length > 0 && raw[0].split('\t').length >= 3;
const seeds = DIRECT
  ? raw.map((l) => { const [, name, url] = l.split('\t'); return { name: (name ?? '').trim(), pageUrl: (url ?? '').trim() }; })
      .filter((s) => s.name && s.pageUrl)
  : raw.map((l) => { const [name, domain] = l.split('\t'); return { name: (name ?? '').trim(), domain: (domain ?? '').trim() }; })
      .filter((s) => s.name && s.domain);

console.log(`classifying career pages for ${seeds.length} companies\n`);

const rows = [];
for (const s of seeds) {
  // Direct mode: we already hold the page URL, so skip discovery entirely.
  if (s.pageUrl) {
    const page = await get(s.pageUrl);
    if (!page.ok) {
      rows.push({ ...s, tier: 'SITE_UNREACHABLE', detail: `HTTP ${page.status}`, hasAts: false });
      console.log(`  ${s.name.slice(0, 22).padEnd(23)} SITE_UNREACHABLE   HTTP ${page.status}`);
      continue;
    }
    let ats = null;
    for (const h of links(page.body, page.url)) {
      const d = detectAts(h);
      if (d.provider !== 'UNKNOWN' && d.identifier) { ats = d; break; }
    }
    const c = classify(page.body, page.url);
    const india = INDIA_RE.test(textOf(page.body));
    rows.push({ ...s, ...c, url: page.url, hasAts: Boolean(ats), atsProvider: ats?.provider ?? null, india });
    console.log(
      `  ${s.name.slice(0, 22).padEnd(23)} ${c.tier.padEnd(19)}${(c.detail ?? '').padEnd(28)}` +
        `${ats ? 'ATS:' + ats.provider : ''}${india ? ' [india]' : ''}`,
    );
    continue;
  }

  const origin = 'https://' + s.domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const home = await get(origin);
  if (!home.ok) {
    rows.push({ ...s, tier: 'SITE_UNREACHABLE', detail: `HTTP ${home.status}`, hasAts: false });
    console.log(`  ${s.name.padEnd(16)} SITE_UNREACHABLE   HTTP ${home.status}`);
    continue;
  }

  // Skip anything the pilot already resolves to a real board.
  let ats = null;
  for (const h of links(home.body, home.url)) {
    const d = detectAts(h);
    if (d.provider !== 'UNKNOWN' && d.identifier) { ats = d; break; }
  }

  const careerHref = links(home.body, home.url).find((h) => /careers?|jobs|hiring|join-us/i.test(h));
  const candidates = careerHref ? [careerHref] : CAREER_PATHS.map((p) => origin + p);

  let page = null;
  for (const c of candidates) {
    const r = await get(c);
    if (r.ok) { page = r; break; }
  }
  if (!page) {
    rows.push({ ...s, tier: 'NO_CAREER_PAGE', detail: '', hasAts: Boolean(ats) });
    console.log(`  ${s.name.padEnd(16)} NO_CAREER_PAGE`);
    continue;
  }

  if (!ats) {
    for (const h of links(page.body, page.url)) {
      const d = detectAts(h);
      if (d.provider !== 'UNKNOWN' && d.identifier) { ats = d; break; }
    }
  }

  const c = classify(page.body, page.url);
  const india = INDIA_RE.test(textOf(page.body));
  rows.push({ ...s, ...c, url: page.url, hasAts: Boolean(ats), atsProvider: ats?.provider ?? null, india });
  console.log(
    `  ${s.name.padEnd(16)} ${c.tier.padEnd(19)}${(c.detail ?? '').padEnd(30)}` +
      `${ats ? 'ATS:' + ats.provider : ''}${india ? ' [india]' : ''}`,
  );
}

const custom = rows.filter((r) => !r.hasAts && r.tier !== 'SITE_UNREACHABLE' && r.tier !== 'NO_CAREER_PAGE');
const n = (t) => custom.filter((r) => r.tier === t).length;

console.log(`
================ CUSTOM CAREER PAGE CLASSIFICATION ================
companies seeded                 ${rows.length}
  site unreachable               ${rows.filter((r) => r.tier === 'SITE_UNREACHABLE').length}
  no career page found           ${rows.filter((r) => r.tier === 'NO_CAREER_PAGE').length}
  has a machine-readable ATS     ${rows.filter((r) => r.hasAts).length}
CUSTOM CAREER PAGES              ${custom.length}

  deterministic TODAY, no LLM ever
    JSONLD_JOBPOSTING            ${n('JSONLD_JOBPOSTING')}
    EMBEDDED_JSON                ${n('EMBEDDED_JSON')}
    ATS_IFRAME                   ${n('ATS_IFRAME')}
                       subtotal  ${n('JSONLD_JOBPOSTING') + n('EMBEDDED_JSON') + n('ATS_IFRAME')}

  one-time recipe, then deterministic
    STATIC_HTML                  ${n('STATIC_HTML')}

  needs a browser render first
    JS_SHELL                     ${n('JS_SHELL')}

  probably not a job board
    NO_JOBS_FOUND                ${n('NO_JOBS_FOUND')}

  mentioning India                ${custom.filter((r) => r.india).length} / ${custom.length}
`);

// India x tier. Extraction capability is worthless pointed at companies that
// do not hire in India, and this is the split that decides whether a render
// service is worth paying for against THIS pool of companies.
console.log('India-relevant, by tier (what extraction would actually unlock):');
for (const t of ['JSONLD_JOBPOSTING', 'EMBEDDED_JSON', 'ATS_IFRAME', 'STATIC_HTML', 'JS_SHELL']) {
  const all = custom.filter((r) => r.tier === t);
  if (all.length === 0) continue;
  console.log(`  ${t.padEnd(20)} ${String(all.filter((r) => r.india).length).padStart(3)} of ${String(all.length).padStart(3)}`);
}
console.log('');

console.log('JS_SHELL (the expensive tier) —');
for (const r of custom.filter((x) => x.tier === 'JS_SHELL')) {
  console.log(`  ${r.name.padEnd(16)} ${r.detail}  ${(r.url ?? '').slice(0, 55)}`);
}
