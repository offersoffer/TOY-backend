'use strict';

const { z } = require('zod');
const { businessDate } = require('../../utils/businessDate');
const { paginationSchema } = require('../../utils/pagination');
const { AI_FEATURE_NAMES, CONTENT_SECTIONS } = require('../../config/aiFeatures');

/**
 * Request validation for the AI endpoints, and the shapes used to check what
 * comes *back* from the model (§28: "The backend must validate the response
 * before passing it to Angular").
 */

const BUSINESS_GOALS = [
  'increase_sales',
  'clear_inventory',
  'attract_new_customers',
  'win_back_customers',
  'promote_new_product',
  'weekend_traffic',
  'store_visits',
  'promote_category',
  'other',
];

const TONES = ['professional', 'friendly', 'exciting', 'minimal', 'urgent'];
const LENGTHS = ['short', 'medium', 'long'];
const OFFER_TYPES = ['percentage', 'flat', 'buy_x_get_y', 'price_drop', 'up_to', 'other'];
const DISCOUNT_TYPES = ['percentage', 'flat', 'none'];

const shopId = z.coerce.number().int().positive({ message: 'Shop is required' });
const optionalText = (max) => z.string().trim().max(max).optional().nullable();

// ---- Requests --------------------------------------------------------------

/** POST /api/ai/offer-assistant/recommend (§27). Only the goal is required. */
const recommendSchema = z.object({
  shopId,
  goal: z.enum(BUSINESS_GOALS).default('increase_sales'),
  goalLabel: optionalText(120),
  details: optionalText(2000),
  productOrCategory: optionalText(200),
  preferredDiscount: optionalText(120),
  targetCustomer: optionalText(200),
  locationRadiusKm: z.coerce.number().min(0).max(500).optional().nullable(),
  startDate: businessDate('start').optional().nullable(),
  endDate: businessDate('end').optional().nullable(),
  budget: optionalText(120),
  inventoryNotes: optionalText(1000),
  additionalInstructions: optionalText(1000),
  optionCount: z.coerce.number().int().min(1).max(3).default(3),
});

/** POST /api/ai/offer-assistant/regenerate - the same input, plus what to avoid. */
const regenerateRecommendationSchema = recommendSchema.extend({
  previousTitles: z.array(z.string().trim().max(200)).max(10).optional().default([]),
  refinement: optionalText(500),
});

/**
 * The offer the content is written for. Either an `offerId` the caller owns, or
 * an inline draft for an offer that has not been saved yet - the form can call
 * "Generate content" before the first save.
 */
const offerFactsSchema = z.object({
  title: optionalText(200),
  productName: optionalText(200),
  categoryName: optionalText(120),
  offerType: z.enum(OFFER_TYPES).optional().nullable(),
  offerText: optionalText(200),
  discountType: z.enum(DISCOUNT_TYPES).optional().nullable(),
  discountValue: z.coerce.number().min(0).max(10000000).optional().nullable(),
  originalPrice: z.coerce.number().min(0).max(99999999).optional().nullable(),
  discountedPrice: z.coerce.number().min(0).max(99999999).optional().nullable(),
  buyQuantity: z.coerce.number().int().min(1).max(999).optional().nullable(),
  getQuantity: z.coerce.number().int().min(1).max(999).optional().nullable(),
  minPurchase: z.coerce.number().min(0).max(99999999).optional().nullable(),
  startDate: businessDate('start').optional().nullable(),
  endDate: businessDate('end').optional().nullable(),
  termsConditions: optionalText(2000),
  eligibility: optionalText(1000),
  usageRestrictions: optionalText(1000),
  applicableProducts: optionalText(500),
});

const controlsSchema = z.object({
  tone: z.enum(TONES).default('professional'),
  length: z.enum(LENGTHS).default('medium'),
  language: z.string().trim().min(2).max(40).default('English'),
  targetAudience: optionalText(200),
  emoji: z.coerce.boolean().default(true),
  callToAction: optionalText(60),
  additionalNotes: optionalText(500),
  variants: z.coerce.number().int().min(1).max(3).default(1),
});

const generateContentSchema = z
  .object({
    shopId,
    offerId: z.coerce.number().int().positive().optional().nullable(),
    offer: offerFactsSchema.optional(),
    sections: z
      .array(z.enum(CONTENT_SECTIONS))
      .min(1, 'Choose at least one thing to generate')
      .max(CONTENT_SECTIONS.length)
      .default(['title', 'shortDescription', 'detailedDescription', 'bannerText', 'pushNotification']),
    controls: controlsSchema.default({}),
  })
  .refine((data) => data.offerId || data.offer, {
    message: 'Either an offer id or the offer details are required',
    path: ['offerId'],
  });

const regenerateContentSchema = generateContentSchema
  .innerType()
  .extend({
    previousVersions: z.record(z.array(z.string().max(2000)).max(4)).optional().default({}),
    refinement: optionalText(500),
  })
  .refine((data) => data.offerId || data.offer, {
    message: 'Either an offer id or the offer details are required',
    path: ['offerId'],
  });

const improveSchema = z
  .object({
    shopId,
    offerId: z.coerce.number().int().positive().optional().nullable(),
    offer: offerFactsSchema.optional(),
    controls: controlsSchema.default({}),
    focus: optionalText(500),
  })
  .refine((data) => data.offerId || data.offer, {
    message: 'Either an offer id or the offer details are required',
    path: ['offerId'],
  });

const usageQuerySchema = z.object({
  shopId: z.coerce.number().int().positive().optional(),
  months: z.coerce.number().int().min(1).max(12).default(1),
});

const historyQuerySchema = z.object({
  ...paginationSchema,
  shopId: z.coerce.number().int().positive().optional(),
  feature: z.enum(AI_FEATURE_NAMES).optional(),
  outcome: z.enum(['pending', 'accepted', 'rejected']).optional(),
});

const historyOutcomeSchema = z.object({
  outcome: z.enum(['accepted', 'rejected']),
  offerId: z.coerce.number().int().positive().optional().nullable(),
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

// ---- Model output ----------------------------------------------------------

/**
 * §28's validation layer. The AI service already normalises its answer; this is
 * the second, independent check before anything reaches Angular - a malformed
 * or over-large field is dropped here rather than rendered.
 */
const reasonSchema = z.object({
  text: z.string().trim().min(1).max(400),
  basis: z.enum(['observed', 'general']).default('general'),
});

const recommendationSchema = z.object({
  label: z.string().trim().max(80).default('Recommended offer'),
  title: z.string().trim().min(1).max(200),
  offerText: z.string().trim().max(200).nullish(),
  description: z.string().trim().max(2000).nullish(),
  offerType: z.enum(OFFER_TYPES).default('percentage'),
  discountType: z.enum(DISCOUNT_TYPES).default('percentage'),
  discountValue: z.number().min(0).max(10000000).nullish(),
  buyQuantity: z.number().int().min(1).max(999).nullish(),
  getQuantity: z.number().int().min(1).max(999).nullish(),
  productName: z.string().trim().max(200).nullish(),
  categoryName: z.string().trim().max(120).nullish(),
  goal: z.string().trim().max(200).nullish(),
  recommendedDurationDays: z.number().int().min(1).max(365).nullish(),
  recommendedStartDate: z.string().trim().max(40).nullish(),
  recommendedEndDate: z.string().trim().max(40).nullish(),
  recommendedSchedule: z.string().trim().max(200).nullish(),
  targetRadiusKm: z.number().min(0).max(500).nullish(),
  reasoning: z.array(reasonSchema).max(8).default([]),
  tradeOffs: z.array(z.string().trim().max(300)).max(6).default([]),
});

const assistantResultSchema = z.object({
  recommendations: z.array(recommendationSchema).min(1).max(3),
  insufficientData: z.boolean().default(false),
  dataNotes: z.array(z.string().trim().max(400)).max(6).default([]),
  locationInsight: z.string().trim().max(400).nullish(),
  timingInsight: z.string().trim().max(400).nullish(),
  meta: z.object({}).passthrough().optional(),
});

const contentResultSchema = z.object({
  sections: z.record(z.array(z.string().max(2000)).min(1).max(3)),
  suggestedTerms: z.array(z.string().trim().max(300)).max(6).default([]),
  meta: z.object({}).passthrough().optional(),
});

const improveResultSchema = z.object({
  improvements: z.array(z.string().trim().max(400)).max(10).default([]),
  suggestedTitle: z.string().trim().max(200).nullish(),
  suggestedOfferText: z.string().trim().max(200).nullish(),
  suggestedShortDescription: z.string().trim().max(600).nullish(),
  suggestedDescription: z.string().trim().max(3000).nullish(),
  meta: z.object({}).passthrough().optional(),
});

module.exports = {
  BUSINESS_GOALS,
  TONES,
  LENGTHS,
  OFFER_TYPES,
  DISCOUNT_TYPES,
  recommendSchema,
  regenerateRecommendationSchema,
  generateContentSchema,
  regenerateContentSchema,
  improveSchema,
  usageQuerySchema,
  historyQuerySchema,
  historyOutcomeSchema,
  idParam,
  assistantResultSchema,
  contentResultSchema,
  improveResultSchema,
};
