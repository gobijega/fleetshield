/**
 * Stripe billing helpers for Fleet Shield's per-vehicle subscription.
 *
 * Deliberately thin: real card collection happens entirely on Stripe's
 * hosted Checkout page (mode: 'subscription'), never in our own forms — we
 * never see or store a raw card number, which keeps this app out of PCI
 * scope beyond the lightest tier (SAQ A). The only things this file does
 * are (1) start a Checkout session, (2) verify + interpret webhook events
 * Stripe sends back, and (3) push a quantity change to an existing
 * subscription when a customer adds/removes a vehicle.
 *
 * Requires STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID, and
 * APP_BASE_URL (for Checkout's success/cancel redirect targets) as env
 * vars. All optional at require-time (server.js decides whether billing is
 * enabled) so local dev / the existing single-admin deployment can run
 * without them.
 */
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || null;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || null;
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || null;
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';

const billingEnabled = Boolean(STRIPE_SECRET_KEY && STRIPE_WEBHOOK_SECRET && STRIPE_PRICE_ID);

let stripe = null;
if (STRIPE_SECRET_KEY) {
  // Lazy require so the `stripe` package only needs to be installed/loaded
  // when billing is actually configured.
  stripe = require('stripe')(STRIPE_SECRET_KEY);
}

function requireStripe() {
  if (!stripe) {
    throw new Error(
      'Billing is not configured — set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID, APP_BASE_URL.'
    );
  }
  return stripe;
}

async function createCustomer({ orgId, name, email }) {
  const s = requireStripe();
  return s.customers.create({
    name,
    email,
    metadata: { orgId },
  });
}

// Starts a hosted Checkout Session for a brand-new subscription. Quantity
// defaults to 1 at signup (Stripe requires a positive quantity); it's
// corrected automatically the moment the org's real vehicle count diverges,
// via syncSubscriptionQuantity below.
async function createCheckoutSession({ orgId, stripeCustomerId, initialQuantity = 1 }) {
  const s = requireStripe();
  return s.checkout.sessions.create({
    mode: 'subscription',
    customer: stripeCustomerId,
    client_reference_id: orgId,
    line_items: [{ price: STRIPE_PRICE_ID, quantity: Math.max(1, initialQuantity) }],
    success_url: `${APP_BASE_URL}/signup-success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${APP_BASE_URL}/signup.html?cancelled=1`,
    subscription_data: { metadata: { orgId } },
    allow_promotion_codes: true,
  });
}

// Called after a vehicle is added/removed so the bill always matches the
// live fleet size. `proration_behavior: 'create_prorations'` (Stripe's
// default) means an upgrade mid-cycle is charged pro-rata rather than
// waiting for the next invoice, and a downgrade credits the difference —
// standard behaviour for usage-that-changes-over-time billing.
async function syncSubscriptionQuantity({ subscriptionId, subItemId, quantity }) {
  const s = requireStripe();
  return s.subscriptionItems.update(subItemId, { quantity: Math.max(0, quantity) });
}

// Verifies the raw webhook payload against STRIPE_WEBHOOK_SECRET and
// returns the parsed event, or throws if the signature doesn't match —
// callers must mount this route with express.raw() (not express.json())
// so `payload` here is the untouched request body Stripe signed.
function verifyWebhookSignature(payload, signatureHeader) {
  const s = requireStripe();
  return s.webhooks.constructEvent(payload, signatureHeader, STRIPE_WEBHOOK_SECRET);
}

async function retrieveSubscription(subscriptionId) {
  const s = requireStripe();
  return s.subscriptions.retrieve(subscriptionId);
}

module.exports = {
  billingEnabled,
  createCustomer,
  createCheckoutSession,
  syncSubscriptionQuantity,
  verifyWebhookSignature,
  retrieveSubscription,
};
