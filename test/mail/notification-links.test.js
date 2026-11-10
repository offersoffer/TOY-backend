'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * What a real notification actually puts in front of a customer.
 *
 * `test/mail/local-links.test.js` pins the two mechanisms that let localhost
 * escape. This drives the whole fan-out instead - one offer, one follower, one
 * registered device - and inspects the two artefacts that leave the server:
 * the email body, and the Expo push payload. Neither may contain an address
 * that only resolves on the machine that produced it.
 *
 * The database and the push transport are stubbed; nothing here connects to
 * anything. The stubs are installed into the module cache before
 * `notifications` is required, because it resolves both at require time.
 */

const LOCAL = /(^|\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal|10\.0\.2\.2)(:|\/|$)/i;

// A public APP_URL: this is the configuration production is now required to
// have, so these assertions describe the fixed state rather than the bug.
process.env.APP_URL = 'https://offersoffer.in';
process.env.PUBLIC_API_URL = 'https://offersoffer.in';
process.env.SMTP_HOST = 'smtp.example.test';
process.env.LOG_LEVEL = 'silent';

// --- stub: nodemailer -------------------------------------------------------
const nodemailerPath = require.resolve('nodemailer');
let mailsSent = [];
require.cache[nodemailerPath] = {
  id: nodemailerPath,
  filename: nodemailerPath,
  loaded: true,
  exports: {
    createTransport: () => ({
      verify: async () => true,
      sendMail: async (message) => {
        mailsSent.push(message);
        return { messageId: 'stub' };
      },
    }),
  },
};

// --- stub: the database -----------------------------------------------------
const poolPath = require.resolve('../../src/db/pool');
const DEVICE_TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';

const rawQuery = async (sql) => {
  if (/FROM notification_preferences/.test(sql)) return []; // no row = all enabled
  if (/^INSERT INTO notifications/.test(sql.trim())) return { insertId: 500 };
  if (/SELECT id, user_id FROM notifications/.test(sql)) return [{ id: 500, user_id: 7 }];
  if (/FROM push_devices/.test(sql)) return [{ id: 3, user_id: 7, token: DEVICE_TOKEN }];
  if (/^INSERT INTO push_tickets/.test(sql.trim())) return { insertId: 1 };
  if (/^UPDATE notifications/.test(sql.trim())) return { affectedRows: 1 };
  return [];
};

require.cache[poolPath] = {
  id: poolPath,
  filename: poolPath,
  loaded: true,
  exports: {
    rawQuery,
    query: async () => [],
    queryOne: async () => null,
    execute: async () => ({ affectedRows: 0 }),
    pool: { query: async () => [[]] },
  },
};

// --- stub: the push transport ----------------------------------------------
const pushPath = require.resolve('../../src/services/push');
let pushed = [];
require.cache[pushPath] = {
  id: pushPath,
  filename: pushPath,
  loaded: true,
  exports: {
    isConfigured: () => true,
    isExpoToken: (token) => /^Expo(nent)?PushToken\[/.test(token),
    send: async (messages) => {
      pushed.push(...messages);
      return messages.map(() => ({ ok: true, ticketId: 'ticket-1', error: null }));
    },
    getReceipts: async () => new Map(),
    isFatalTokenError: () => false,
  },
};

const notifications = require('../../src/services/notifications');
const mailer = require('../../src/utils/mailer');

const OFFER = {
  id: 41,
  title: 'Scan test - free coffee',
  offer_text: 'Free coffee',
  shop_name: 'Zara',
};
const FOLLOWER = { id: 7, name: 'Ravi', email: 'ravi@example.test' };

test.beforeEach(() => {
  mailsSent = [];
  pushed = [];
});

test('a new-offer notification reaches email and push with no local address', async () => {
  const count = await notifications.dispatch([FOLLOWER], {
    type: 'NEW_OFFER_FOLLOWED_SHOP',
    title: `New offer from ${OFFER.shop_name}`,
    message: OFFER.offer_text,
    entityType: 'offer',
    entityId: OFFER.id,
    email: (recipient) =>
      mailer.templates.newOffer(
        recipient.name,
        OFFER,
        'Zara, a shop you follow, just published a new offer.',
        `${process.env.APP_URL}/offers/${OFFER.id}`,
      ),
  });

  assert.equal(count, 1);

  // The email. This is the artefact that was wrong in a real inbox: the
  // subject below is verbatim the one that arrived reading localhost.
  assert.equal(mailsSent.length, 1);
  const mail = mailsSent[0];
  assert.equal(mail.subject, 'Zara: Scan test - free coffee');
  const body = `${mail.subject}\n${mail.text}\n${mail.html}`;
  assert.ok(!LOCAL.test(body), 'a local address reached the email body');
  assert.match(mail.text, /https:\/\/offersoffer\.in\/offers\/41/);
  // Both places the link appears: the button's href and the printed fallback.
  assert.equal((mail.html.match(/https:\/\/offersoffer\.in\/offers\/41/g) || []).length, 3);

  // The push payload.
  assert.equal(pushed.length, 1);
  const message = pushed[0];
  assert.equal(message.to, DEVICE_TOKEN);
  assert.ok(!LOCAL.test(JSON.stringify(message)), 'a local address reached the push payload');
  // Push carries no web address at all - only a custom-scheme deep link, which
  // is what keeps it independent of APP_URL entirely.
  assert.equal(message.data.deepLink, 'offersapp://offer/41');
  assert.ok(!/https?:\/\//.test(JSON.stringify(message)), 'push must carry no http(s) URL');
});

test('every deep link is a custom-scheme URL, never a web address', () => {
  const cases = [
    ['offer', 41, 'offersapp://offer/41'],
    ['service', 9, 'offersapp://service/9'],
    ['service_offer', 9, 'offersapp://service/9'],
    ['shop', 2, 'offersapp://shop/2'],
    ['offer_claim', 88, 'offersapp://claim/88'],
    ['service_offer_claim', 88, 'offersapp://service-claim/88'],
    // Unmapped, and the id missing: both fall back to the notification centre
    // rather than inventing a route.
    ['booking', 17, 'offersapp://notifications'],
    ['offer', null, 'offersapp://notifications'],
  ];

  for (const [entityType, entityId, expected] of cases) {
    const link = notifications.deepLinkFor(entityType, entityId);
    assert.equal(link, expected);
    assert.ok(!LOCAL.test(link));
    assert.ok(!/^https?:/.test(link), `${link} must not be a web address`);
  }
});

test('a claim QR code encodes the public site, not localhost', () => {
  const { qrValueFor } = require('../../src/modules/claims/claim.service');
  const qr = qrValueFor(
    { id: 88, claim_code: 'ABC123', shop_id: 2, branch_id: null, offer_id: 41 },
    'offer',
  );

  // This one matters more than the email: the QR is printed or shown on a
  // phone screen, and a customer scanning it with the system camera goes
  // wherever it says. A localhost value is a dead end at the counter.
  assert.ok(qr.startsWith('https://offersoffer.in/claims/scan?t='), `unexpected QR value: ${qr}`);
  assert.ok(!LOCAL.test(qr));
});
