# Self-service seller onboarding — release runbook

What this release changes in the database, the order it has to go out in, and
what was actually verified rather than assumed.

Everything below was rehearsed against a throwaway MySQL 8.4 container built
from the **pre-change** schema (commit `98ddae3`), seeded with the old seeder,
and then upgraded. The claims here are observations from that rehearsal.

---

## 1. The order matters, and the obvious order is impossible

The migration has to run **before** the code deploys. But the server can only
run the migration it has, and the new one arrives with the deploy — so
"migrate on the server, then push" cannot work for this release. It was tried
and quietly applied the *old* migration: 73 statements instead of 75, none of
the new columns.

Run the new migration from a developer checkout, over an SSH tunnel, before
pushing:

```bash
# 1. Borrow the API server's network position. RDS is VPC-private, so the
#    connection arrives from 172.31.x and matches the grant.
ssh -f -N -L 13306:<rds-endpoint>:3306 offersoffer

# 2. Migrate from the checkout that HAS the new migration. Every DB_* value is
#    explicit so nothing falls back to the developer's own .env.
cd TOY-backend
read -rsp "offers_migrate_prod password: " MIGPW && echo
DB_HOST=127.0.0.1 DB_PORT=13306 DB_NAME=offers_production \
DB_USER=offers_migrate_prod DB_PASSWORD="$MIGPW" node src/db/migrate.js
unset MIGPW

# 3. Close the tunnel, then push. The workflow deploys code only.
pkill -f "13306:<rds-endpoint>"
git push
```

`NODE_ENV` is deliberately left unset: it keeps `productionGuard` out of the
way, which exists to stop the *application* booting on wrong credentials and
has nothing useful to say about a migration pointed at production on purpose.
The connection is plain TCP — there is no TLS config in `pool.js` — so the
tunnel needs no certificate handling.

**Deploying before the migration is an outage, not a degradation.**
`accessControl.loadAccessContext` now selects `s.verification_status`, and the
auth middleware calls it on *every authenticated request*. On a database
without the column, every signed-in request fails — not merely shop creation.

There is no reverse dependency: the migration is safe to run against the old
code, because the old code ignores the new columns. Migrating early is free;
migrating late is an outage.

---

## 2. What the migration does

Seven columns on `shops`, two new tables, one new permission:

| Change | Effect on existing rows |
|---|---|
| `shops.registration_source` ENUM, nullable | stays NULL |
| `shops.verification_status` ENUM, nullable | stays NULL |
| `shops.verification_submitted_at` / `_decided_at` / `_reviewer_id` / `_reason` / `_details` | stay NULL |
| `shop_verification_documents` (new table) | — |
| `shop_claim_requests` (new table) | — |
| `REVIEW_SELLER_REGISTRATIONS` permission, granted to SUPER_ADMIN | — |

**NULL is not "pending".** It means the shop never entered review, which is
every shop that exists today. `shopVerification.blocksActivation` treats NULL
as approved-by-provenance, so nothing existing is gated. Onboarding §15
forbids backfilling these, and nothing does.

### Verified on the rehearsal

Snapshotting the database before and after the upgrade, the **only**
difference was the new permission (53 → 54, Super Admin holding it). Shops,
shop members, offers, branches, subscriptions, roles and the ADMIN role's 32
permissions were byte-identical. All three pre-existing shops stayed `active`
with NULL verification.

The upgraded schema was also diffed against a fresh install: column
definitions identical on `shops`, and the two new tables identical. Only index
*ordering* differs, which is MySQL listing them in creation order.

Running the migration three times changed nothing after the first.

---

## 3. Rollback

The code can be rolled back on its own — the columns are all nullable and the
new tables are only read by the new code, so the previous release runs against
the migrated schema unchanged.

Rolling the *schema* back is only safe while no self-service registration has
been created. Once one exists, dropping `verification_status` would leave a
shop row that nothing distinguishes from an admin-created one. In practice:
roll back the code, leave the schema.

---

## 4. After deploying

1. Grant `REVIEW_SELLER_REGISTRATIONS` to whoever will actually review. The
   migration gives it to SUPER_ADMIN only. It is deliberately **not** on the
   shop-scoped ADMIN role: a merchant holding it through a membership could
   approve their own registration.
2. Check the queue loads at `/admin/registrations`.
3. The seller entry points are `/sell/register` on web, and Profile →
   "Sell on OffersOffer" on mobile.

---

## 5. Known gaps at this release

- **Document upload for verification evidence is text-only.** GSTIN, Google
  Business link and registration number are stored in
  `shops.verification_details`; `shop_verification_documents` exists but has
  no route yet, because uploads need a private storage path and `storage.put`
  only writes to the public prefix.
- **No reviewer assignment.** §14 lists it as "if supported".
- **Email verification, not SMS OTP.** §26 asks for OTP; the product decision
  was to reuse the existing email verification rather than add an SMS path.

---

## 6. Regression pass

`scripts/` has no runner for this; it was done by hand against the upgraded
database. 31 checks covering §26: seller registration, map confirmation,
pending-shop restrictions, cross-seller isolation, private evidence, and the
existing marketplace. All passed. The backend unit suite is `npm test`.
