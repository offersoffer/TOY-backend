'use strict';

const { z } = require('zod');
const { paginationSchema } = require('../../utils/pagination');
const { queryBoolean } = require('../../utils/queryBoolean');

const latitude = z.coerce.number().min(-90).max(90).optional().nullable();
const longitude = z.coerce.number().min(-180).max(180).optional().nullable();
const optionalText = (max) => z.string().trim().max(max).optional().nullable();

/**
 * Opening hours (§3 optional, §13 per branch).
 *
 * A day is either the string 'closed' or up to three open/close windows, which
 * is enough for the split shifts that are normal for Indian high-street shops.
 * Anything not listed is simply unknown rather than closed - a merchant who
 * fills in nothing has not declared they never open.
 */
const timeOfDay = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM, e.g. 09:30');

const openingHours = z
  .record(
    z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
    z.union([
      z.literal('closed'),
      z.array(z.object({ open: timeOfDay, close: timeOfDay })).max(3),
    ]),
  )
  .optional()
  .nullable();

/**
 * How the pin was chosen (§24). Recorded rather than inferred: a merchant who
 * stood in their shop and pressed "use my current location" has given a better
 * answer than the geocoder, and only they can say which happened.
 */
const locationSource = z
  .enum(['ADDRESS_SEARCH', 'MAP_PIN', 'CURRENT_LOCATION', 'MANUAL'])
  .optional()
  .nullable();

const categoryIds = z
  .union([z.string(), z.array(z.union([z.string(), z.number()])), z.number()])
  .transform((value) =>
    (Array.isArray(value) ? value : String(value).split(','))
      .map((item) => Number.parseInt(item, 10))
      .filter((item) => Number.isInteger(item) && item > 0),
  )
  .optional()
  .default([]);

const listShopsSchema = z.object({
  ...paginationSchema,
  search: z.string().trim().max(160).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  city: z.string().trim().max(120).optional(),
  status: z.enum(['active', 'inactive', 'all']).optional(),
  mine: queryBoolean(),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
  radius: z.coerce.number().min(0.1).max(500).optional(),
  sort: z.enum(['name', 'newest', 'popular', 'nearest']).default('name'),
});

const branchBody = z.object({
  branchName: z.string().trim().min(2, 'Branch name is required').max(160),
  address: optionalText(500),
  addressLine2: optionalText(255),
  area: optionalText(160),
  city: z.string().trim().min(1, 'City is required').max(120),
  state: optionalText(120),
  country: optionalText(120),
  pincode: optionalText(20),
  latitude,
  longitude,
  locationSource,
  // Metres, as reported by the device. Never a reason to reject a save (§25).
  locationAccuracy: z.coerce.number().min(0).max(100000).optional().nullable(),
  placeId: optionalText(120),
  // The merchant pressed "Confirm location" on the map (§8). Sent by the
  // clients that show that step; its absence is not an error, because the
  // publish gate in §18 is about the coordinates existing, not about which
  // screen produced them.
  locationConfirmed: z.coerce.boolean().optional(),
  openingHours,
  contactNumber: optionalText(30),
  // The person a customer is put through to at this branch. Optional to save,
  // required to publish - see `services/branchReadiness.js` for why those are
  // different moments.
  contactPersonName: optionalText(160),
  contactPersonEmail: z
    .string()
    .trim()
    .max(190)
    .email('Enter a valid email address')
    .optional()
    .nullable()
    .or(z.literal('').transform(() => null)),
  isPrimary: z.coerce.boolean().optional().default(false),
  status: z.enum(['active', 'inactive']).optional().default('active'),
});

const shopBody = z.object({
  name: z.string().trim().min(2, 'Shop name is required').max(160),
  description: optionalText(5000),
  logoUrl: z.string().url().max(500).optional().nullable(),
  coverUrl: z.string().url().max(500).optional().nullable(),
  contactNumber: optionalText(30),
  email: z.string().trim().toLowerCase().email('Enter a valid email').max(190).optional().nullable().or(z.literal('')),
  websiteUrl: z.string().url().max(500).optional().nullable().or(z.literal('')),
  socialLinks: z.record(z.string().max(500)).optional().nullable(),
  openingHours,
  status: z.enum(['active', 'inactive']).optional().default('active'),
  // How this merchant came to the platform (Business §17, §32). Only a Super
  // Admin's value is honoured - the service drops it for anyone else - but it
  // is accepted here rather than rejected, so a merchant's own save does not
  // fail merely because their form echoed a field back.
  acquisitionChannel: optionalText(60),
  categoryIds,
  // Creating a shop creates its location in the same call (§16 + §4): a shop
  // that is going live needs one, so asking for it on a second screen only
  // creates shops that cannot be published.
  primaryBranch: branchBody.optional().nullable(),
});

/**
 * Editing re-uses `primaryBranch`, which is what makes §19's "Shop Profile ->
 * Edit Location -> Confirm -> Save" one form rather than a trip to the branch
 * screen. On update it is an upsert: it edits the shop's primary branch, or
 * creates one if the shop somehow has none.
 */
const updateShopSchema = shopBody.partial().extend({
  name: z.string().trim().min(2).max(160).optional(),
  primaryBranch: branchBody.partial().optional().nullable(),
});

const memberBody = z.object({
  userId: z.coerce.number().int().positive().optional(),
  // When no account exists yet the Super Admin can invite by email (§18).
  email: z.string().trim().toLowerCase().email('Enter a valid email').max(190).optional(),
  name: z.string().trim().min(2).max(120).optional(),
  phone: optionalText(30),
  branchId: z.coerce.number().int().positive().optional().nullable(),
  // Confines the member to `branchId` instead of merely recording where they
  // work. Ignored without a branch, because there is nothing to confine them
  // to; see `shop_members.is_branch_restricted`.
  branchRestricted: z.coerce.boolean().optional().default(false),
  roleId: z.coerce.number().int().positive().optional().nullable(),
  designation: optionalText(120),
  status: z.enum(['active', 'inactive']).optional().default('active'),
}).refine((data) => data.userId || data.email, {
  message: 'Provide an existing user or an email address to invite',
  path: ['email'],
});

const updateMemberSchema = z.object({
  branchId: z.coerce.number().int().positive().optional().nullable(),
  branchRestricted: z.coerce.boolean().optional(),
  roleId: z.coerce.number().int().positive().optional().nullable(),
  designation: optionalText(120),
  status: z.enum(['active', 'inactive']).optional(),
});

const idParam = z.object({ id: z.coerce.number().int().positive() });
const branchParams = z.object({
  id: z.coerce.number().int().positive(),
  branchId: z.coerce.number().int().positive(),
});
const memberParams = z.object({
  id: z.coerce.number().int().positive(),
  memberId: z.coerce.number().int().positive(),
});

module.exports = {
  listShopsSchema,
  shopBody,
  updateShopSchema,
  branchBody,
  updateBranchSchema: branchBody.partial(),
  memberBody,
  updateMemberSchema,
  idParam,
  branchParams,
  memberParams,
};
