'use strict';

/**
 * Verifies Razorpay credentials and provisions the subscription Plans.
 *
 *   node scripts/setup-razorpay.js          # check credentials, list plans
 *   node scripts/setup-razorpay.js --create # ...and create any missing plan
 *
 * `--create` writes to your Razorpay account: it creates one Plan per paid
 * tier, priced from `config/plans.js` so the gateway and the app can never
 * disagree about what a plan costs. Existing plans are matched by their
 * `notes.plan_key` and reused rather than duplicated, so it is safe to re-run.
 *
 * Plans cannot be deleted at Razorpay, only made inactive - which is why this
 * asks before creating anything.
 */

const readline = require('node:readline/promises');
const env = require('../src/config/env');
const plans = require('../src/config/plans');
const razorpay = require('../src/services/razorpay');

const PAID_PLANS = plans.PLAN_KEYS.filter((key) => plans.PLANS[key].price > 0);
const CREATE = process.argv.includes('--create');

/** Existing plans on the account, keyed by our plan key via notes. */
async function fetchExisting() {
  const response = await razorpay.request('GET', '/plans?count=100');
  const byKey = new Map();
  for (const plan of response?.items ?? []) {
    const key = plan.notes?.plan_key;
    if (key && !byKey.has(key)) byKey.set(key, plan);
  }
  return byKey;
}

async function createPlan(key) {
  const plan = plans.PLANS[key];
  return razorpay.request('POST', '/plans', {
    period: 'monthly',
    interval: 1,
    item: {
      name: `OffersOffer - ${plan.name}`,
      description: plan.description,
      // Razorpay works in paise; the app's rupee price is the single source.
      amount: razorpay.toPaise(plan.price),
      currency: plan.currency,
    },
    notes: { plan_key: key },
  });
}

async function main() {
  if (!razorpay.isConfigured) {
    console.log('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set in .env.');
    console.log('Dashboard > Settings > API Keys > Generate Test Key, then re-run.');
    process.exitCode = 1;
    return;
  }

  const mode = env.razorpay.keyId.startsWith('rzp_live_') ? 'LIVE' : 'test';
  console.log('Key id : %s  (%s mode)', env.razorpay.keyId, mode);

  let existing;
  try {
    existing = await fetchExisting();
    console.log('Credentials: OK - %d plan(s) already on the account\n', existing.size);
  } catch (error) {
    console.error('FAIL: %s', error.message);
    console.error('  A 401 here means the key id and secret do not match.');
    process.exitCode = 1;
    return;
  }

  const missing = [];
  for (const key of PAID_PLANS) {
    const plan = plans.PLANS[key];
    const found = existing.get(key);
    const configured = env.razorpay.planIds[key];

    console.log('%s (Rs %s / month)', plan.name, plan.price.toLocaleString('en-IN'));
    if (found) {
      console.log('  at Razorpay : %s  (Rs %s)', found.id, razorpay.fromPaise(found.item?.amount));
      if (configured !== found.id) {
        console.log('  .env        : %s', configured || '(empty)');
        console.log('  -> set RAZORPAY_PLAN_%s=%s', key, found.id);
      } else {
        console.log('  .env        : matches');
      }
    } else {
      console.log('  at Razorpay : none');
      missing.push(key);
    }
    console.log('');
  }

  if (!missing.length) {
    console.log('Every paid plan exists. Nothing to create.');
    return;
  }

  if (!CREATE) {
    console.log('Missing: %s', missing.join(', '));
    console.log('Re-run with --create to create them:  node scripts/setup-razorpay.js --create');
    return;
  }

  if (mode === 'LIVE') {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `\nThese will be created on your LIVE Razorpay account. Type "yes" to continue: `,
    );
    rl.close();
    if (answer.trim().toLowerCase() !== 'yes') {
      console.log('Cancelled - nothing was created.');
      return;
    }
  }

  console.log('Creating %d plan(s)...\n', missing.length);
  const created = [];
  for (const key of missing) {
    const plan = await createPlan(key);
    created.push([key, plan.id]);
    // `padEnd`, not '%-8s': Node's console.log supports %s and %d but not
    // printf width or alignment flags, so '%-8s' printed literally and the
    // plan key landed in the argument list instead of the column.
    console.log(`  ${key.padEnd(8)} -> ${plan.id}`);
  }

  console.log('\nAdd these to .env:\n');
  for (const [key, id] of created) console.log('RAZORPAY_PLAN_%s=%s', key, id);
  console.log('\nThen restart the backend.');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
