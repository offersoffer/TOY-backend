# Razorpay setup

How to bring merchant subscriptions live, and the order to do it in. Checked
against this repository on 11 November 2026. Razorpay revises its onboarding
and its product gating fairly often, so confirm anything marked *(confirm)*
in the dashboard rather than trusting this file.

`docs/production-env-variables.md` §5 is the authority on the variables
themselves; this file is the sequence and the reasoning.

---

## 0. When to do this

**Start the paperwork now. Do not switch it on in production until the app is
released and real merchants exist.**

Those used to be one decision. They are not any more: the Android app no longer
opens a checkout (see `docs/play-store-launch.md` §0 and the mobile commit that
removed it), so Razorpay lives entirely on the web. Google Play review cannot
see it and has no opinion about it. Nothing about the store release waits on
this.

What argues for starting now:

- Live-mode activation needs business KYC and Razorpay reviews it. That clock
  runs whatever else is happening, so starting it takes it off the critical
  path later.
- **Subscriptions** and **recurring UPI** are activations on the account, not
  defaults *(confirm)*. This codebase creates Razorpay Plans and subscriptions
  rather than one-off orders, and `/payments/config` already advertises UPI
  AutoPay — without both enabled, live calls reject.

What argues against turning it on in production yet:

- There is nobody to sell to. Every shop in production is seeded placeholder
  data until real merchants register.
- Setting `RAZORPAY_KEY_ID` *is* the switch. `/payments/config` reports
  `enabled: razorpay.isConfigured`, so the web app starts offering checkout the
  moment the key lands — live mandates, live refunds and live billing support,
  during the window when store review is already demanding attention.
- **There is one `RAZORPAY_WEBHOOK_SECRET` per deployment.** Test and live
  webhooks therefore cannot both point at the same server. Testing against
  production would mean either breaking live webhooks or testing with live
  keys, so the testing has to happen elsewhere regardless. This is what makes
  "set it up" and "turn it on" separate steps rather than a preference.

---

## 1. Account and KYC

Start today; then wait.

1. Sign up at <https://dashboard.razorpay.com>.
2. Use the **same legal entity** as the Play developer account, if that was
   registered as an organization. A name mismatch between the two creates
   friction in both reviews and is awkward to correct afterwards.
3. Submit KYC: PAN, incorporation or GST proof, a bank account in the entity's
   name, address proof.
4. Request **Subscriptions** and **recurring UPI / UPI AutoPay** on the account
   *(confirm)*. Do this while KYC is in flight rather than after it clears.

---

## 2. Test mode, locally

Nothing here touches real money, and none of it waits on KYC.

5. Dashboard → Settings → API Keys → **Generate Test Key**. Put the pair into
   `TOY-backend/.env`:

   ```
   RAZORPAY_KEY_ID=rzp_test_...
   RAZORPAY_KEY_SECRET=...
   ```

6. Check the credentials and see what the account already has:

   ```bash
   node scripts/setup-razorpay.js
   ```

   It prints the key mode, confirms the secret matches the id — a 401 here
   means it does not — and lists any Plan already carrying a `notes.plan_key`.

7. Create the two paid Plans:

   ```bash
   node scripts/setup-razorpay.js --create
   ```

   Prices come from `src/config/plans.js` (Business ₹999, Premium ₹2,500), so
   the gateway and the app cannot disagree about what a plan costs. Existing
   plans are matched on `notes.plan_key` and reused, so re-running is safe.

   > **Razorpay Plans cannot be deleted, only deactivated.** Settle the prices
   > before running this. In LIVE mode the script asks for confirmation first,
   > which is the only reason that prompt exists.

8. Copy the printed ids into `.env` and restart the backend:

   ```
   RAZORPAY_PLAN_BUSINESS=plan_...
   RAZORPAY_PLAN_PREMIUM=plan_...
   ```

9. Expose the local API so webhooks can reach it:

   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```

10. Dashboard → Settings → Webhooks → add `<tunnel-url>/api/payments/razorpay/webhook`,
    set a secret, and put it in `RAZORPAY_WEBHOOK_SECRET`.

    Subscribe to exactly what `payment.webhook.js` handles. Anything else is
    accepted and ignored:

    ```
    subscription.authenticated   subscription.activated   subscription.charged
    subscription.pending         subscription.halted      subscription.paused
    subscription.resumed         subscription.cancelled   subscription.completed
    payment.authorized           payment.captured         payment.failed
    refund.created               refund.processed
    ```

    The signature is an HMAC over the **exact bytes** Razorpay sent, so nothing
    may rewrite the body in front of this route. `app.js` keeps the raw buffer
    on `req.rawBody` through `express.json`'s `verify` hook for this one check;
    a proxy that re-serialises JSON will break it in a way that looks like a
    wrong secret.

11. Walk the lifecycle on the **web** app with Razorpay's test cards:

    - subscribe a test shop and confirm the plan stays **pending** until the
      webhook lands, and only then activates. This is the whole design — the
      client never unlocks a plan, and `subscription.service.js` says so in as
      many words — so it is the part worth watching with your own eyes;
    - a failed payment, and the grace window that follows it;
    - a cancellation, and that benefits run to the end of the paid period;
    - a refund, full and partial.

    A handler that throws still answers 200 and records the error, because a
    500 would make Razorpay redeliver an event already stored. So check
    `payment_webhooks` rather than the HTTP status when something looks wrong.

---

## 3. Going live

Only after the app is released and real merchants are registering.

12. Generate live keys. Run `node scripts/setup-razorpay.js --create` again
    against them — live Plans are separate objects from test Plans and have
    different ids.
13. Set all five variables in `.env.production`, then restart:

    ```
    RAZORPAY_KEY_ID  RAZORPAY_KEY_SECRET  RAZORPAY_WEBHOOK_SECRET
    RAZORPAY_PLAN_BUSINESS  RAZORPAY_PLAN_PREMIUM
    ```

14. Point the live webhook at the production API **only**:
    `https://offersoffer.in/api/payments/razorpay/webhook`.

15. **`RAZORPAY_WEBHOOK_SECRET` is the one that will bite.** Missing, the
    webhook answers 503 and no subscription ever activates: merchants pay and
    receive nothing, and the only symptom is plans stuck pending. Confirm a
    real event reaches the server before announcing anything.

---

## 4. What going live obliges elsewhere

Two statements in the product become false the day payments go live, and
neither is in this repository's backend.

- **`src/content/support.ts` in the mobile app** says: *"Payment providers are
  not on this list because payments are not live yet. This section will be
  updated before they are."* That text is bundled into the binary, so
  correcting it needs an app release. It is accurate today, which is one more
  reason to ship the app before flipping payments on — but it has to be fixed
  in the release that follows.
- The equivalent copy on the website, wherever the sub-processor list lives.

The Play **Data safety** form does not need a financial-information
declaration on account of this: payments happen on the web, and the app neither
collects nor transmits payment details. That stays true only while the app has
no checkout — if one is ever added through Play billing, the form changes with
it.

---

## 5. What is already built

So that none of it gets rebuilt by mistake:

```
[x] Plan catalogue and entitlements, priced from src/config/plans.js
[x] Checkout, verification and the webhook, with HMAC signature checking
[x] Every subscription event handled, deduplicated on x-razorpay-event-id
[x] payment_webhooks stores each payload for replay
[x] Grace windows, past-due handling, downgrade and cancel
[x] Billing history and invoices, on web and mobile
[x] scripts/setup-razorpay.js provisions and reconciles the Plans
[ ] A Razorpay account, KYC, and the five production variables
```

The only missing pieces are the account and the credentials.
