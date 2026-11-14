# Branch admins and branch completeness — release runbook

What this release changes in the database, the order it has to go out in, and
what was actually verified rather than assumed.

Rehearsed on 14 November 2026 against a throwaway MySQL server built from the
**pre-change** schema (commit `b209608`), seeded with the same seeder, and then
upgraded. The claims in §3 are observations from that rehearsal.

> **Version caveat.** The rehearsal ran on MySQL 9.6.0 locally, because the
> Docker daemon on the development machine was returning 500 on every API call
> and no 8.x server could be started. Production is MySQL 8.0 on RDS. For three
> additive `ALTER TABLE ... ADD COLUMN` statements guarded by
> `information_schema` lookups the two behave identically, but this rehearsal is
> one version further from production than the last one was.

---

## 1. The order matters, for the same reason as last time

**Migrate first. Then push.** Pushing `main` *is* the deploy — `.github/workflows/deploy.yml`
fires on it — and the workflow deliberately does not run migrations.

Deploying before the migration is an **outage, not a degradation**.
`accessControl.loadAccessContext` now selects `sm.is_branch_restricted`, and the
auth middleware calls it on *every authenticated request*. Against a database
without that column, every signed-in request fails — not merely branch editing.

There is no reverse dependency: the migration is safe to run against the
currently deployed code, which never mentions the new columns. Migrating early
is free; migrating late is an outage.

The server can only run the migration it has, and the new one arrives with the
deploy, so "migrate on the server, then push" cannot work. Run it from a
developer checkout over an SSH tunnel first:

```bash
# 1. Borrow the API server's network position. RDS is VPC-private, so the
#    connection arrives from 172.31.x and matches the grant.
ssh -f -N -L 13306:<rds-endpoint>:3306 offersoffer
```

```bash
# 2. Migrate from the checkout that HAS the new migration. Every DB_* value is
#    explicit so nothing falls back to the developer's own .env.
cd TOY-backend
read -rsp "offers_migrate_prod password: " MIGPW && echo
DB_HOST=127.0.0.1 DB_PORT=13306 DB_NAME=offers_production \
DB_USER=offers_migrate_prod DB_PASSWORD="$MIGPW" node src/db/migrate.js
unset MIGPW
```

```bash
# 3. Close the tunnel.
pkill -f "13306:<rds-endpoint>"
```

Expected output, and the only acceptable output:

```
Applied 75 statements to `offers_production`.
Patched existing tables: shop_members.is_branch_restricted,
  shop_branches.contact_person_name, shop_branches.contact_person_email.
```

Then push, backend before web:

```bash
git -C TOY-backend push origin main      # deploys the API
```

```bash
git -C TOY-frontend push origin main     # deploys the web app
```

Backend first is not arbitrary. No request schema calls `.strict()`, so a web
app that sends `contactPersonName` or `branchRestricted` to the old API has
those fields **silently dropped** rather than rejected — the merchant would fill
in a contact person, see it save, and find it blank. That is worse than an
error, and ordering the two pushes avoids it entirely.

`NODE_ENV` stays unset for the migration: it keeps `productionGuard` out of the
way, which exists to stop the *application* booting on wrong credentials and
has nothing useful to say about a migration pointed at production on purpose.

---

## 2. What the migration does

Three columns. No new tables, no new permissions, no seeded rows.

| Change | Effect on existing rows |
|---|---|
| `shop_members.is_branch_restricted` TINYINT(1) NOT NULL DEFAULT 0 | **0** — attached to a branch, not confined to it |
| `shop_branches.contact_person_name` VARCHAR(160) nullable | stays NULL |
| `shop_branches.contact_person_email` VARCHAR(190) nullable | stays NULL |

**`DEFAULT 0` is the whole design, not a convenience.** `branch_id` on
`shop_members` has meant "works here" for far longer than it has meant anything
about permissions. A release that read an existing `branch_id` as confinement
would have stripped shop-wide powers from every member attached to a branch, on
the morning it deployed, with no way for the merchant to tell what had happened.
Confinement is therefore stated, never inferred, and `shop.service.js` and
`accessControl.js` both read it as `Boolean(is_branch_restricted) && branch_id !== null`.

The seeded database contains exactly that hazard: `john@zara.com`, designation
"Store Manager", attached to branch 1. §3 records what the migration did to him.

Nothing backfills the two contact columns. `services/branchReadiness.js` decides
when their absence matters, and it only ever blocks *new* publishing, so filling
them in would be inventing contact details nobody gave us.

---

## 3. Verified on the rehearsal

**Schema.** Dumping the schema before and after the upgrade, the diff is three
lines — the three columns above and nothing else, across 75 tables.

**Data.** Dumping the data before and after, every differing line is the same
row with the new columns appended as `NULL` / `0`. No stored value changed.

**The member that mattered.** `john@zara.com`, attached to branch 1, came
through with `is_branch_restricted = 0`, and `POST /api/auth/login` against the
upgraded database reports `branchRestricted: false` for that membership. The
hazard in §2 is demonstrated harmless rather than argued harmless.

**Against a fresh install.** Every column in the upgraded database matches a
fresh install of the new schema exactly — same type, nullability, default and
**ordinal position**, checked by joining `information_schema.COLUMNS` across the
two databases for all 75 tables. The `AFTER` clauses put the columns where
`schema.sql` puts them. The only difference in the two schema dumps is
`AUTO_INCREMENT` counters, which is seed data versus empty.

**Re-running.** Three consecutive runs. Nothing changed after the first.

**The API boots on it.** The new backend started against the upgraded database,
`/health` returned `database: true`, and an authenticated request through
`loadAccessContext` succeeded and served `publishBlockers` / `readyToPublish` —
the code path that an unmigrated database would turn into a site-wide 500.

**One hazard fixed before the rehearsal, not found by it.** `contact_person_email`
was originally added in the `after` array of the `contact_person_name` patch.
`applyPatches` only runs a patch's follow-ups when the *main* column was
missing, so an upgrade interrupted between the two `ALTER`s could never have
added the second one: the re-run would see `contact_person_name`, skip the whole
patch, and leave `branchValues` writing a column that does not exist. They are
two independent patches now.

---

## 4. What merchants will notice

**Offers at an incomplete branch cannot be published.** `branchReadiness`
requires seven things of an active branch — address, city, pincode, a confirmed
pin, contact number, contact person, contact person email — and two of those
columns did not exist until this release, so **every branch in production is
unready the moment this deploys.**

Nothing goes dark. The gate is applied where an offer is published, never where
one is read:

- an offer already live against an incomplete branch **stays live**;
- a **scheduled** offer still goes live on its start date — `syncLifecycleStatuses`
  is raw SQL that does not consult the gate;
- editing a live offer's title, price or dates is **not** gated. Only publishing
  a draft, re-targeting branches, or re-activating one is;
- an `inactive` branch is never checked, which is the exit for a branch the
  merchant cannot complete.

So merchants meet the rule the next time they publish something new, which is
the intended behaviour and the same stance the seller-onboarding release took.

**The pin requirement is softer than it looks.** Both clients send
`locationConfirmed: <branch has coordinates>` when they load an existing branch,
and `shop.service.js` stamps `location_confirmed_at = NOW()` whenever that flag
arrives with coordinates. A legacy branch with geocoded coordinates therefore
clears the "confirmed map location" blocker on the merchant's **first save** of
the branch form, without them moving the pin. Web and mobile agree on this, so
it is consistent grandfathering rather than a client bug — but it means the real
new work for an existing merchant is the two contact-person fields, not the map.
If that grandfathering is not wanted, it is a product decision and a separate
change: stop the clients asserting the flag for stored coordinates.

**Self-registering sellers are seeded.** `onboarding.service.js` fills
`contact_number`, `contact_person_name` and `contact_person_email` from what the
seller already gave during registration, filling blanks only, so a manager they
chose on purpose survives a re-save. Without that, the gate would have blocked
every new seller on three fields the wizard never asks for.

---

## 5. Rollback

The code can be rolled back on its own. All three columns are additive, two are
nullable and the third defaults to 0, and only the new code reads them — the
previous release runs against the migrated schema unchanged.

Rolling the *schema* back is only safe while no member has been confined to a
branch. Once one exists, dropping `is_branch_restricted` silently promotes that
branch admin to shop-wide access, which is the failure this release exists to
prevent. In practice: roll back the code, leave the schema.

---

## 6. After deploying

1. Check `/admin/shops/:id` → Branches shows the "Offers cannot go live at this
   branch yet" warning with the missing fields named.
2. Create a member, pick a branch, tick **Restrict to this branch**, and confirm
   from that member's own session that claims, analytics and the member list all
   narrow to the one branch.
3. Confirm the toggle is **disabled** with no branch chosen — it is the value
   accessor that owns `disabled` under reactive forms, so this is the bit that
   regresses silently if the form is refactored.
4. `/redemptions/summary` returns `claimToRedemption: null` and
   `branchScoped: true` for a confined member. That is deliberate: their claim
   count and redemption count cannot be measured the same way, so the ratio is
   withheld rather than computed wrong.

---

## 7. Known gaps at this release

- **Three premium dashboards stay shop-wide** for a branch admin: customer
  retention, campaign performance, campaign ROI. Deciding a branch's share of a
  shop-wide campaign is a product question, not a scoping one. Every analytics
  response carries a `branchScope` note saying so.
- **Visibility analytics is shop-wide by design.** `visibility_events.branch_id`
  is NULL for most impressions, so there is nothing honest to filter on.
- **The mobile branch screens have never been seen on hardware.** They are
  type-checked and present in the bundle, and they ship in the unsubmitted
  versionCode 7 AAB — not in anything a merchant has.
- **Claims are scoped by the claim record, analytics by the offer set.** Two
  different rules on purpose: `offer_claims.branch_id` is written at redemption
  and NULL before it, so a claim list falls back to which branches the offer
  reaches, while aggregates are labelled rather than apportioned.
