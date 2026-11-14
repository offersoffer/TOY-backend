# Analytics retention and partitioning

Why the event tables needed this, what was measured, and what it costs.

Rehearsed on 14 November 2026 against throwaway MySQL servers built from both
the pre-change schema and a fresh one. Every number below is an observation.

> **Version caveat.** The rehearsals ran on MySQL 9.6.0 locally; production is
> MySQL 8.0 on RDS. Partitioning, `REORGANIZE PARTITION` and error 1506 behave
> the same on both, but this is one major version away from production.

---

## 1. The measurement that started it

Nothing pruned the event tables. The nightly `prune` job swept tokens, read
notifications, the failure log and settled idempotency keys, and left
`visibility_events`, `analytics_events`, `offer_views` and `search_history` to
grow forever.

Generated a 1-lakh-user dataset — 100,000 users, 1,000 shops, 2,000 branches,
10,000 offers — and drove the real impression path:

| | |
|---|---|
| Feed impression batch (20 rows, real `visibilityEvents.record`) | 3.7 ms |
| Impression write throughput | ~5,400 rows/sec |
| `visibility_events` at 1M rows | **297 MB data + 593 MB index = 890 MB** |

**About 890 bytes a row**, and the indexes cost twice what the data does,
because the table carries eight secondary indexes so the dashboards can be
fast. At 600,000 impressions a day that is ~480 MB a day, ~14 GB a month, and
none of it ever came back.

Writes were never the problem: 5,400 rows/sec against a need of single-digit
rows/sec is enormous headroom. Storage was the problem.

**`search_history` turned out not to need this.**
`recommendations.rememberSearch` already trims each user to their 20 most
recent terms on every insert, so it is bounded by user count rather than time.
It is deliberately out of scope.

---

## 1a. Retention is per table, because the tables are not alike

One number for all three was forcing the worst case onto the cheapest tables.
Measured on disk, 200,000 rows loaded into each:

| table | bytes/row | secondary indexes | gets a row when |
|---|---|---|---|
| `visibility_events` | **1,094** | 8 | every impression — about 20 per feed render |
| `analytics_events` | 503 | 8 | a tracked action happens |
| `offer_views` | 314 | 5 | somebody opens an offer |

`visibility_events` is the storage problem almost on its own: three and a half
times the row cost *and* one to two orders of magnitude more rows. Its only
long-window reader was the merchant visibility dashboard — everything else that
touches it (ranking, fairness, frequency caps, anti-manipulation) works in
hours.

So the horizons are now set per table, each against the window its own readers
accept:

| table | retention | max query window | pruned by |
|---|---|---|---|
| `visibility_events` | **90 days** | 60 days | DROP PARTITION |
| `analytics_events` | 400 days | 365 days | batched DELETE |
| `offer_views` | 400 days | 365 days | batched DELETE |

`assertHorizonsAreServable` refuses to boot if any table's retention cannot
answer its own routes, so neither number can move without the other noticing.

**Projected effect**, from the measured bytes/row against the traffic model in
§1 (600,000 impressions, 60,000 actions and 30,000 offer opens a day):

| | 400 days everywhere | per-table |
|---|---|---|
| `visibility_events` | 245 GB | **55 GB** |
| `analytics_events` | 11 GB | 11 GB |
| `offer_views` | 4 GB | 4 GB |
| total | 259 GB | **70 GB** (73% less) |

A projection, not a measurement: the bytes/row are measured, the row counts are
the model.

The cost is that the visibility dashboards — impressions by surface, average
position, featured versus organic — now reach back 60 days instead of 365.
Headline KPIs and trends are unaffected; they come from the daily roll-up and
still cover a year.

---

## 2. The rule that keeps retention honest

Retention must be **longer than the longest window the API will serve**, or a
twelve-month chart is complete for eleven months and confidently zero for the
twelfth — a deleted number presented as a measured one.

`config/analyticsRetention.js` holds both numbers so neither can move alone:

- `MAX_QUERY_DAYS = 365`, which the dashboards now validate `days` against
  instead of each hardcoding `.max(365)`;
- `ANALYTICS_RETENTION_DAYS`, default **400**, and
  `assertWindowIsServable` **refuses to boot** on anything below
  `MAX_QUERY_DAYS + 30`.

Two consequences worth knowing:

- A custom `from`/`to` older than the horizon is now a **400 with the earliest
  available date**, not an empty chart. `days` is capped below any legal
  retention, so only an explicit range can reach that far.
- The branch view counter on `/analytics/shops/:shopId` was an **all-time**
  `COUNT(*)` over `offer_views` with no date filter. Left alone it would have
  quietly become "views since whenever the prune job last caught up" while
  still presenting as a total. It is now bounded by the retention window —
  the same figure as before for any shop younger than the horizon.

---

## 3. Deleting rows: `analytics_events`, `offer_views`

A nightly `analytics-retention` job at **04:15**, deliberately separate from
`prune` at 03:30 and clear of `analytics-snapshots` at 00:20 — rolling up
yesterday's events before deleting anything is the only order in which both are
correct.

It deletes in **2,000-row batches** under a **1,000,000-row per-table budget**.
Batching keeps each transaction short enough that dashboard readers interleave;
the budget means a job that has not run for a month removes what it can, logs
the backlog, and continues the next night instead of stalling the database.

Measured on 60,000 rows (40,000 of them expired): **~31,000 rows/sec**, the
budget honoured exactly, the backlog reported, every expired row gone and every
recent row untouched. A caught-up run is a single statement.

### One bug this found that the unit tests could not

`DELETE ... ORDER BY created_at LIMIT ?` **fails** against a real server:
*"Incorrect arguments to mysqld_stmt_execute"*. MySQL's prepared-statement
protocol takes no placeholder for `LIMIT` here. Every mocked test passed; it
only appeared on the first real run. `LIMIT` is now interpolated from a
forced non-negative integer that never comes from a request, and the test's
fake pool reads the limit back out of the SQL so it fails if that ever
silently becomes a placeholder again.

---

## 4. Dropping partitions: `visibility_events`

This one table is most of the problem, so it is partitioned by month and its
retention is a `DROP PARTITION`. Measured on the same million rows, before and
after conversion:

| | unpartitioned | monthly partitions |
|---|---|---|
| remove a month of old rows | ~2.3 s (batched DELETE) | **0.11 s** |
| surface breakdown, 30 days | 217 ms | **51 ms** |
| one shop, 30 days | 1.6 ms | 1.0 ms |
| one shop, **365 days** | 1.2 ms | **2.1 ms** |
| batched DELETE, if used anyway | 31,000 rows/s | **4,585 rows/s** |

The long per-shop window got **slower**: a year spans thirteen partitions and
thirteen index trees instead of one. That is the real trade, and it is worth
taking — the queries that got faster are the ones that were slow, and
`EXPLAIN` confirms a 30-day dashboard query now touches 2 partitions of 11.

The last row is why the two mechanisms are mutually exclusive: deleting rows
from a partitioned table is **seven times worse** than from a plain one,
because every statement has to consider every partition. `EVENT_TABLES` and
`PARTITIONED_TABLES` are separate lists and a test asserts they are disjoint.

Maintenance runs in the same nightly job: create the current month and two
ahead (splitting an **empty** catch-all costs 0.25 s; splitting an occupied one
rewrites rows), then drop every partition whose **upper** bound is past the
horizon — so the month a merchant can still ask about is never dropped for the
sake of its oldest day. Data therefore lives up to a month longer than
retention, never less.

---

## 5. What partitioning cost

InnoDB refuses outright: **"Foreign keys are not yet supported in conjunction
with partitioning"** (error 1506). All six of this table's foreign keys had to
go, and the primary key became `(id, created_at)` because every unique key must
contain every partitioning column.

| Dropped key | What it did | Replacement |
|---|---|---|
| `fk_ve_user` SET NULL | anonymised a deleted account's rows | **explicit `scrubUser` in the account-deletion path** |
| `fk_ve_shop` CASCADE | deleted a deleted shop's rows | left to age out with retention |
| branch / category / campaign / slot SET NULL | unjoined the row | left to age out with retention |

**The user one is not housekeeping.** `DELETE FROM users` relied entirely on
InnoDB cascades — the route said so in as many words: *"One statement; InnoDB
applies every cascade atomically."* Without a replacement, deleting an account
would have stopped anonymising that person's browsing, which is a broken
promise and a Play Store data-safety problem. It is now an explicit `UPDATE`
before the `DELETE`, indexed by `idx_ve_user_listing`, and it is **not
best-effort**: a failure fails the request. Verified live with no foreign key
present — 225 rows anonymised, user row gone, zero dangling user ids anywhere
in the table — and a test asserts the route still calls it, before the delete.

Leaving the other five to age out is deliberate: a shop with a year of
impressions would otherwise turn an admin's delete button into a
multi-million-row `DELETE`, and the rows are unreachable anyway because every
read is scoped to a shop the caller can still see, and MySQL never reissues an
`AUTO_INCREMENT` id.

---

## 6. Deploying it

**Do this before real traffic arrives.** `ALTER TABLE ... PARTITION BY`
rewrites the table and blocks writes to it: measured at **2 minutes 44 seconds
for a million rows**. Production holds seeded placeholder data today, so the
conversion is near-instant now and hours later.

Same order as every other release here — migrate first, then push:

```bash
# Opens the tunnel, reads DB_HOST off the server, validates it is actually a
# hostname, and refuses to proceed unless MySQL answers down the forward.
# See the header of that script for the three ways a hand-written one-liner
# produced a tunnel that looked fine and went nowhere.
scripts/prod-tunnel.sh
```

```bash
cd TOY-backend
printf 'offers_migrate_prod password: ' && read -rs MIGPW && echo
DB_HOST=127.0.0.1 DB_PORT=13306 DB_NAME=offers_production \
DB_USER=offers_migrate_prod DB_PASSWORD="$MIGPW" node src/db/migrate.js
unset MIGPW
```

**`node` must be 22.** A plain login shell on the developer machine resolves
`node` to whatever nvm's default is - v18.12.1 at the time of writing - and the
migration will fail on syntax before it reaches the database. Prefix the command
above, or run `nvm use 22` first:

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
```

Expect two new patches to report:
`visibility_events is partitioned by month` and, on a fresh database,
`visibility_events has its current and next partitions`.

The migration is safe against the running code: the old code neither knows nor
cares that the table is partitioned, and it never relied on the foreign keys in
application logic. The **new** code must not run against an unpartitioned
table any longer than necessary, but it degrades rather than breaks —
`analyticsRetention.run` detects an unpartitioned `visibility_events` and
prunes it by deletion instead, logging `ANALYTICS_RETENTION_FALLBACK`.

### Verified on the rehearsals

- **Fresh install**: table created partitioned, PK `(id, created_at)`, 0
  foreign keys, current month plus two ahead plus the catch-all.
- **Conversion with 13 months of history**: 6 foreign keys dropped, PK
  extended, 30,000 rows preserved and bucketed into 14 monthly partitions.
- **A half-applied conversion recovered.** The first attempt failed with 1506
  having already rewritten the primary key, because `applyPatches` passed
  `dbName` to a patch's `check` but **not** to its `run` — the foreign-key
  lookup matched nothing and the loop dropped nothing. The patch now reads
  `DATABASE()` instead of trusting an argument, the runner passes `dbName` to
  `run` as well, and re-running the migration over the half-converted database
  completed it correctly.
- **Write path**: a page of 20 impressions still records in 31 ms and lands in
  the current month's partition.
- **Retention**: `dropExpiredPartitions(200)` removed 6 partitions and 12,900
  rows in 289 ms; oldest surviving data was correctly the month containing the
  horizon.

---

## 7. What this does not fix

Bounding growth is not the same as making the dashboards cheap. At 400 days
`visibility_events` still settles at roughly 190 GB for the traffic modelled in
§1.

The roll-up half of that is now done — see `docs/caching-and-rollups.md`. The
KPI cards and the overview timeline read `analytics_daily_snapshots` for the
whole days inside a window and raw events only for the partial days at each
end, verified identical to the raw figures across 48 window/filter
combinations.

**It does not yet let retention drop.** Several readers still need the raw
tables over a full window — `/analytics/locations`, `/analytics/categories`,
`premium.locationInsights`, `radiusAnalysis`, `customerInsights`, `acquisition`
and `offerPerformance` — and some ask what the snapshot cannot answer: city and
category breakdowns, and distinct-customer counts, which cannot be summed
across days. Until those are converted, `MAX_QUERY_DAYS` stays at 365 and
retention at 400.

Still outstanding from the same review, and none of it addressed here: the API
runs as a single Node process with no clustering on a 2 GB t4g.small shared
with the AI service; there is no cache in front of MySQL, so every feed render
hits the database with `DB_CONNECTION_LIMIT` defaulting to 10 and
`queueLimit: 0`; the rate limiter's in-process `MemoryStore` has to be replaced
*before* a second process is added, not after; and geocoding still points at
Nominatim's public instance at roughly one request a second.
