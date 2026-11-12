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
    // Stripe's "Managed Payments" (Stripe as merchant-of-record, handling
    // tax collection/remittance globally) is on by default for this
    // account and requires every product to carry an eligible tax code —
    // ours doesn't, since this integration was built as a standard
    // Checkout flow (JEGASEC as merchant of record, not Stripe). Opting
    // out here keeps that assumption true rather than silently inheriting
    // Managed Payments' different invoicing/branding/tax behaviour.
    managed_payments: { enabled: false },
  });
}

// Starts a one-off Stripe Checkout payment ($17.50 AUD) that the frontend
// redirects to when a customer clicks "Add Vehicle" — this is the explicit
// payment prompt, distinct from createCheckoutSession above (which only
// runs once, at initial signup, to establish the recurring subscription).
// No pre-created Product/Price is needed: `price_data` builds an ad-hoc
// one-time line item. The vehicle's details travel in metadata so the
// webhook handler can create the vehicle only once Stripe confirms payment
// actually succeeded — never before. `managed_payments: { enabled: false }`
// mirrors createCheckoutSession for the same tax-code reason (see there).
async function createVehicleAddCheckoutSession({ orgId, stripeCustomerId, plate, label, driver, fuelType }) {
  const s = requireStripe();
  return s.checkout.sessions.create({
    mode: 'payment',
    customer: stripeCustomerId,
    client_reference_id: orgId,
    line_items: [
      {
        price_data: {
          currency: 'aud',
          unit_amount: 1750,
          product_data: {
            name: `Fleet Shield — Add Vehicle (${plate} · ${label})`,
            description: 'Adds one vehicle to your Fleet Shield subscription at $17.50 AUD/vehicle/month going forward.',
          },
        },
        quantity: 1,
      },
    ],
    success_url: `${APP_BASE_URL}/?vehicleAdded=1&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${APP_BASE_URL}/?vehicleCancelled=1`,
    metadata: {
      orgId,
      action: 'add_vehicle',
      plate,
      label,
      driver: driver || '',
      fuelType,
    },
    managed_payments: { enabled: false },
  });
}

// Called after a vehicle is added/removed so the bill always matches the
// live fleet size. `proration_behavior: 'create_prorations'` (Stripe's
// default) means an upgrade mid-cycle is charged pro-rata rather than
// waiting for the next invoice, and a downgrade credits the difference —
// standard behaviour for usage-that-changes-over-time billing.
//
// Exception: when a vehicle was just added via createVehicleAddCheckoutSession
// above, the customer already paid the equivalent $17.50 up front through
// that one-time Checkout charge — passing prorationBehavior: 'none' here
// stops Stripe from *also* generating a prorated charge for the same
// vehicle's remaining days in the current billing period, which would be a
// double charge. The subscription's quantity still increases, so next
// month's recurring invoice correctly bills for it going forward.
async function syncSubscriptionQuantity({ subscriptionId, subItemId, quantity, prorationBehavior = 'create_prorations' }) {
  const s = requireStripe();
  return s.subscriptionItems.update(subItemId, {
    quantity: Math.max(0, quantity),
    proration_behavior: prorationBehavior,
  });
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
  createVehicleAddCheckoutSession,
  syncSubscriptionQuantity,
  verifyWebhookSignature,
  retrieveSubscription,
};
