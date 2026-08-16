/**
 * Audit detectAts() against the apply URLs actually in the corpus. READ ONLY.
 *
 * Where a company is labelled with one ATS but its jobs serve from another
 * host, the URL is the stronger evidence. This reports the disagreement rather
 * than acting on it.
 *
 *   node scripts/ats-audit.mjs
 */
import { execSync } from 'node:child_process';
import { detectAts } from '../packages/shared/dist/ats.js';

const SQL =
  "SELECT c.name || E'\\t' || c.\\\"atsProvider\\\" || E'\\t' || j.url " +
  'FROM companies c JOIN LATERAL (SELECT url FROM jobs WHERE \\"companyId\\" = c.id ' +
  'ORDER BY \\"firstSeenAt\\" DESC LIMIT 1) j ON true';

const out = execSync(
  `docker exec -i careeros-postgres-1 psql -U careeros -d careeros -t -A -c "${SQL}"`,
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);

const hostOf = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return '(unparseable)';
  }
};

const rows = out
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    const [name, stored, url] = l.split('\t');
    return { name, stored, url };
  })
  .filter((r) => r.url);

const agree = [];
const conflict = [];
const urlUnknown = [];
for (const r of rows) {
  const d = detectAts(r.url);
  if (d.provider === 'UNKNOWN') urlUnknown.push({ ...r, host: hostOf(r.url) });
  else if (d.provider === r.stored) agree.push(r);
  else conflict.push({ ...r, urlSays: d.provider });
}

console.log(`companies with a job URL   ${rows.length}`);
console.log(`URL agrees with stored     ${agree.length}`);
console.log(`URL CONTRADICTS stored     ${conflict.length}`);
console.log(`URL yields UNKNOWN         ${urlUnknown.length}`);

const tally = (arr, fn) => {
  const m = new Map();
  for (const r of arr) {
    const k = fn(r);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

console.log('\n--- CONFLICTS: stored -> what the apply URL says ---');
for (const [k, n] of tally(conflict, (r) => `${r.stored} -> ${r.urlSays}`)) {
  console.log(`  ${k.padEnd(34)} ${n}`);
}

console.log('\n--- hosts detectAts does NOT handle (top 15) ---');
for (const [k, n] of tally(urlUnknown, (r) => r.host).slice(0, 15)) {
  console.log(`  ${k.padEnd(48)} ${n}`);
}

console.log('\n--- example conflicts ---');
for (const r of conflict.slice(0, 10)) {
  console.log(
    `  ${r.name.slice(0, 22).padEnd(23)} stored=${r.stored.padEnd(9)} url=${r.urlSays.padEnd(9)} ${r.url.slice(0, 46)}`,
  );
}
