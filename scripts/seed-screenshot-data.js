'use strict';

/**
 * Temporary showcase data for the Play Store screenshots: shops and live offers
 * across Madurai and Coimbatore, so the listing images show a populated app
 * rather than an empty feed.
 *
 * Everything written here is disposable and designed to be removed exactly:
 * every shop is stamped `acquisition_channel = 'SCREENSHOT_SEED'`, and every
 * table that hangs off a shop - offers, branches, members, claims, reviews,
 * subscriptions - is ON DELETE CASCADE. So `--clean` is a single DELETE against
 * that tag, and it cannot strip a real merchant unless somebody types that
 * string into the acquisition channel by hand.
 *
 *   node scripts/seed-screenshot-data.js          seed
 *   node scripts/seed-screenshot-data.js --clean  remove every seeded shop
 *   node scripts/seed-screenshot-data.js --dry    print what it would do
 *
 * On the shop names: these are invented, and deliberately not real chains.
 * The screenshots go on a public store listing, where a card reading
 * "<real brand> - 60% off" asserts a commercial relationship that does not
 * exist; that is a trademark complaint and a Play listing takedown waiting to
 * happen. The names below are built from genuine Madurai and Coimbatore
 * geography - the Vaigai and Noyyal rivers, Simmakkal, Peelamedu, R.S. Puram -
 * so they read as local chains without borrowing anyone's mark.
 */

// No dotenv call here on purpose. `src/config/env` loads `.env.<NODE_ENV>`
// first and plain `.env` only as a fallback, which is what stops a script run
// on the server with NODE_ENV=production from confidently connecting to
// somebody's laptop database. Requiring the pool pulls that in; calling
// dotenv.config() here would load `.env` *first* and win, defeating it.
const { query, queryOne, execute } = require('../src/db/pool');

const TAG = 'SCREENSHOT_SEED';
const CLEAN = process.argv.includes('--clean');
const DRY = process.argv.includes('--dry');

const slugify = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Days from now, as a MySQL DATETIME. */
const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 19).replace('T', ' ');
};

// ---------------------------------------------------------------------------
// The data
//
// Coordinates are real: the offers have to sort sensibly by distance on the
// Near Me screen, and a cluster of identical pins is exactly what a screenshot
// would expose. Madurai sits around 9.925 N, 78.119 E and Coimbatore around
// 11.016 N, 76.955 E, so each branch is placed in its actual neighbourhood.
// ---------------------------------------------------------------------------

/**
 * One photograph per offer, keyed by offer title.
 *
 * Wikimedia Commons rather than a placeholder service: the cards needed
 * pictures of the actual thing being sold, and the free keyword services are
 * either dead (source.unsplash.com returns 503) or give a random subject, so a
 * cake offer would show a mountain. Every URL here was resolved by searching
 * Commons for the product and then fetched to confirm it returns 200 with an
 * image content type - a 404 in a store screenshot is worse than no picture.
 *
 * These are freely licensed and go in `offer_images.image_url`, which takes a
 * full URL, so nothing has to be uploaded to S3 for this. They disappear with
 * the shops on --clean. For a real listing a merchant uploads their own.
 */
const OFFER_IMAGES = {
  "Bridal silk collection": "https://thumb.wikimedia.org/wikipedia/commons/thumb/f/f1/Kanchipuram_silk_sareer.JPG/960px-Kanchipuram_silk_sareer.JPG",
  "Cotton saree festive pack": "https://thumb.wikimedia.org/wikipedia/commons/thumb/b/b5/Border_of_Tangail_sari%2Cfrom_the_1970s.jpg/960px-Border_of_Tangail_sari%2Cfrom_the_1970s.jpg",
  "Madurai halwa — half kilo box": "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/17/Bombay_Halwa%2C_Karachi_Halwa.jpg/960px-Bombay_Halwa%2C_Karachi_Halwa.jpg",
  "Evening snack combo": "https://thumb.wikimedia.org/wikipedia/commons/thumb/8/80/Capsicum_bajji.jpg/960px-Capsicum_bajji.jpg",
  "Screen replacement + tempered glass": "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/5c/Broken_Apple_iPhone_5C_Pink_Shallow_Focus.JPG/960px-Broken_Apple_iPhone_5C_Pink_Shallow_Focus.JPG",
  "Wireless earbuds clearance": "https://thumb.wikimedia.org/wikipedia/commons/thumb/9/90/ActiveSound_wireless_earbuds_by_Hykker_%28POJM200483%29.jpg/960px-ActiveSound_wireless_earbuds_by_Hykker_%28POJM200483%29.jpg",
  "Full body health check": "https://thumb.wikimedia.org/wikipedia/commons/thumb/f/f3/2026_-_Blood_test_samples.jpg/960px-2026_-_Blood_test_samples.jpg",
  "Quarterly membership": "https://thumb.wikimedia.org/wikipedia/commons/thumb/e/e9/Colorful_gym_equipment.jpg/960px-Colorful_gym_equipment.jpg",
  "Breakfast for two": "https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c9/Aesthetic_Medu_Vadai.jpg/960px-Aesthetic_Medu_Vadai.jpg",
  "Filter coffee powder — 500g": "https://upload.wikimedia.org/wikipedia/commons/7/7a/Disassembled_South_Indian_coffee_filter.jpg",
  "Hair spa + cut + blow dry": "https://thumb.wikimedia.org/wikipedia/commons/thumb/0/0a/A_beauty_salon_in_Iran%2C_Mashhad%2C_Free_Photo_Wikipedia%2C_Mostafa_Meraji_01.jpg/960px-A_beauty_salon_in_Iran%2C_Mashhad%2C_Free_Photo_Wikipedia%2C_Mostafa_Meraji_01.jpg",
  "Bridal package booking": "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/12/Bridal_makeup_for_Indian_Wedding.jpg/960px-Bridal_makeup_for_Indian_Wedding.jpg",
  "Running shoes — season change": "https://thumb.wikimedia.org/wikipedia/commons/thumb/8/8b/Asics_Gel-Cumulus_22.jpg/960px-Asics_Gel-Cumulus_22.jpg",
  "Badminton racket + stringing": "https://thumb.wikimedia.org/wikipedia/commons/thumb/0/0f/Badminton_Racket.jpg/960px-Badminton_Racket.jpg",
  "Stainless steel cookware set": "https://thumb.wikimedia.org/wikipedia/commons/thumb/f/f3/Hahn_Stainless_Pan_Range.jpg/960px-Hahn_Stainless_Pan_Range.jpg",
  "Bedsheets and towels": "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ac/HSY-_Folded_Towels.jpg/960px-HSY-_Folded_Towels.jpg",
  "Celebration cake — 1kg": "https://thumb.wikimedia.org/wikipedia/commons/thumb/9/9b/A_birthday_cake_2.jpg/960px-A_birthday_cake_2.jpg",
};

const SHOPS = [
  {
    name: 'Vaigai Silks',
    category: 'Fashion',
    description:
      'Four generations of Kanchipuram and Soft Silk sarees, bridal collections and daily wear, on the same street since 1962.',
    city: 'Madurai',
    area: 'Simmakkal',
    address: '14, North Avani Moola Street, Simmakkal',
    pincode: '625001',
    lat: 9.9196,
    lng: 78.1197,
    phone: '+91 97890 41201',
    offers: [
      {
        title: 'Bridal silk collection',
        text: 'Up to 40% OFF',
        type: 'up_to',
        discount: 40,
        was: 18500,
        now: 11100,
        description: 'Pure Kanchipuram bridal silks with zari borders. Includes blouse piece and fall stitching.',
      },
      {
        title: 'Cotton saree festive pack',
        text: 'Buy 2 Get 1 Free',
        type: 'buy_x_get_y',
        buy: 2,
        get: 1,
        was: 2400,
        now: 1600,
        description: 'Handloom cotton sarees in festival colours. Mix and match any three.',
      },
    ],
  },
  {
    name: 'Simmakkal Sweets & Snacks',
    category: 'Food & Beverages',
    description:
      'Madurai halwa, jangiri and hot evening snacks made fresh twice a day. Takeaway and bulk orders for weddings.',
    city: 'Madurai',
    area: 'Simmakkal',
    address: '7, Simmakkal Main Road',
    pincode: '625001',
    lat: 9.9211,
    lng: 78.1226,
    phone: '+91 95431 77820',
    offers: [
      {
        title: 'Madurai halwa — half kilo box',
        text: 'FLAT ₹80 OFF',
        type: 'flat',
        discount: 80,
        was: 380,
        now: 300,
        description: 'The original wheat halwa, made in ghee. Boxed fresh on the day you collect it.',
      },
      {
        title: 'Evening snack combo',
        text: '25% OFF after 4 PM',
        type: 'percentage',
        discount: 25,
        was: 240,
        now: 180,
        description: 'Bonda, bajji and vadai platter with chutney. Available 4 PM to 8 PM daily.',
      },
    ],
  },
  {
    name: 'Temple City Mobiles',
    category: 'Electronics',
    description:
      'Smartphones, accessories and on-the-spot screen replacement. Authorised service for six major brands.',
    city: 'Madurai',
    area: 'Anna Nagar',
    address: '22, Vakkil New Street, Anna Nagar',
    pincode: '625020',
    lat: 9.9397,
    lng: 78.1428,
    phone: '+91 90034 55118',
    offers: [
      {
        title: 'Screen replacement + tempered glass',
        text: 'FLAT ₹500 OFF',
        type: 'flat',
        discount: 500,
        was: 2900,
        now: 2400,
        description: 'Original-grade display with a six month warranty. Most models done in 45 minutes.',
      },
      {
        title: 'Wireless earbuds clearance',
        text: 'Up to 55% OFF',
        type: 'up_to',
        discount: 55,
        was: 3499,
        now: 1575,
        description: 'Last season stock across six brands. Sealed boxes with full warranty.',
      },
    ],
  },
  {
    name: 'Pandian Health Pharmacy',
    category: 'Health & Wellness',
    description:
      'Round-the-clock pharmacy with free home delivery inside the city limits and a diagnostics collection point.',
    city: 'Madurai',
    area: 'Tallakulam',
    address: '3, Alagarkoil Road, Tallakulam',
    pincode: '625002',
    lat: 9.9437,
    lng: 78.1296,
    phone: '+91 93612 40087',
    offers: [
      {
        title: 'Full body health check',
        text: '45% OFF',
        type: 'percentage',
        discount: 45,
        was: 3200,
        now: 1760,
        description: '62 parameters including thyroid, lipid and liver panels. Home sample collection included.',
      },
    ],
  },
  {
    name: 'Anna Nagar Fitness Club',
    category: 'Fitness',
    description:
      'Strength and cardio floor, group classes and personal training. Separate timings for women every morning.',
    city: 'Madurai',
    area: 'Anna Nagar',
    address: '45, 80 Feet Road, Anna Nagar',
    pincode: '625020',
    lat: 9.9418,
    lng: 78.1465,
    phone: '+91 96770 31294',
    offers: [
      {
        title: 'Quarterly membership',
        text: 'FLAT ₹1,500 OFF',
        type: 'flat',
        discount: 1500,
        was: 6000,
        now: 4500,
        description: 'Three months of full floor access with one free body composition assessment.',
      },
    ],
  },
  {
    name: 'Kovai Coffee House',
    category: 'Food & Beverages',
    description:
      'Filter coffee roasted in-house, South Indian breakfast until noon, and a bakery counter that sells out by six.',
    city: 'Coimbatore',
    area: 'R.S. Puram',
    address: '18, West Periyasamy Road, R.S. Puram',
    pincode: '641002',
    lat: 11.0059,
    lng: 76.9492,
    phone: '+91 98427 11630',
    offers: [
      {
        title: 'Breakfast for two',
        text: '30% OFF before 10 AM',
        type: 'percentage',
        discount: 30,
        was: 420,
        now: 294,
        description: 'Two full South Indian breakfast plates with filter coffee. Weekdays only.',
      },
      {
        title: 'Filter coffee powder — 500g',
        text: 'Buy 1 Get 1 Free',
        type: 'buy_x_get_y',
        buy: 1,
        get: 1,
        was: 520,
        now: 260,
        description: 'Peaberry and Arabica blend, roasted and ground the morning you buy it.',
      },
    ],
  },
  {
    name: 'R.S. Puram Beauty Lounge',
    category: 'Beauty & Salon',
    description:
      'Hair, skin and bridal studio with certified stylists. Appointments preferred on weekends.',
    city: 'Coimbatore',
    area: 'R.S. Puram',
    address: '9, D.B. Road, R.S. Puram',
    pincode: '641002',
    lat: 11.0084,
    lng: 76.9521,
    phone: '+91 94433 20771',
    offers: [
      {
        title: 'Hair spa + cut + blow dry',
        text: '40% OFF',
        type: 'percentage',
        discount: 40,
        was: 2500,
        now: 1500,
        description: 'Full service with a keratin-based spa treatment. Roughly 90 minutes.',
      },
      {
        title: 'Bridal package booking',
        text: 'FLAT ₹5,000 OFF',
        type: 'flat',
        discount: 5000,
        was: 25000,
        now: 20000,
        description: 'Engagement, reception and wedding day styling. Trial session included.',
      },
    ],
  },
  {
    name: 'Peelamedu Sports Hub',
    category: 'Sports',
    description:
      'Cricket, badminton and running gear, plus racket stringing while you wait.',
    city: 'Coimbatore',
    area: 'Peelamedu',
    address: '27, Avinashi Road, Peelamedu',
    pincode: '641004',
    lat: 11.0279,
    lng: 77.0039,
    phone: '+91 90254 66310',
    offers: [
      {
        title: 'Running shoes — season change',
        text: 'Up to 50% OFF',
        type: 'up_to',
        discount: 50,
        was: 4999,
        now: 2499,
        description: 'Road and trail models across five brands. Gait check available in store.',
      },
      {
        title: 'Badminton racket + stringing',
        text: '35% OFF',
        type: 'percentage',
        discount: 35,
        was: 3200,
        now: 2080,
        description: 'Graphite rackets with stringing and grip included at your chosen tension.',
      },
    ],
  },
  {
    name: 'Noyyal Home Essentials',
    category: 'Home & Living',
    description:
      'Kitchenware, storage and home textiles. Same-day delivery across Coimbatore on orders before 2 PM.',
    city: 'Coimbatore',
    area: 'Gandhipuram',
    address: '112, Cross Cut Road, Gandhipuram',
    pincode: '641012',
    lat: 11.0183,
    lng: 76.9704,
    phone: '+91 97917 85540',
    offers: [
      {
        title: 'Stainless steel cookware set',
        text: 'FLAT ₹1,200 OFF',
        type: 'flat',
        discount: 1200,
        was: 4500,
        now: 3300,
        description: 'Five-piece induction-ready set with lids. Ten year warranty against warping.',
      },
      {
        title: 'Bedsheets and towels',
        text: 'Buy 3 Get 2 Free',
        type: 'buy_x_get_y',
        buy: 3,
        get: 2,
        was: 2700,
        now: 1620,
        description: 'Cotton bedsheets and bath towels. Mix across any colour or size.',
      },
    ],
  },
  {
    name: 'Race Course Bakers',
    category: 'Food & Beverages',
    description:
      'Celebration cakes, fresh bread and savoury puffs, baked through the night and sold from seven in the morning.',
    city: 'Coimbatore',
    area: 'Race Course',
    address: '6, Race Course Road',
    pincode: '641018',
    lat: 10.9975,
    lng: 76.9707,
    phone: '+91 95009 12374',
    offers: [
      {
        title: 'Celebration cake — 1kg',
        text: '25% OFF on pre-orders',
        type: 'percentage',
        discount: 25,
        was: 1200,
        now: 900,
        description: 'Choose from twelve flavours. Order a day ahead for custom writing.',
      },
    ],
  },
];

// ---------------------------------------------------------------------------

/**
 * Resolves a category by name, falling back to whatever exists.
 *
 * The category list is seeded data and has been edited more than once, so
 * hard-coding ids would break the moment somebody reorders it. A miss is not
 * fatal: an offer with a NULL category still renders, it just will not appear
 * under a category filter.
 */
async function categoryIdFor(name, cache) {
  if (cache.has(name)) return cache.get(name);
  const row = await queryOne('SELECT id FROM categories WHERE name = ? LIMIT 1', [name]);
  const id = row ? Number(row.id) : null;
  cache.set(name, id);
  if (!id) console.warn(`  ! no category named "${name}" — offers will be uncategorised`);
  return id;
}

async function clean() {
  const shops = await query('SELECT id, name FROM shops WHERE acquisition_channel = ?', [TAG]);
  if (!shops.length) {
    console.log('Nothing to clean: no shops tagged %s.', TAG);
    return;
  }
  console.log('Removing %d seeded shop(s):', shops.length);
  shops.forEach((s) => console.log('  -', s.name));
  if (DRY) return console.log('\n--dry: nothing deleted.');

  // One statement. Offers, branches, members, claims, reviews and
  // subscriptions are all ON DELETE CASCADE from shops, so this leaves nothing
  // behind except audit rows, which are SET NULL by design.
  const result = await execute('DELETE FROM shops WHERE acquisition_channel = ?', [TAG]);
  console.log('\nDeleted %d shop(s) and everything that hung off them.', result.affectedRows);
}

async function seed() {
  const existing = await queryOne(
    'SELECT COUNT(*) AS n FROM shops WHERE acquisition_channel = ?',
    [TAG],
  );
  if (Number(existing.n) > 0) {
    console.log(
      'Found %d shop(s) already tagged %s. Run with --clean first to avoid duplicates.',
      existing.n,
      TAG,
    );
    return;
  }

  const cache = new Map();
  let shopCount = 0;
  let offerCount = 0;

  for (const shop of SHOPS) {
    const categoryId = await categoryIdFor(shop.category, cache);

    if (DRY) {
      console.log('would create %s (%s) with %d offer(s)', shop.name, shop.city, shop.offers.length);
      shopCount += 1;
      offerCount += shop.offers.length;
      continue;
    }

    const shopResult = await execute(
      `INSERT INTO shops (name, slug, description, contact_number, status, acquisition_channel)
       VALUES (?, ?, ?, ?, 'active', ?)`,
      [shop.name, slugify(shop.name), shop.description, shop.phone, TAG],
    );
    const shopId = shopResult.insertId;

    // `location_confirmed_at` is what lets an offer publish against a branch
    // (V3 location §8) - a branch whose pin was never confirmed is treated as
    // unplaced, and the Near Me screen skips it.
    await execute(
      `INSERT INTO shop_branches
         (shop_id, branch_name, address, area, city, state, country, pincode,
          latitude, longitude, location_source, location_confirmed_at)
       VALUES (?, ?, ?, ?, ?, 'Tamil Nadu', 'India', ?, ?, ?, 'MAP_PIN', NOW())`,
      [shopId, `${shop.name} — ${shop.area}`, shop.address, shop.area, shop.city, shop.pincode, shop.lat, shop.lng],
    );

    for (const offer of shop.offers) {
      const offerResult = await execute(
        `INSERT INTO offers
           (shop_id, category_id, title, product_name, description, offer_text,
            offer_type, discount_type, discount_value, original_price, discounted_price,
            buy_quantity, get_quantity, start_date, end_date, status,
            applicability_type, claim_limit_per_customer)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'shop_wide', 1)`,
        [
          shopId,
          categoryId,
          offer.title,
          offer.title,
          offer.description,
          offer.text,
          offer.type,
          offer.type === 'buy_x_get_y' ? 'none' : offer.type === 'flat' ? 'flat' : 'percentage',
          offer.discount ?? null,
          offer.was ?? null,
          offer.now ?? null,
          offer.buy ?? null,
          offer.get ?? null,
          // Started yesterday so nothing sits in `scheduled`, and runs well past
          // any screenshot session so a card cannot expire mid-capture.
          day(-1),
          day(45),
        ],
      );
      const image = OFFER_IMAGES[offer.title];
      if (image) {
        await execute(
          `INSERT INTO offer_images (offer_id, image_url, display_order) VALUES (?, ?, 0)`,
          [offerResult.insertId, image],
        );
      }

      offerCount += 1;
    }

    shopCount += 1;
    console.log('  %s (%s) — %d offer(s)', shop.name, shop.city, shop.offers.length);
  }

  console.log(
    '\n%s%d shop(s), %d offer(s) across Madurai and Coimbatore.',
    DRY ? '--dry: would create ' : 'Created ',
    shopCount,
    offerCount,
  );
  if (!DRY) {
    console.log('Remove it all with: node scripts/seed-screenshot-data.js --clean');
  }
}

(CLEAN ? clean() : seed())
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
