/**
 * UNKNOWN-company ATS audit. READ ONLY — ingests nothing, writes nothing.
 *
 * Question: of the companies CareerOS holds with atsProvider=UNKNOWN, how many
 * can be identified from evidence we ALREADY have, and how many of those are
 * crawlable by an adapter that already exists?
 *
 * This is dependency reduction at zero acquisition cost — no new source, no new
 * upstream relationship. Compare against Workday, which cost ~$60 projected for
 * ~115 actionable at 14.2 per 1k.
 *
 * Aggregator hosts are excluded from identity per ADR-11: remoteOK, himalayas,
 * echojobs, jooble, t.me and friends carry jobs for arbitrary companies, so a
 * job hosted there tells us nothing about the employer's own ATS.
 */
import { execSync } from 'node:child_process';
import { detectAts } from '../packages/shared/dist/ats.js';

const CRAWLABLE = new Set([
  'GREENHOUSE', 'LEVER', 'ASHBY', 'WORKABLE',
  'SMARTRECRUITERS', 'RECRUITEE', 'BREEZY', 'KEKA',
]);

const AGGREGATOR = /^(www\.)?(remoteok\.(com|io)|himalayas\.app|echojobs\.io|jooble\.org|t\.me|telegram\.me|.*whatjobs\.com|ycombinator\.com|powertofly\.com|jobgether\.com|weekday\.works|linkedin\.com|indeed\.com|wellfound\.com|freehire\.me)$/i;

const out = execSync(
  'docker exec -i careeros-postgres-1 psql -U careeros -d careeros -t -A -f /tmp/unknown-q.sql',
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };

const rows = out.split('\n').filter(Boolean).map((l) => {
  const [id, name, url, website, careerPage, active, actionable] = l.split('\t');
  return { id, name, url, website, careerPage, active: +active || 0, actionable: +actionable || 0 };
});

const buckets = { STRONG: [], WEAK: [], AGGREGATOR_ONLY: [], NO_EVIDENCE: [] };

for (const r of rows) {
  // Try every URL we hold, strongest first: apply URL, career page, website.
  const candidates = [r.url, r.careerPage, r.website].filter(Boolean);
  let hit = null;
  let sawAggregator = false;

  for (const u of candidates) {
    const h = hostOf(u);
    if (h && AGGREGATOR.test(h)) { sawAggregator = true; continue; }
    const d = detectAts(u);
    if (d.provider !== 'UNKNOWN' && d.identifier) { hit = { ...d, from: u }; break; }
  }

  if (hit) {
    (CRAWLABLE.has(hit.provider) ? buckets.STRONG : buckets.WEAK).push({ ...r, ...hit });
  } else if (candidates.length && sawAggregator) {
    buckets.AGGREGATOR_ONLY.push(r);
  } else {
    buckets.NO_EVIDENCE.push(r);
  }
}

const tot = (arr, f) => arr.reduce((a, x) => a + x[f], 0);
const line = (label, arr) =>
  console.log(
    `  ${label.padEnd(24)} companies=${String(arr.length).padEnd(5)} ` +
    `activeJobs=${String(tot(arr, 'active')).padEnd(6)} actionable=${tot(arr, 'actionable')}`,
  );

console.log(`UNKNOWN companies analysed: ${rows.length}\n`);
console.log('=== classification ===');
line('STRONG (have adapter)', buckets.STRONG);
line('WEAK (need adapter)', buckets.WEAK);
line('AGGREGATOR_ONLY', buckets.AGGREGATOR_ONLY);
line('NO_EVIDENCE', buckets.NO_EVIDENCE);

const tally = (arr, fn) => {
  const m = new Map();
  for (const r of arr) { const k = fn(r); m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

console.log('\n=== STRONG — recoverable with adapters that already exist ===');
for (const [p, n] of tally(buckets.STRONG, (r) => r.provider)) {
  const sub = buckets.STRONG.filter((r) => r.provider === p);
  console.log(`  ${p.padEnd(18)} companies=${String(n).padEnd(4)} activeJobs=${tot(sub, 'active')}`);
}

console.log('\n=== WEAK — identified but NO adapter exists ===');
for (const [p, n] of tally(buckets.WEAK, (r) => r.provider)) {
  const sub = buckets.WEAK.filter((r) => r.provider === p);
  console.log(`  ${p.padEnd(18)} companies=${String(n).padEnd(4)} activeJobs=${tot(sub, 'active')}`);
}

console.log('\n=== unidentified hosts, by frequency (top 15) ===');
const unid = [...buckets.AGGREGATOR_ONLY, ...buckets.NO_EVIDENCE];
for (const [h, n] of tally(unid, (r) => hostOf(r.url) ?? '(no url)').slice(0, 15)) {
  console.log(`  ${String(h).padEnd(42)} ${n}`);
}

console.log('\n=== dependency exposure of the STRONG set ===');
console.log(`  active jobs at STRONG companies : ${tot(buckets.STRONG, 'active')}`);
console.log(`  actionable there today          : ${tot(buckets.STRONG, 'actionable')}`);
console.log('  (identifying the ATS makes these independently crawlable and may');
console.log('   expose the rest of each board — it does not by itself create jobs)');
