# Caching and roll-ups

Two changes to the same problem: every API request reached MySQL, and the
dashboards recomputed months of counts from raw events on each page load.
Measured on 14 November 2026 against a generated dataset.

> **Version caveat.** Measured on MySQL 9.6.0 locally; production is MySQL 8.0
> on RDS, on a 2 GB t4g.small that also runs the AI service. The *ratios* below
> should hold; the absolute milliseconds are a fast laptop with a warm buffer
> pool and will be worse in production, which makes the case stronger rather
> than weaker.

---

## Part 1 — The dashboards read the roll-up

`analytics_daily_snapshots` has been written nightly since V3 §29 and **nothing
read it**. `src/services/analyticsRollup.js` is the read side.

### The hard part is the window, not the sum

A roll-up row covers a calendar day. A dashboard window does not — `resolveRange`
builds `to = now` and `from = now - N days`, so both ends land mid-day. Summing
whole snapshot rows for such a window counts the hours before `from` and loses
the hours after the last complete day: wrong by up to two days of traffic, and
entirely plausible-looking.

So every window is split:

```
from                                                              to
 |<-- raw -->|<------------- snapshots ------------>|<-- raw -->|
 |  partial  |         whole days, covered          |  partial  |
```

The right-hand segment starts after the last day the roll-up **actually**
covers, read from the table as a watermark rather than assumed to be yesterday.
If the job has not run for a week, a week of raw events is read and the answer
stays correct. If it has never run, everything comes from raw and the module is
a transparent wrapper. That is what makes it safe to deploy before any
backfill, and self-healing when the job fails.

### Verified

A 1-lakh-user dataset — 500 customers, 5 shops, 10 branches, 50 offers,
146,000 events across 120 days at irregular times of day — backfilled into
5,620 snapshot rows, then **48 combinations** compared: 8 window shapes
(7/30/90/365-day with mid-day ends, whole days, a single day, inside one day,
today only) × 6 scopes (all shops, one shop, shop+category, offer type, one
offer, branch reach).

**All 48 identical** to the same figures computed straight from raw events.

| window | raw | roll-up | |
|---|---|---|---|
| 30 days | 48 ms | 31.6 ms | 1.5× |
| 90 days | 85.9 ms | 30.3 ms | 2.8× |
| 365 days | 90.7 ms | 36.4 ms | 2.5× |

The ratio is not the point. The point is that the roll-up is **flat** — about
30 ms whatever the window — because it grows with days × offers, while raw
grows with event volume. At this dataset's size the difference is 2×; at a
year of real traffic it is the difference between a dashboard and a timeout.

The window arithmetic is tested as a **tiling invariant**: for 35
window × watermark combinations the segments must be contiguous to the
millisecond and cover the window exactly. Both classic failures were then
introduced deliberately to confirm the tests catch them — dropping the partial
first day (3 failures) and re-reading the boundary day (4 failures).

### Two timezone bugs found doing this

`db/pool.js` pins every connection's session time zone to `+00:00`, so
`DATE(created_at)` groups by **UTC** days.

1. **The reader computed day boundaries in local time.** In Asia/Kolkata that
   put them 5.5 hours from the roll-up's — a 5.5-hour gap at one end of the
   window and the same overlap at the other. The first equivalence run had 32
   of 48 combinations wrong, with totals that looked reasonable because the
   errors cancelled between event types. Everything is UTC now.
2. **The job labelled days in local time, and it was pre-existing.**
   `analytics-snapshots` runs at 00:20 *local*, which in Asia/Kolkata is 18:50
   UTC the previous day — so "local yesterday" was a UTC day with five hours
   still to run. The job rolled up a partial day, labelled it final and never
   returned to it. `toDateString` and `defaultDay` are UTC now, and
   `coverageDay` independently refuses to trust a day that is not over, so
   neither side depends on the other being right.

### Four more dashboards converted, and what the comparison found

`funnel`, `offerPerformance`, `overviewAlerts` and `offerComparison` now read
the roll-up too. `offerPerformance` was the expensive one: **seven correlated
scalar subqueries per offer**, each its own scan of `offer_views`, `favorites`
or `offer_claims`. It is now one grouped read of the roll-up's per-offer rows
plus one read of `offers` for metadata.

Verified by running the pre-conversion module and the new one side by side
against the same database — 100,000 events over 100 days, 40 offers — across
3 ranges × 5 filter sets × 2 scopes:

| | |
|---|---|
| Every KPI, total, timeline point, and which alerts fire | **identical** |
| Offer table sorted by views, claims, redemptions, saves, newest | **identical** |
| Offer table sorted by **conversion** | differs in 4 of 30 — see below |

**The conversion sort is a fix, not a regression.** The old query ordered
`claims DESC` in SQL, applied `LIMIT 20`, and only then re-sorted those twenty
by conversion rate — so an offer with excellent conversion but few claims never
reached the list it was supposed to top. The new code sorts the whole scoped
set by conversion and then limits, which is what `sort=conversion` means.

**Two ties were being broken by the optimiser.** On seeded data Monday and
Thursday both had exactly 431 views, and several offers had identical counts.
`ORDER BY … LIMIT 1` promises nothing in that case, so the "busiest weekday"
alert and the offer table's order could legitimately change between two loads
of identical data. Both now break ties explicitly — weekday order, and offer
id — which is why the comparison still shows a difference there: the old side
was arbitrary, the new one is not.

### What is still raw, and why

Three things a daily roll-up cannot answer, all left on raw events
deliberately:

- **city breakdowns** (`locationInsights`, the `top-location` alert) — the
  snapshot has no city dimension;
- **radius and distance analysis** — needs each event's own coordinates;
- **hour-of-day** (`bestTimeToPost`) — a daily row has no hours in it;
- **distinct customers over a window** — daily distinct counts cannot be added
  up. Most of these already read `shop_customers`, which is not an event table
  and so not affected by retention at all.

All of them read `offer_views` or `analytics_events`, which is why those two
tables keep 400 days. At 314 and 503 bytes a row they are not what the storage
bill was made of — see `docs/analytics-retention.md` §1a.

---

## Part 2 — A cache in front of MySQL

Nothing sat between the API and the database. `CACHE_PUBLIC_MAX_AGE` only ever
emitted `Cache-Control` headers, and CloudFront fronts the image bucket, not
`/api`.

### It reuses the existing security boundary

`middleware/cachePolicy.js` already decides which responses are identical for
every anonymous visitor, and it was written for a security property — §26's
*"never allow cached user-specific responses to be exposed to another
customer"*. The server-side cache calls the same `isPublicPath` and applies the
same no-bearer-token test.

That is deliberate. A cache with its own notion of "public" will eventually
disagree with the headers, and that failure presents as one customer's data
served to another. One list, one file, both read it.

Never cached: anything with an `Authorization` header, anything but `GET`, any
path off the public list, any non-200, and any response that set a cookie.

### Verified end to end

| | |
|---|---|
| First request | `X-Cache: MISS`, **2 MySQL statements** |
| Next five | `X-Cache: HIT`, **0 MySQL statements** |
| Body on hit vs miss | byte-identical (4,830 bytes) |
| Request with a bearer token | no `X-Cache` header at all, `Cache-Control: private, no-store` |
| `?a=1&b=2` vs `?b=2&a=1` | one key |
| A write that failed (401) | did **not** invalidate |
| Latency | 6.2 ms → 3.4 ms median |

The latency number is the least interesting one. **Zero database statements on
a hit** is the one that matters: a hit consumes none of the ten pooled
connections, which is the actual constraint.

### Design decisions worth knowing

- **Fail-open, time-boxed.** Every operation is raced against a 150 ms timeout.
  A Redis that is down, slow or mid-failover makes the cache a no-op that logs;
  it never throws into a request and never holds one open. A driver that throws
  on every call and one that never answers are both tested.
- **`enableOfflineQueue: false`.** ioredis queues commands while disconnected
  and replays them on reconnect. For a cache that is exactly wrong: a command
  that cannot run now is worthless later, and queueing turns a Redis outage
  into growing memory and latency inside the API process.
- **Invalidation is a counter bump, not a key sweep.** `KEYS` is O(keyspace)
  and blocks Redis's single thread; `SCAN` is merely slow. Each namespace's
  version is part of its keys, so one `INCR` retires all of them and they
  expire on their own. Cheap enough to do on every write.
- **Counters are reloaded at startup.** Otherwise a restart resets the
  in-process mirror to zero and begins serving keys an earlier invalidation had
  retired.
- **Single flight.** One in-flight load per key per process: 25 concurrent
  callers on a cold key run the loader once. Without it, a cache is a liability
  exactly when it is needed.
- **Invalidation is central, not per-service.** A dozen `cache.invalidate`
  calls scattered through the write paths is a dozen chances to add the
  thirteenth route and forget — and the symptom is a merchant publishing an
  offer customers cannot see. One middleware, gated on a 2xx and on a prefix
  list that lives next to the public-path list.
- **The key carries the app version**, so a deploy cannot serve a payload
  shaped by the previous release.
- **`/health` says `none` | `ready` | `unavailable` and nothing more.** That
  endpoint is unauthenticated; hit rates and key counts go to the logs.

### Configuration

Nothing changes until `REDIS_URL` is set — `CACHE_DRIVER` defaults to `auto`,
which means Redis when a URL is present and **no cache at all** otherwise. So
development and the test suite need no Redis, and production gets one by
setting a single variable.

`CACHE_DRIVER=memory` is a deliberate third option: a bounded in-process map,
correct on a deployment that runs **one** API process and wrong on one that
runs several, since each would have its own copy. It is what the capacity
review's "add clustering" step has to replace, not something to grow into.

---

## What is still outstanding

From the same capacity review, and none of it addressed here:

- the API is a **single Node process** with no clustering, on a 2 GB t4g.small
  shared with the AI service;
- `DB_CONNECTION_LIMIT` defaults to **10** with `queueLimit: 0`, so a spike
  queues rather than failing fast — the cache reduces how often that is
  reached, it does not raise the ceiling;
- the rate limiter's in-process `MemoryStore` must be replaced **before** a
  second process is added, not after. Redis is now available to it;
- geocoding still points at Nominatim's public instance at ~1 request/second;
- raw analytics retention is still 400 days, for the reasons in Part 1.
