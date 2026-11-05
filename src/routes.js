'use strict';

const express = require('express');

const router = express.Router();

router.use('/auth', require('./modules/auth/auth.routes'));
router.use('/users', require('./modules/users/user.routes'));
router.use('/roles', require('./modules/roles/role.routes'));
router.use('/permissions', require('./modules/permissions/permission.routes'));
router.use('/shops', require('./modules/shops/shop.routes'));
// Self-service seller registration. A sibling of `/shops` rather than a child
// of it on purpose: `/shops` is the admin-assisted flow and every write there
// is behind CREATE_SHOP or EDIT_SHOP, while these routes must be reachable by
// a customer who holds neither yet. Keeping them apart is what stops the two
// permission models being confused for one another (Onboarding §3, §15).
router.use('/onboarding', require('./modules/onboarding/onboarding.routes'));
router.use('/categories', require('./modules/categories/category.routes'));
router.use('/offers', require('./modules/offers/offer.routes'));
router.use('/favorites', require('./modules/favorites/favorite.routes'));
router.use('/following', require('./modules/following/following.routes'));
router.use('/preferences', require('./modules/preferences/preferences.routes'));
router.use('/reviews', require('./modules/reviews/review.routes'));
router.use('/notifications', require('./modules/notifications/notification.routes'));
router.use('/analytics', require('./modules/analytics/analytics.routes'));
router.use('/audit-logs', require('./modules/audit/audit.routes'));
router.use('/uploads', require('./modules/uploads/upload.routes'));
// Address <-> coordinates for the map picker (V3 shop location, §5).
router.use('/geo', require('./modules/geo/geo.routes'));

// ---- V2 ----
router.use('/banners', require('./modules/banners/banner.routes'));
router.use('/discovery', require('./modules/discovery/discovery.routes'));
router.use('/search', require('./modules/search/search.routes'));
router.use('/claims', require('./modules/claims/claim.routes'));
// The merchant's side of the same workflow (Claim/Redemption §7-§11, §24-§26).
// Split from `/claims` on purpose: nothing a customer can reach is allowed to
// write a redemption, and separate routers make that impossible rather than
// merely unlikely.
router.use('/redemptions', require('./modules/claims/redemption.routes'));

// ---- V3 ----
router.use('/subscriptions', require('./modules/subscriptions/subscription.routes'));
router.use('/payments', require('./modules/payments/payment.routes'));
router.use('/feature-overrides', require('./modules/featureOverrides/featureOverride.routes'));
router.use('/campaigns', require('./modules/campaigns/campaign.routes'));

// ---- V3: premium AI ----
// The AI plan catalogue is a separate prefix from `/subscriptions` on purpose.
// `/subscriptions` owns billing - what a shop is paying and when it renews.
// `/subscription-plans` owns what each plan *unlocks* in the AI layer, which is
// Super Admin configuration rather than commerce. Keeping them apart is what
// stopped the two branches' `GET /plans` from colliding on one path.
router.use('/subscription-plans', require('./modules/subscriptions/plan.routes'));
router.use('/ai', require('./modules/ai/ai.routes'));

// ---- V5: Business Dashboard (Super Admin only) ----
// A sibling of `/analytics` rather than a child of it, because it answers a
// different question for a different person: `/analytics` is the merchant's
// view of their own shop, this is the platform owner's view of the business
// (Business §1: "This dashboard is separate from merchant dashboards"). The
// router requires Super Admin on every route it owns.
router.use('/business', require('./modules/business/business.routes'));

// Support tickets, About/Privacy contact details, and content reports. Not
// versioned with a release: it is the desk the whole platform points at.
router.use('/support', require('./modules/support/support.routes'));

// ---- Visibility & Promotion System ----
// Four routers, mounted most-specific first so `/visibility/admin` is matched
// by the admin router rather than swallowed by the customer one's `/:...`
// routes. The split is by *audience*, not by entity: what a customer may read,
// what a merchant may manage, what a merchant may measure, and what only the
// platform owner may configure (§22, §24).
router.use('/visibility/admin', require('./modules/visibility/visibilityAdmin.routes'));
router.use('/visibility/analytics', require('./modules/visibility/visibilityAnalytics.routes'));
router.use('/visibility', require('./modules/visibility/visibility.routes'));
router.use('/featured-campaigns', require('./modules/visibility/featuredCampaign.routes'));

// ---- V4: Services ----
router.use('/services', require('./modules/services/service.routes'));
router.use('/service-offer-claims', require('./modules/services/serviceOfferClaim.routes'));
router.use('/saved-services', require('./modules/savedServices/savedService.routes'));
router.use('/service-analytics', require('./modules/services/serviceAnalytics.routes'));

module.exports = router;
