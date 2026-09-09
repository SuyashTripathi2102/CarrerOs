# Gmail job-alert connector — DESIGN ONLY (2026-09-09)

> **Nothing here is implemented.** This is a proposal for review. Delhi
> extraction continues untouched; matching, scoring, the collector, the renderer
> and Adzuna remain frozen.

Phase 1's own problem statement: *"supply is 70% Senior/Lead/Staff and
US-startup-shaped. Junior Indian roles live on channels we don't touch."* Gmail
is the sanctioned route to those channels — ADR-8 permits LinkedIn **via email
alerts only**, and the same mechanism reaches Naukri and Indeed later without a
new access strategy for each.

## The one structural claim

**This is an adapter, not an architecture.** `crawl-board.processor.ts` already
holds a registry:

```ts
const BOARDS = {
  remoteok: fetchRemoteOkJobs,
  'hn-hiring': fetchHnWhoIsHiring,
  adzuna: fetchAdzunaJobs,
  jooble: fetchJoobleJobs,
  freehire: fetchFreehireJobs,
} as const;
```

Every entry is `() => Promise<BoardJob[]>`, handed to
`api.ingestBoardJobs(board, entries)` — the single path through validate →
fingerprint dedup → ingest → embed → gate → score → surface.

**Gmail adds one key: `'linkedin-alerts': fetchLinkedInAlertJobs`.** Nothing
downstream changes. If the design ever requires touching ingest, dedup,
embedding or scoring, it is wrong and should be rejected.

## Three separable layers

```
LAYER 1  Gmail infrastructure     OAuth, tokens, polling, checkpoint, dedup
LAYER 2  Per-sender parsers       LinkedIn only in v1
LAYER 3  Existing CareerOS        BoardJob -> unchanged pipeline
```

Layer 1 is built once. Layer 2 is where Naukri and Indeed later plug in. Layer 3
is not modified.

---

## 1. Authentication

**Gmail API + OAuth 2.0. Not IMAP + app password.**

| | scope | why |
|---|---|---|
| requested | `gmail.readonly` | read messages, nothing else |
| NOT requested | `gmail.modify`, `gmail.send`, `gmail.labels`, full `mail.google.com` | the feature never writes, sends, labels or deletes |

Minimum-scope is not decoration: a read-only scope is materially easier to get
through Google's verification, and it makes "the connector cannot damage the
user's mailbox" a property of the grant rather than a promise in a code review.

**Token lifecycle**

```
consent -> authorization code -> exchange -> access_token (~1h) + refresh_token
                                                    |
                          store refresh_token, discard access tokens on expiry
                                                    |
                          refresh on demand; never persist access tokens
```

**Storage — a new table, not a column on `users`.** The existing `users` table
holds `passwordHash` and nothing third-party; mixing an external provider's
credentials into it conflates two secrets with different rotation and revocation
rules.

```
gmail_connections
  id, userId (FK), emailAddress,
  refreshTokenEnc,   -- encrypted at rest, never logged, never returned by any API
  scope, connectedAt, lastSyncAt,
  historyId,         -- incremental sync cursor (see section 2)
  status             -- ACTIVE | REVOKED | NEEDS_RECONSENT
```

A revoked or expired grant sets `status` and **stops polling loudly**. It must
never degrade into a silently empty inbox, which is this codebase's recurring
failure shape.

**Verification.** In testing mode Google allows designated test users, which is
sufficient for a single-user deployment. Public use of a Gmail scope can require
app verification. **Open decision (section 9):** whether v1 stays in testing mode
with one test user — my recommendation, since CareerOS today has exactly one
user.

## 2. Ingestion

**Incremental, never a mailbox scan.** Gmail's `users.history.list` returns only
what changed since a `historyId`. Full scans grow with mailbox size, waste quota,
and re-present the same messages forever.

```
first connect   users.messages.list  q="from:<alert sender> newer_than:30d"
                -> seed set + record current historyId

steady state    users.history.list startHistoryId=<stored>
                -> only new message ids
                -> record new historyId ONLY after the batch is durably ingested
```

**Checkpoint ordering is the correctness point.** The cursor advances *after*
ingestion succeeds, never before. A crash mid-batch then re-reads the same
messages — safe, because dedup is idempotent — whereas advancing first would
lose alerts with no error, exactly the class of bug this project keeps finding.

Gmail expires `historyId` after roughly a week. On `404 historyId not found`,
fall back to a bounded `messages.list` window and re-seed. That path must be
**logged at WARN**, not silent — an unnoticed permanent fallback is a silent full
scan.

**Identifying alerts.** Sender and subject matching, declared by each parser
rather than hardcoded centrally:

```ts
interface AlertParser {
  source: string;                    // 'linkedin-alerts'
  matches(from: string, subject: string): boolean;
  parse(html: string, meta: MessageMeta): BoardJob[];
}
```

**Deduplication, three layers, none of them new:**

1. `gmail_messages_seen(messageId)` — a message is parsed once, ever.
2. `BoardJob.job.externalId` — stable per posting, so the same job in Monday's
   and Tuesday's digest is one job.
3. The existing company + fingerprint dedup — already handles the same posting
   arriving from LinkedIn *and* Greenhouse. **No new dedup logic is written.**

## 3. First source: LinkedIn only

One parser, end to end, measured — before writing Naukri and Indeed on
speculation. If LinkedIn alerts yield nothing for this profile, that is worth
knowing before building three more parsers.

Naukri and Indeed are **interface conformance only** in this design: they will
implement `AlertParser`. No parsing logic for them is designed here.

## 4. Parsing

**Deterministic HTML, no LLM in v1.** Per the extraction tier order, LLM is the
last resort. Alert emails are templated; if the deterministic parser proves
insufficient *and that is measured*, an LLM tier can be argued for then.

| field | source | if missing |
|---|---|---|
| `title` | anchor text | **reject the entry** — a job without a title is not a job |
| `company` | adjacent element | **reject** — `BoardJobSchema` requires `company.name` |
| `url` | anchor href, tracking params stripped | **reject** — needed for dedup and apply |
| `location` | adjacent element | `null` — normalised downstream by `normalizeCountry` |
| `postedAt` | relative text ("2 days ago") | `null`, **never "now"** — a guessed date scores maximally fresh, the `freshness` latent bug already recorded in the roadmap |
| `description` | **absent from alert emails** | `descriptionSource: 'MISSING'` |

**`descriptionSource: 'MISSING'` is the critical field.** Alert emails carry no
job body. The `INSUFFICIENT_EVIDENCE` gate then holds these instead of judging
them blind — the exact protection built after 6,907 jobs were refused
`NOT_DEVELOPMENT` for descriptions nobody had.

**This has a consequence that must be designed for, not discovered:** a LinkedIn
alert job cannot be judged from the email alone. Either it is enriched by
following the URL — and **ADR-8 forbids fetching LinkedIn job pages** — or it
surfaces as a *lead* rather than a scored opportunity. **Open decision
(section 9).**

**Evidence preserved.** `NormalizedJob.raw` carries the message id and the
extracted fragment, so a parser change can be replayed against stored evidence
rather than re-fetched — the same pattern as `extraction_snapshots`.

## 5. Normalization

Reuses, unchanged:

- `BoardJobSchema` / `NormalizedJobSchema` validation
- `api.ingestBoardJobs(source, entries)`
- company creation, `atsHintUrl` ATS detection, fingerprint dedup
- `normalizeCountry` at the ingest choke point
- embed, retrieval, gate, score, surface

**No second job representation. No parallel ingest. No new dedup.**

## 6. Reliability

| failure | behaviour |
|---|---|
| OAuth expired or revoked | `status=NEEDS_RECONSENT`, polling stops, logged WARN. Never a silent empty inbox. |
| Gmail 429 / quota | exponential backoff; cursor not advanced |
| `historyId` expired (404) | bounded re-seed, logged WARN |
| parser returns 0 for a known-alert message | recorded with the message id; 0 is a measurement, not a success |
| partial batch crash | cursor unadvanced, messages re-read, dedup absorbs it |
| duplicate delivery | `gmail_messages_seen` |

**Observability.** Per run: messages scanned, alerts matched, jobs parsed, parse
failures, new after dedup. A run that matches messages but parses zero jobs must
be **loud** — that is the template-changed failure, and it looks exactly like a
quiet week.

**Backfill.** First connect seeds `newer_than:30d`, bounded. No unbounded
historical sweep.

## 7. Measurement — the controlled first experiment

Against the frozen Phase 0 baseline (1,541 India jobs/day, ~60 APPLY, 50
surfaceable), reported as a full funnel:

```
messages scanned
  -> LinkedIn alerts matched
  -> jobs parsed
  -> valid URLs
  -> normalized BoardJobs
  -> new after dedup          <- the incremental number that matters
  -> India / remote
  -> SWE
  -> <=3 YOE
  -> eligible
  -> APPLY
  -> surfaceable
```

**The number that decides it is `new after dedup` then `APPLY`.** LinkedIn
aggregates postings that may already arrive via Greenhouse, Lever or freehire;
raw alert count is a vanity metric. Gmail API cost is effectively zero at this
volume, so unlike Adzuna this is not a spend decision — but it is still a value
decision.

## 7a. Suspicious-zero guards — DETECTION ONLY

*Added 2026-09-09 during Step 3/4 review. This is a reliability requirement
found in review, not implemented behaviour — see "current state" below.*

**The invariant.** A sync that completes successfully must not silently produce
zero downstream jobs while an upstream stage held data. Each transition in the
§7 funnel that can collapse to zero must be able to say so.

| transition | zero is suspicious when | what it means |
|---|---|---|
| messages → alerts matched | the fetch was **sender-scoped** and returned messages | `matchesLinkedInAlert` is broken, or LinkedIn changed its sender |
| alerts matched → jobs parsed | any alert matched | the email template changed |
| jobs parsed → valid BoardJobs | any job parsed | normalization or schema validation is rejecting every card |

The third is the one this connector is most likely to hit. `BoardJobSchema`
requires a company, the parser derives it from position rather than from any
labelled field, and a template that moves the company into an `<img alt>` yields
null for every card. The result is not "fewer jobs" — it is **zero**, arriving
as a clean, successful, entirely unremarkable run.

**Guard = detection. It never repairs, substitutes or fabricates.** A guard that
filled in a missing company would convert a visible template break into
permanent silent corruption. This is the same contract as the queue wedge
detector: it reports, and a human decides. Nothing in this section may write to
a job, a verdict or a cursor.

### The first rule is mode-dependent — and that is not a detail

"messages > 0 and alerts = 0 is suspicious" is correct **only for a
sender-scoped fetch**. `seedQuery` scopes SEED to
`(from:jobalerts-noreply@linkedin.com) newer_than:30d`, so scanning messages
there and matching no alerts means the sender check is broken.

INCREMENTAL mode uses Gmail's history API, which returns **all** mailbox changes
with no sender filter. Applied there, the rule fires on every ordinary day of
non-LinkedIn email. A guard that cries wolf daily is worse than no guard: it
trains the operator to ignore the one time it is real. That is how the
`UNKNOWN != LOW` class of bug survives — an alarm nobody reads.

So the rule is scoped to sender-filtered fetches. The honest incremental-mode
signal is different and is **not** specified here: a long run of zero alerts
against a known alert cadence. It needs the cadence first, which needs a
connected mailbox, which does not exist yet. Do not invent a threshold for it.

### Current state — 1 of 3 implemented

| guard | state |
|---|---|
| messages → alerts | **not implemented**, and blocked on the mode distinction above |
| alerts → parsed | implemented: `isSuspiciousOutcome`, `describeOutcome` |
| parsed → BoardJobs | **not implemented** — `SyncOutcome` carries no validity count, so this needs a new field, not just a new rule |

One existing test contradicts this section and must be split before the guards
land: `gmail-sync.spec.ts` asserts `{messagesScanned: 40, alertsMatched: 0}` is
*not* suspicious. That is right for INCREMENTAL and wrong for SEED. It becomes
two tests, one per mode.

## 8. Deliberately NOT built

- Naukri and Indeed parsers (interface only)
- LLM parsing of emails
- Fetching LinkedIn job pages to enrich descriptions — **ADR-8 red line**
- Any change to matching, scoring, dedup, embedding or the collector
- Multi-user OAuth, token sharing, or a consent UI beyond one user
- Write access to the mailbox in any form

## 9. Decisions — APPROVED 2026-09-09

| # | decision | approved |
|---|---|---|
| 1 | OAuth app mode | **Testing mode, one test user.** Verification deferred; CareerOS has one user. |
| 2 | Description problem | **Option (b): enrich ONLY when the alert URL resolves to an ATS we already crawl** (Greenhouse, Lever, Ashby). Otherwise the entry stays `descriptionSource: MISSING` and surfaces as an unjudged lead. No LinkedIn page fetching — ADR-8 holds. No fabricated descriptions. No second scoring path. |
| 3 | Token encryption | **Env-based key for v1**, provided it is a real secret, never committed and never logged. Revisit if CareerOS becomes multi-user. |
| 4 | Poll cadence | **Every 6h.** Alerts are daily/weekly digests; hourly polling would add nothing. |

**Scope approved: Steps 1–4 only.** Step 5 (wiring `linkedin-alerts` into
`BOARDS`) and Step 6 (the controlled run) require a separate review. Steps 1–4
touch nothing in production — no queue, no schedule, no ingestion path.
## 10. Implementation sequence, if approved

```
1. gmail_connections + gmail_messages_seen schema        (migration)
2. OAuth consent + token exchange + refresh              (no polling yet)
3. Incremental sync with checkpointing                   (log only, ingest nothing)
4. LinkedIn AlertParser + unit tests over saved fixtures (no live mailbox)
5. Wire 'linkedin-alerts' into BOARDS                    (one line)
6. Controlled first run, funnel measured against baseline
```

Steps 1 to 4 touch nothing in production. Step 5 is the single line that connects
it. Step 6 is the experiment.
