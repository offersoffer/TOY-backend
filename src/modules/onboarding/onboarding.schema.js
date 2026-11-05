'use strict';

const { z } = require('zod');

/**
 * Payloads for self-service seller onboarding (§5-§10).
 *
 * The shop fields deliberately mirror `shop.schema.js` rather than importing
 * it: the admin form and the seller wizard ask for different things. §6 makes
 * the shop's own contact number required because a self-registered shop has
 * no account manager to chase, where an admin creating a shop on the phone
 * already has one. Keeping them separate means tightening the seller's rules
 * cannot quietly tighten the admin's.
 */

const trimmed = (max) => z.string().trim().max(max);

/** §7: ranges are checked here as well as at the branch, per §19. */
const latitude = z.coerce.number().min(-90).max(90).optional().nullable();
const longitude = z.coerce.number().min(-180).max(180).optional().nullable();

const addressSchema = z.object({
  address: trimmed(500).min(5, 'Enter the street address'),
  addressLine2: trimmed(255).optional().nullable(),
  area: trimmed(160).optional().nullable(),
  city: trimmed(120).min(2, 'Enter the city or town'),
  state: trimmed(120).min(2, 'Enter the state'),
  pincode: trimmed(20).regex(/^\d{6}$/, 'Enter a 6-digit pincode'),
  country: trimmed(120).default('India'),
  latitude,
  longitude,
  // §7: how the pin was arrived at. MANUAL covers typed coordinates, which
  // stay optional - the mandatory part is the confirmation, not the typing.
  locationSource: z
    .enum(['ADDRESS_SEARCH', 'MAP_PIN', 'CURRENT_LOCATION', 'MANUAL'])
    .optional()
    .nullable(),
  locationAccuracy: z.coerce.number().min(0).optional().nullable(),
  /**
   * §7: the seller pressed Confirm Shop Location.
   *
   * Accepted from the client but never trusted as proof on its own - the
   * submit endpoint re-checks that coordinates actually exist alongside it,
   * because "confirmed" with nothing to confirm is the exact failure §7 calls
   * out when it says a provider that cannot return coordinates must not
   * silently mark the location confirmed.
   */
  locationConfirmed: z.coerce.boolean().optional().default(false),
});

/** Step 2 of the wizard (§6). Everything here can be saved to a draft. */
const shopDetailsSchema = z.object({
  name: trimmed(160).min(2, 'Enter your shop name'),
  description: trimmed(2000).min(10, 'Describe your shop in a sentence or two'),
  contactNumber: trimmed(30).regex(/^[+\d][\d\s-]{5,20}$/, 'Enter a valid contact number'),
  email: z
    .string()
    .trim()
    .email('Enter a valid email')
    .max(190)
    .nullable()
    .optional()
    .or(z.literal('')),
  websiteUrl: z
    .string()
    .trim()
    .url('Enter a valid website URL')
    .max(500)
    .nullable()
    .optional()
    .or(z.literal('')),
  logoUrl: z.string().trim().url().max(500).optional().nullable(),
  socialLinks: z.record(z.string().trim().url().max(500)).optional().nullable(),
  categoryIds: z.array(z.coerce.number().int().positive()).min(1, 'Choose at least one category'),
});

/**
 * Starting a registration (§4 step 1-3).
 *
 * The address is optional at creation so the wizard can save a draft after
 * step 2 - §4 requires progress to survive the seller leaving, and demanding
 * a confirmed map pin before anything is stored would make step 2 unsavable.
 */
const startSchema = shopDetailsSchema.extend({
  address: addressSchema.partial().optional(),
});

/** Editing a draft. Every field optional; §4 saves after each step. */
const updateSchema = z.object({
  ...shopDetailsSchema.partial().shape,
  address: addressSchema.partial().optional(),
  verification: z.lazy(() => verificationSchema.partial()).optional(),
});

/** §8. All optional - §8 is explicit that not every small business has GST. */
const verificationSchema = z.object({
  gstin: trimmed(20)
    .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/, 'Enter a valid GSTIN')
    .nullable()
    .optional()
    .or(z.literal('')),
  googleBusinessUrl: z.string().trim().url('Enter a valid link').max(500).nullable().optional().or(z.literal('')),
  businessRegistrationNumber: trimmed(60).nullable().optional().or(z.literal('')),
  note: trimmed(1000).nullable().optional().or(z.literal('')),
});

/** §10: submission needs the terms accepted, and says so rather than implying it. */
const submitSchema = z.object({
  acceptedTerms: z.literal(true, {
    errorMap: () => ({ message: 'Accept the terms and privacy policy to submit' }),
  }),
});

/** §16: what the seller types when looking for a shop that may already exist. */
const duplicateQuery = z.object({
  name: trimmed(160).min(2),
  city: trimmed(120).optional(),
  pincode: trimmed(20).optional(),
  contactNumber: trimmed(30).optional(),
});

const claimSchema = z.object({
  shopId: z.coerce.number().int().positive(),
  reason: trimmed(1000).min(20, 'Tell us how this shop is yours, in a sentence or two'),
  contactPhone: trimmed(30).regex(/^[+\d][\d\s-]{5,20}$/, 'Enter a valid contact number').optional(),
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

// ---- Reviewer side (§14) --------------------------------------------------

const { paginationSchema } = require('../../utils/pagination');
const shopVerification = require('../../services/shopVerification');

/** §14's filters. Every one is optional; no filter means the whole queue. */
const reviewListQuery = z.object({
  ...paginationSchema,
  status: z.enum(shopVerification.STATUSES).optional(),
  source: z.enum(['ADMIN_CREATED', 'SELF_REGISTERED', 'EXISTING_SHOP_CLAIM']).optional(),
  /** The shop's public listing, which §11 keeps separate from verification. */
  listingStatus: z.enum(['active', 'inactive']).optional(),
  city: trimmed(120).optional(),
  pincode: trimmed(20).optional(),
  /** Shop name, contact number, or the owner's name or email. */
  q: trimmed(160).optional(),
});

/**
 * §14: a rejection or an information request carries a mandatory explanation.
 *
 * The minimum is 10 characters rather than 1 because the seller reads this
 * verbatim (§12), and "no" is not something anyone can act on. The same floor
 * is enforced again in `shopVerification.assertReason`, which is the gate -
 * this one exists to fail at the edge with a field name attached.
 */
const reasonRequired = z.object({
  reason: trimmed(1000).min(10, 'Say what is wrong and what the seller should do'),
});

const reasonOptional = z.object({
  reason: trimmed(1000).optional().nullable().or(z.literal('')),
});

/** Approving may also put the shop live in the same decision (§11). */
const approveSchema = z.object({
  activate: z.coerce.boolean().optional().default(true),
  reason: trimmed(1000).optional().nullable().or(z.literal('')),
});

/** Switching a shop's public listing on or off, verification untouched. */
const listingSchema = z.object({ status: z.enum(['active', 'inactive']) });

module.exports = {
  addressSchema,
  shopDetailsSchema,
  startSchema,
  updateSchema,
  verificationSchema,
  submitSchema,
  duplicateQuery,
  claimSchema,
  idParam,
  reviewListQuery,
  reasonRequired,
  reasonOptional,
  approveSchema,
  listingSchema,
};
