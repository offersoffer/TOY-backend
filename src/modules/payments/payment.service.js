'use strict';

const { query, queryOne, execute, rawQuery } = require('../../db/pool');
const env = require('../../config/env');
const plans = require('../../config/plans');
const ApiError = require('../../utils/ApiError');
const razorpay = require('../../services/razorpay');
const logger = require('../../utils/logger');
const subscriptions = require('../subscriptions/subscription.service');

/**
 * Payment records, checkout and invoices (V3 payments §7, §15, §16).
 *
 * The rule this file exists to enforce: **the frontend never activates a plan**
 * (§7). `startCheckout` only creates gateway objects and writes a CREATED
 * transaction; the subscription becomes ACTIVE in `payment.webhook.js`, after a
 * signature check.
 */

const GATEWAY = 'razorpay';

/** Razorpay payment status -> the states from §9. */
const PAYMENT_STATUS = {
  created: 'CREATED',
  authorized: 'AUTHORIZED',
  captured: 'CAPTURED',
  refunded: 'REFUNDED',
  failed: 'FAILED',
};

function mapTransaction(row) {
  return {
    id: Number(row.id),
    shopId: Number(row.shop_id),
    plan: row.plan,
    planName: plans.planFor(row.plan).name,
    gateway: row.gateway,
    orderId: row.gateway_order_id,
    paymentId: row.gateway_payment_id,
    amount: Number(row.amount),
    amountRefunded: Number(row.amount_refunded),
    currency: row.currency,
    paymentMethod: row.payment_method,
    methodDetail: row.method_detail,
    status: row.status,
    failureReason: row.failure_reason,
    paidAt: row.paid_at,
    createdAt: row.created_at,
  };
}

/**
 * Inserts or updates the transaction for a gateway payment.
 *
 * Keyed on `gateway_payment_id`, so a webhook redelivery updates the row it
 * created the first time instead of adding a duplicate (§8).
 */
async function recordTransaction({
  shopId,
  plan,
  gatewayOrderId = null,
  gatewayPaymentId = null,
  gatewayInvoiceId = null,
  amount,
  currency = 'INR',
  paymentMethod = null,
  methodDetail = null,
  status,
  failureReason = null,
  amountRefunded = 0,
  paidAt = null,
}) {
  await execute(
    `INSERT INTO payment_transactions
       (shop_id, gateway, gateway_order_id, gateway_payment_id, gateway_invoice_id, plan,
        amount, amount_refunded, currency, payment_method, method_detail, status,
        failure_reason, paid_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       status = VALUES(status),
       amount = VALUES(amount),
       amount_refunded = VALUES(amount_refunded),
       payment_method = COALESCE(VALUES(payment_method), payment_method),
       method_detail = COALESCE(VALUES(method_detail), method_detail),
       gateway_order_id = COALESCE(VALUES(gateway_order_id), gateway_order_id),
       gateway_invoice_id = COALESCE(VALUES(gateway_invoice_id), gateway_invoice_id),
       failure_reason = VALUES(failure_reason),
       paid_at = COALESCE(VALUES(paid_at), paid_at)`,
    [
      shopId,
      GATEWAY,
      gatewayOrderId,
      gatewayPaymentId,
      gatewayInvoiceId,
      plan,
      amount,
      amountRefunded,
      currency,
      paymentMethod,
      methodDetail,
      status,
      failureReason ? String(failureReason).slice(0, 255) : null,
      paidAt,
    ],
  );

  return gatewayPaymentId
    ? queryOne('SELECT * FROM payment_transactions WHERE gateway_payment_id = ?', [gatewayPaymentId])
    : null;
}

/** Billing history for the merchant's Billing screen (§15). */
async function billingHistory(shopId, limit = 50) {
  const rows = await rawQuery(
    `SELECT * FROM payment_transactions WHERE shop_id = ?
      ORDER BY created_at DESC LIMIT ${Number(limit)}`,
    [shopId],
  );
  return rows.map(mapTransaction);
}

// ---------------------------------------------------------------------------
// Invoices (§16)

/** Sequential per-year invoice number: INV-2026-000042. */
async function nextInvoiceNumber() {
  const year = new Date().getUTCFullYear();
  const prefix = `${env.billing.invoicePrefix}-${year}-`;
  const row = await queryOne(
    `SELECT number FROM subscription_invoices WHERE number LIKE ? ORDER BY id DESC LIMIT 1`,
    [`${prefix}%`],
  );
  const last = row ? Number(String(row.number).slice(prefix.length)) : 0;
  return `${prefix}${String(last + 1).padStart(6, '0')}`;
}

/**
 * Issues an invoice for a captured payment. One invoice per transaction: a
 * second call for the same payment returns the existing row rather than
 * numbering it twice, which keeps webhook redelivery harmless.
 */
async function issueInvoice(transaction, { periodStart = null, periodEnd = null } = {}) {
  const existing = await queryOne(
    'SELECT * FROM subscription_invoices WHERE transaction_id = ? LIMIT 1',
    [transaction.id],
  );
  if (existing) return existing;

  // The billing address is the shop's main branch - shops themselves carry no
  // address, and the branch is what a merchant would recognise on an invoice.
  const shop = await queryOne(
    `SELECT s.name, b.address, b.city, b.state, b.pincode
       FROM shops s
       LEFT JOIN shop_branches b ON b.shop_id = s.id AND b.status = 'active'
      WHERE s.id = ?
      ORDER BY b.id ASC LIMIT 1`,
    [transaction.shop_id],
  );

  // The plan price is what the merchant is charged, tax inclusive - so the
  // invoice back-computes the taxable value rather than adding tax on top.
  const total = Number(transaction.amount);
  const rate = env.billing.taxPercent / 100;
  const subtotal = rate > 0 ? Number((total / (1 + rate)).toFixed(2)) : total;
  const tax = Number((total - subtotal).toFixed(2));

  const address = shop
    ? [shop.address, shop.city, shop.state, shop.pincode].filter(Boolean).join(', ') || null
    : null;

  const number = await nextInvoiceNumber();
  const result = await execute(
    `INSERT INTO subscription_invoices
       (shop_id, transaction_id, number, plan, period_start, period_end,
        subtotal, tax_amount, total, currency, status, billing_name, billing_address)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?, ?)`,
    [
      transaction.shop_id,
      transaction.id,
      number,
      transaction.plan,
      periodStart,
      periodEnd,
      subtotal,
      tax,
      total,
      transaction.currency,
      shop?.name ?? null,
      address,
    ],
  );
  return queryOne('SELECT * FROM subscription_invoices WHERE id = ?', [result.insertId]);
}

function mapInvoice(row) {
  return {
    id: Number(row.id),
    number: row.number,
    reference: row.number,
    plan: row.plan,
    planName: plans.planFor(row.plan).name,
    description: `${plans.planFor(row.plan).name} plan subscription`,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    subtotal: Number(row.subtotal),
    taxAmount: Number(row.tax_amount),
    taxPercent: env.billing.taxPercent,
    amount: Number(row.total),
    total: Number(row.total),
    currency: row.currency,
    status: row.status,
    billingName: row.billing_name,
    billingAddress: row.billing_address,
    issuedAt: row.issued_at,
  };
}

async function invoices(shopId, limit = 50) {
  const rows = await rawQuery(
    `SELECT * FROM subscription_invoices WHERE shop_id = ? ORDER BY issued_at DESC LIMIT ${Number(limit)}`,
    [shopId],
  );
  return rows.map(mapInvoice);
}

async function invoice(shopId, invoiceId) {
  const row = await queryOne('SELECT * FROM subscription_invoices WHERE id = ? AND shop_id = ?', [
    invoiceId,
    shopId,
  ]);
  if (!row) throw ApiError.notFound('Invoice not found');
  return mapInvoice(row);
}

// ---------------------------------------------------------------------------
// Checkout (§3)

/** Reuses the shop's gateway customer, creating one on first payment. */
async function ensureGatewayCustomer(shopId, user) {
  const subscription = await subscriptions.getForShop(shopId);
  if (subscription.gatewayCustomerId) return subscription.gatewayCustomerId;

  const shop = await queryOne('SELECT name, email, contact_number FROM shops WHERE id = ?', [shopId]);

  const customer = await razorpay.createCustomer({
    name: shop?.name || user?.name || `Shop ${shopId}`,
    email: shop?.email || user?.email,
    contact: shop?.contact_number || user?.phone,
    notes: { shop_id: String(shopId) },
  });

  await subscriptions.attachGateway(shopId, { customerId: customer.id });
  return customer.id;
}

/**
 * Starts a paid-plan purchase (§3).
 *
 * Creates a Razorpay *subscription* rather than a one-off order, because that
 * is what carries a UPI AutoPay / card mandate and gives recurring billing
 * without the app building its own (§4, §5).
 *
 * Returns everything Checkout needs plus `shortUrl` - Razorpay's hosted page,
 * which the mobile app opens in the system browser so no card data ever passes
 * through the app (§6).
 *
 * Nothing here unlocks a feature. The plan is left `created`/`pending` until a
 * verified webhook says otherwise (§7).
 */
async function startCheckout(shopId, planKey, user, { billingCycle = 'monthly', note } = {}) {
  const plan = plans.planFor(planKey);
  if (plan.price <= 0) {
    throw ApiError.badRequest('The Free plan does not require payment.');
  }
  if (!razorpay.isConfigured) {
    throw new ApiError(
      503,
      'Online payments are not configured on this server.',
      undefined,
      'PAYMENTS_NOT_CONFIGURED',
    );
  }

  const gatewayPlanId = env.razorpay.planIds[planKey];
  if (!gatewayPlanId) {
    throw new ApiError(
      503,
      `No Razorpay plan is configured for the ${plan.name} plan.`,
      undefined,
      'PAYMENTS_NOT_CONFIGURED',
    );
  }

  const current = await subscriptions.getForShop(shopId);
  const customerId = await ensureGatewayCustomer(shopId, user);

  const gatewaySubscription = await razorpay.createSubscription({
    planId: gatewayPlanId,
    customerId,
    totalCount: env.razorpay.totalCount,
    notes: {
      shop_id: String(shopId),
      plan: planKey,
      actor_id: String(user?.id ?? ''),
      ...(note ? { note: String(note).slice(0, 250) } : {}),
    },
  });

  // Record the intent only. The plan in force is left alone, so a merchant who
  // is mid-period on a paid plan keeps it while they pay, and keeps it if they
  // abandon checkout (§12). `activate()` applies the target on payment (§7).
  await subscriptions.recordCheckoutIntent(shopId, planKey, { billingCycle });
  await subscriptions.attachGateway(shopId, {
    customerId,
    subscriptionId: gatewaySubscription.id,
    planId: gatewayPlanId,
  });

  return {
    gateway: GATEWAY,
    keyId: razorpay.keyId,
    subscriptionId: gatewaySubscription.id,
    /** Razorpay's own hosted checkout page - used by the mobile app (§4). */
    shortUrl: gatewaySubscription.short_url ?? null,
    status: gatewaySubscription.status,
    plan: planKey,
    planName: plan.name,
    amount: plan.price,
    currency: plan.currency,
    recurring: true,
    previousPlan: current.plan,
    /** Prefilled on the checkout form; never a stored credential (§6). */
    prefill: {
      name: user?.name ?? null,
      email: user?.email ?? null,
      contact: user?.phone ?? null,
    },
    notes: { shopId, plan: planKey },
  };
}

/**
 * The client-side handshake after Checkout closes (§7).
 *
 * Verifying the signature proves the browser really did complete a payment,
 * but it does **not** activate anything - it only records the payment as
 * pending and reports back so the UI can stop spinning. Activation happens
 * when the webhook arrives, which is the only source the backend trusts.
 */
async function acknowledgeCheckout(shopId, { paymentId, subscriptionId, orderId, signature }) {
  const valid = subscriptionId
    ? razorpay.verifySubscriptionPaymentSignature({ subscriptionId, paymentId, signature })
    : razorpay.verifyOrderPaymentSignature({ orderId, paymentId, signature });

  if (!valid) throw ApiError.badRequest('Payment could not be verified.');

  const subscription = await subscriptions.getForShop(shopId);
  if (subscriptionId && subscription.gatewaySubscriptionId !== subscriptionId) {
    throw ApiError.badRequest('This payment belongs to a different subscription.');
  }

  /*
   * The price of the plan being *bought*, not the price currently stored.
   *
   * `subscription.price` is what the shop pays today, which during an upgrade
   * is the old plan - zero when upgrading from Free. The row written here is
   * the merchant's billing history, so it has to say what this payment is for.
   * Seen on a real ₹999 test charge recorded as ₹2,500 because that was the
   * stale stored price.
   */
  const buyingPlan = subscription.checkoutPlan ?? subscription.plan;
  const planPrice = plans.PLANS[buyingPlan]?.price ?? subscription.price;

  await recordTransaction({
    shopId,
    // The plan being bought, which is not yet the plan in force (§7).
    plan: buyingPlan,
    gatewayOrderId: orderId ?? null,
    gatewayPaymentId: paymentId,
    amount: planPrice,
    currency: subscription.currency,
    status: 'PENDING',
  });

  return {
    verified: true,
    // Deliberately not "active": the webhook decides that (§7).
    subscriptionStatus: subscription.status,
    message: 'Payment received. Your plan activates as soon as the gateway confirms it.',
  };
}

/** Cancels future billing at the gateway, then locally (§13). */
async function cancelSubscription(shopId, user, note) {
  const subscription = await subscriptions.getForShop(shopId);

  if (subscription.gatewaySubscriptionId && razorpay.isConfigured) {
    try {
      await razorpay.cancelSubscription(subscription.gatewaySubscriptionId, true);
    } catch (error) {
      // An already-cancelled or completed mandate is not a reason to refuse the
      // merchant's request - the local state is what governs entitlements.
      logger.error(
      {
        event: 'PAYMENT_GATEWAY_CALL_FAILED',
        error_code: 'GATEWAY_UNREACHABLE',
        category: 'PAYMENT',
        dependency: 'RAZORPAY',
        operation: 'CANCEL_SUBSCRIPTION',
        shop_id: String(shopId),
        err_message: error.message,
      },
      'Gateway cancellation failed',
    );
    }
  }

  return subscriptions.cancel(shopId, user, note);
}

/** Platform-wide payment view for the Super Admin (§31). */
async function allTransactions({ limit = 50, offset = 0, status, shopId } = {}) {
  const where = [];
  const params = [];
  if (status) {
    where.push('t.status = ?');
    params.push(status);
  }
  if (shopId) {
    where.push('t.shop_id = ?');
    params.push(shopId);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [rows, total] = await Promise.all([
    rawQuery(
      `SELECT t.*, s.name AS shop_name FROM payment_transactions t
         JOIN shops s ON s.id = t.shop_id
         ${clause}
        ORDER BY t.created_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
      params,
    ),
    queryOne(`SELECT COUNT(*) AS count FROM payment_transactions t ${clause}`, params),
  ]);

  return {
    items: rows.map((row) => ({ ...mapTransaction(row), shopName: row.shop_name })),
    total: Number(total.count),
  };
}

/**
 * The shop behind a gateway order, invoice or payment id.
 *
 * Exists because a subscription payment does not name its subscription.
 * Observed on a real test-mode UPI charge: the payment entity Razorpay sent
 * carried `order_id` and `invoice_id` and **no `subscription_id`**, so the
 * webhook's only route to a shop was the `notes` fallback - and the notes on
 * that payment were `{"plan":"BUSINESS"}`, with no shop id either. Both
 * `payment.authorized` and `payment.captured` were therefore stored unhandled
 * with "no shop for payment", leaving the transaction row the checkout had
 * already written stuck at PENDING for a payment that was captured.
 *
 * `verifyCheckout` writes that row with the order id before any webhook
 * arrives, so it is the link the payment events need.
 */
async function shopForGatewayReference({ orderId, invoiceId, paymentId }) {
  const refs = [orderId, invoiceId, paymentId].filter(Boolean);
  if (!refs.length) return null;

  // Placeholders written out rather than `IN (?)` with an array: that
  // expansion only happens on mysql2's text protocol, and `queryOne` uses
  // prepared statements, where the array is bound as a single value and
  // matches nothing. The first version of this failed silently for exactly
  // that reason.
  const list = refs.map(() => '?').join(',');
  const row = await queryOne(
    `SELECT shop_id FROM payment_transactions
      WHERE gateway = ?
        AND (gateway_order_id IN (${list})
          OR gateway_invoice_id IN (${list})
          OR gateway_payment_id IN (${list}))
      ORDER BY id DESC LIMIT 1`,
    [GATEWAY, ...refs, ...refs, ...refs],
  );
  return row ? Number(row.shop_id) : null;
}

module.exports = {
  GATEWAY,
  shopForGatewayReference,
  PAYMENT_STATUS,
  mapTransaction,
  recordTransaction,
  billingHistory,
  issueInvoice,
  invoices,
  invoice,
  startCheckout,
  acknowledgeCheckout,
  cancelSubscription,
  allTransactions,
  ensureGatewayCustomer,
};
