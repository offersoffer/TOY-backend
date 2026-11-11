# Play Store launch runbook

The order to publish the Android app in, and the two decisions that gate
everything else. Checked against this repository and against Google's own
policy pages on 11 November 2026; the testing and payments rules are exactly
the kind Google revises, so confirm both in the Console before relying on them.

A tickable copy of this lives at
<https://claude.ai/artifact/UDYEpcSJevtKEm2gvthjV3>.

---

## 0. Two decisions gate everything else

**Register as an organization, not as a personal account.** A personal
developer account created after 13 November 2023 must run a closed test with at
least **12 testers opted in continuously for 14 days** before it may even
*apply* for production access, and passing only makes it eligible — review
follows. Organization accounts are exempt. That choice is made in the first
five minutes of signup and can cost two to three weeks. An organization needs a
D-U-N-S number; obtaining one is usually still faster than the testing clock.

**The in-app Razorpay checkout is a policy problem.** `SubscriptionScreen`
opens a Razorpay hosted checkout for the BUSINESS and PREMIUM merchant plans.
Google's Payments policy has **no exemption for B2B or SaaS**: it names "cloud
software and services" and "business productivity software" as purchases that
*require* Play billing. The exemptions are physical goods, content consumable
only outside a Play-distributed app, 1:1 services, tips and similar — none of
which covers a merchant subscription.

Three ways out:

| Option | Cost |
|---|---|
| Sell subscriptions on the web only; remove the in-app route | Smallest change. The app must not *lead* users to the other payment method at all — showing the current plan is fine, a checkout button is not. |
| Adopt Google Play Billing | Largest change; Play takes its fee. |
| India's alternative billing programme | Runs *alongside* Play billing, not instead of it. Needs enrolment, PCI DSS and 24-hour transaction reporting, for a 4% fee reduction. |

The Supreme Court case on Play billing in India is unresolved and is not a safe
basis for an exemption.

Whatever is decided, **rebuild before shipping** — the current AAB still
contains the checkout path.

---

## 1. Already in place

Verified, so do not redo:

```
[x] Production AAB, versionCode 5, built from commit 9d1f81b (= mobile HEAD)
[x] https://offersoffer.in/privacy        200
[x] https://offersoffer.in/terms          200
[x] https://offersoffer.in/support        200
[x] https://offersoffer.in/delete-account 200   (Play requires this)
[x] FCM v1 service account key set on EAS
[x] CAMERA declared; RECORD_AUDIO and SYSTEM_ALERT_WINDOW blocked
[x] Backend deployed, healthy, on the current schema
```

---

## 2. Open the developer account

1. Decide organization vs personal (§0).
2. Register and pay the $25 one-off fee at
   <https://play.google.com/console/signup>.
3. Complete identity verification — government ID and address, plus the
   D-U-N-S for an organization. Nothing else can be submitted until it clears.

---

## 3. Create the app and wire up credentials

4. Create the app in the Console. The package is fixed by the build:
   `com.toy.offersapp`.
5. Accept Play App Signing (the default). Google holds the app signing key and
   the EAS keystore becomes the upload key, which is what makes a lost upload
   key recoverable.
6. Create the submission service account: Console → Setup → API access → link a
   Google Cloud project → create a service account → grant it **Release
   manager** → download the JSON key → attach it with `eas credentials -p
   android`. `googleServiceAccountKeyForSubmissions` was unset when last
   checked and cannot be created before the Console account exists; without it
   the AAB is uploaded by hand.
7. Copy the SHA-1 of the **app signing** certificate (Console → Setup → App
   integrity), not the upload certificate. The installed app is signed with the
   former, so a Maps key restricted to the latter fails only in production.
8. Restrict the Maps key in Google Cloud to Android apps with package
   `com.toy.offersapp` and that SHA-1, restrict the API to **Maps SDK for
   Android** only, and set a billing budget alert. The key ships inside the APK
   and is extractable; the package plus certificate restriction is the only
   thing protecting it.

---

## 4. Store listing

Capture the screenshots **before** clearing the screenshot seed data (§7).

9. App name (30 characters), short description (80 — this is what search
   results show), full description (4000).
10. App icon 512×512 PNG, feature graphic 1024×500, and 2–8 phone screenshots.
    Five are already captured, including the seller registration screen.
11. Category, contact email (public), website `offersoffer.in`.

---

## 5. Policy declarations

Most first submissions are rejected here.

12. Privacy policy URL — `https://offersoffer.in/privacy`.
13. **Data safety form.** Declare precise *and* approximate location, **camera**,
    personal info (name, email), app activity, and device identifiers for push.
    Camera is new since the merchant counter flow shipped, and a Data safety
    form that omits a permission the manifest declares is a straightforward
    rejection.
14. Content rating questionnaire (IARC).
15. Target audience, ads (none), and **app access**: give Google a working test
    login. Reviewers cannot reach the merchant features without one, and
    "reviewer could not access the content" is a common rejection.
16. Account deletion URL — `https://offersoffer.in/delete-account`.

---

## 6. Test on a real track

Internal testing has no tester minimum and no waiting period. Use it first.

17. `eas submit -p android --profile production`, once the service account from
    §3 is attached. Rebuild first if §0 changed the app.
18. Verify the three things never yet proven on hardware: scan a real claim QR
    at a counter, confirm a push notification arrives, and — signed in — open
    home, Near Me, search, a category and ending soon. That last path has never
    been exercised signed-in against production.
19. Closed testing, personal accounts only: 12 testers opted in **continuously**
    for the 14 days preceding the application. A tester who opts out and back in
    restarts their clock.

---

## 7. Go live

20. Apply for production access (personal accounts). Eligibility is not
    approval; review typically takes up to a week.
21. Create the production release and roll out in stages. A staged rollout can
    be halted; a full one cannot be taken back.
22. Remove the screenshot seed data once real merchants exist:
    `node scripts/seed-screenshot-data.js --clean --dry` first, which lists what
    it would delete and deletes nothing. All ten shops on production are
    currently seeded placeholders.
23. Grant `REVIEW_SELLER_REGISTRATIONS` to whoever will review registrations —
    the migration gives it to SUPER_ADMIN only, deliberately, because a merchant
    holding it through a shop membership could approve their own registration.
    Confirm `/admin/registrations` loads for them.
