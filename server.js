/**
 * Fleet Shield — multi-tenant backend
 *
 * Simulates a fleet of vehicles moving along real-world-style routes,
 * generates driver-behaviour events, evaluates geofences, and streams live
 * updates to connected dashboards over WebSocket while exposing a REST API
 * for alerts, geofences, and reports.
 *
 * Multi-tenant: every organization that signs up (see /api/signup) gets its
 * own isolated fleet, scoped by org_id everywhere — in Postgres via the
 * org_id column added on every fleet table, and in memory via `orgStates`,
 * a Map keyed by org id instead of one global `state` object. The original
 * single-admin deployment is preserved as the 'default' org (bootstrapped
 * from ADMIN_USERNAME/ADMIN_PASSWORD_HASH at boot) so nothing changes for
 * the existing production login and its already-seeded demo fleet.
 *
 * Billing: subscriptions are $17.50 AUD/vehicle/month via Stripe Checkout
 * (hosted — card details never touch this server). The subscription's
 * quantity is kept in sync with the org's live vehicle count on every
 * add/remove (see lib/billing.js). See README's "Billing" section for the
 * full flow.
 *
 * No real hardware/device feed is required — this demonstrates the
 * software layer (ingestion, processing, alerting, reporting, live map,
 * billing) that a real telematics deployment would sit on top of.
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { WebSocketServer } = require('ws');
const db = require('./db');
const { sessionMiddleware, attachAuthRoutes, requireAuth, verifyWsClient, requireCsrf, audit } = require('./auth');
const {
  ROUTES,
  EMISSION_FACTORS_KG,
  SERVICE_INTERVAL_KM,
  SEED_VEHICLES,
  SEED_GEOFENCES,
  haversineKm,
  uid,
  nowIso,
} = require('./lib/fleet-data');
const { backfillVehicleHistory, backfillAlerts } = require('./lib/backfill');
const orgs = require('./lib/organizations');
const billing = require('./lib/billing');

const PORT = process.env.PORT || 3000;
const TICK_MS = 2000; // simulation heartbeat
const ROUTE_KEYS = Object.keys(ROUTES);

// Fuel-type defaults for vehicles added via the self-service "Add vehicle"
// form (which only asks for label/driver/fuel type) — reasonable stand-ins
// for the operating characteristics the simulation needs, in the same
// ballpark as SEED_VEHICLES until real device data replaces simulation.
const FUEL_DEFAULTS = {
  diesel: { consumptionPer100: 14, idleRatePerHour: 1.3 },
  petrol: { consumptionPer100: 10, idleRatePerHour: 0.9 },
  ev: { consumptionPer100: 20, idleRatePerHour: 1.0 },
};

function lerp(a, b, t) {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

// How often (in ticks) to persist a position row per vehicle.
const DB_WRITE_EVERY_N_TICKS = parseInt(process.env.DB_WRITE_EVERY_N_TICKS || '1', 10);

// ---------------------------------------------------------------------------
// Simulation state — one entry per organization (hot cache, mirrors
// Postgres, restored from it on boot / lazily created for new signups).
// ---------------------------------------------------------------------------

const orgStates = new Map(); // orgId -> { vehicles: Map, alerts: [], geofences: [] }
const ALERTS_MAX = 500;
let tickCounter = 0;

function getOrgState(orgId) {
  let s = orgStates.get(orgId);
  if (!s) {
    s = { vehicles: new Map(), alerts: [], geofences: [] };
    orgStates.set(orgId, s);
  }
  return s;
}

const ALERT_SEVERITY_WEIGHT = { high: 8, medium: 4, low: 1, info: 0 };

function safetyScore(orgState, vehicleId) {
  const weight = orgState.alerts
    .filter((a) => a.vehicleId === vehicleId)
    .reduce((s, a) => s + (ALERT_SEVERITY_WEIGHT[a.severity] || 0), 0);
  return Math.max(0, 100 - weight);
}

function daysUntil(dateStr) {
  return Math.round((new Date(dateStr).getTime() - Date.now()) / 86400000);
}

function complianceStatus(days) {
  if (days < 0) return 'overdue';
  if (days <= 30) return 'due_soon';
  return 'ok';
}

// ---------------------------------------------------------------------------
// Database bootstrap
// ---------------------------------------------------------------------------

async function ensureDefaultOrgSeed() {
  const { rows: vRows } = await db.query(`SELECT count(*)::int AS n FROM vehicles WHERE org_id = 'default'`);
  if (vRows[0].n === 0) {
    console.log("vehicles table empty for 'default' org — seeding from SEED_VEHICLES...");
    for (const v of SEED_VEHICLES) {
      const regoExpiryDate = new Date(Date.now() + v.regoOffsetDays * 86400000)
        .toISOString()
        .slice(0, 10);
      await db.query(
        `INSERT INTO vehicles
          (id, label, driver, route, speed_limit, base_speed, fuel_type, consumption_per_100, idle_rate_per_hour, starting_odometer_km, rego_expiry_date, org_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'default')
         ON CONFLICT (id) DO NOTHING`,
        [v.id, v.label, v.driver, v.route, v.speedLimit, v.baseSpeed, v.fuelType, v.consumptionPer100, v.idleRatePerHour, v.startingOdometerKm, regoExpiryDate]
      );
    }

    // Fresh install — backfill ~14 days of realistic simulated operating
    // history so Reports has something to show from the very first load.
    // Gated on the 'default' org's vehicles table being empty, so it never
    // re-runs and piles up extra history on a restart.
    console.log('Backfilling ~14 days of simulated fleet history for Reports...');
    const backfillSummary = await backfillVehicleHistory(db, SEED_VEHICLES, { days: 14 }, 'default');
    const alertsInserted = await backfillAlerts(db, SEED_VEHICLES, { days: 14 }, 'default');
    const totalKm = backfillSummary.reduce((s, v) => s + v.addedKm, 0);
    console.log(`Backfill complete: ~${totalKm} km and ${alertsInserted} alerts across ${backfillSummary.length} vehicles.`);
  }

  const { rows: gRows } = await db.query(`SELECT count(*)::int AS n FROM geofences WHERE org_id = 'default'`);
  if (gRows[0].n === 0) {
    console.log("geofences table empty for 'default' org — seeding from SEED_GEOFENCES...");
    for (const g of SEED_GEOFENCES) {
      await db.query(
        `INSERT INTO geofences (id, name, lat, lng, radius_m, type, org_id) VALUES ($1,$2,$3,$4,$5,$6,'default')
         ON CONFLICT (id) DO NOTHING`,
        [g.id, g.name, g.lat, g.lng, g.radiusM, g.type]
      );
    }
  }
}

async function loadVehiclesForOrg(orgId) {
  const { rows } = await db.query('SELECT * FROM vehicles WHERE org_id = $1 ORDER BY id', [orgId]);
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    driver: r.driver,
    route: r.route,
    speedLimit: r.speed_limit,
    baseSpeed: r.base_speed,
    fuelType: r.fuel_type,
    consumptionPer100: Number(r.consumption_per_100),
    idleRatePerHour: Number(r.idle_rate_per_hour),
    startingOdometerKm: Number(r.starting_odometer_km),
    regoExpiryDate: r.rego_expiry_date.toISOString().slice(0, 10),
  }));
}

async function loadGeofencesForOrg(orgId) {
  const { rows } = await db.query('SELECT * FROM geofences WHERE org_id = $1 ORDER BY created_at', [orgId]);
  return rows.map((g) => ({
    id: g.id,
    name: g.name,
    lat: Number(g.lat),
    lng: Number(g.lng),
    radiusM: g.radius_m,
    type: g.type,
  }));
}

async function restoreLatestPosition(vehicleId) {
  const { rows } = await db.query(
    `SELECT * FROM positions WHERE vehicle_id = $1 ORDER BY ts DESC LIMIT 1`,
    [vehicleId]
  );
  return rows[0] || null;
}

async function initVehiclesForOrg(orgId, vehicleConfigs) {
  const orgState = getOrgState(orgId);
  for (const v of vehicleConfigs) {
    const route = ROUTES[v.route];
    const last = await restoreLatestPosition(v.id);
    orgState.vehicles.set(v.id, {
      ...v,
      segIndex: 0,
      segT: Math.random(),
      lat: route[0].lat,
      lng: route[0].lng,
      speedKmh: 0,
      headingDeg: 0,
      status: 'moving',
      idleTicks: 0,
      lastGeofence: new Set(),
      updatedAt: nowIso(),
      odometerKm: last ? Number(last.odometer_km) : 0,
      fuelUsedTotal: last ? Number(last.fuel_used_total) : 0,
      co2KgTotal: last ? Number(last.co2_kg_total) : 0,
      movingSec: last ? Number(last.moving_sec_total) : 0,
      idlingSec: last ? Number(last.idling_sec_total) : 0,
      tripCount: last ? last.trip_count : 0,
    });
  }
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

function pushAlert(orgId, orgState, alert) {
  const full = { id: uid('al'), t: nowIso(), ...alert };
  orgState.alerts.unshift(full);
  if (orgState.alerts.length > ALERTS_MAX) orgState.alerts.length = ALERTS_MAX;
  broadcast(orgId, { type: 'alert', alert: full });

  db.query(
    `INSERT INTO alerts (id, ts, vehicle_id, vehicle_label, type, severity, message, geofence_id, lat, lng, org_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [full.id, full.t, full.vehicleId || null, full.vehicleLabel || null, full.type, full.severity, full.message || null, full.geofenceId || null, full.lat ?? null, full.lng ?? null, orgId]
  ).catch((err) => console.error('Failed to persist alert', err.message));

  return full;
}

function checkGeofences(orgId, orgState, v) {
  for (const gf of orgState.geofences) {
    const distM = haversineKm(v, gf) * 1000;
    const inside = distM <= gf.radiusM;
    const wasInside = v.lastGeofence.has(gf.id);

    if (inside && !wasInside) {
      v.lastGeofence.add(gf.id);
      pushAlert(orgId, orgState, {
        type: gf.type === 'restricted' ? 'geofence_restricted_entry' : 'geofence_entry',
        severity: gf.type === 'restricted' ? 'high' : 'info',
        vehicleId: v.id,
        vehicleLabel: v.label,
        message: `${v.label} entered ${gf.name}`,
        geofenceId: gf.id,
        lat: v.lat,
        lng: v.lng,
      });
    } else if (!inside && wasInside) {
      v.lastGeofence.delete(gf.id);
      pushAlert(orgId, orgState, {
        type: 'geofence_exit',
        severity: 'info',
        vehicleId: v.id,
        vehicleLabel: v.label,
        message: `${v.label} exited ${gf.name}`,
        geofenceId: gf.id,
        lat: v.lat,
        lng: v.lng,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Simulation tick
// ---------------------------------------------------------------------------

function persistPositions(orgId, rows) {
  if (rows.length === 0) return;
  const cols = ['ts', 'vehicle_id', 'lat', 'lng', 'speed_kmh', 'heading_deg', 'status', 'odometer_km', 'fuel_used_total', 'co2_kg_total', 'moving_sec_total', 'idling_sec_total', 'trip_count', 'org_id'];
  const values = [];
  const placeholders = rows.map((r, i) => {
    const base = i * cols.length;
    values.push(r.ts, r.vehicleId, r.lat, r.lng, r.speedKmh, r.headingDeg, r.status, r.odometerKm, r.fuelUsedTotal, r.co2KgTotal, r.movingSec, r.idlingSec, r.tripCount, orgId);
    return `(${cols.map((_, j) => `$${base + j + 1}`).join(',')})`;
  });
  const sql = `INSERT INTO positions (${cols.join(',')}) VALUES ${placeholders.join(',')}`;
  db.query(sql, values).catch((err) => console.error('Failed to persist positions batch', err.message));
}

function tickOrg(orgId, orgState, shouldPersist) {
  const positionRows = [];

  for (const v of orgState.vehicles.values()) {
    const route = ROUTES[v.route];
    const from = route[v.segIndex];
    const to = route[(v.segIndex + 1) % route.length];

    if (v.segIndex === 0 && v.segT < 0.02) {
      if (v.idleTicks < 3) {
        v.idleTicks += 1;
        v.status = 'idling';
        v.speedKmh = 0;
        v.updatedAt = nowIso();
        v.idlingSec += TICK_MS / 1000;
        const idleFuel = v.idleRatePerHour * (TICK_MS / 3600000);
        v.fuelUsedTotal += idleFuel;
        v.co2KgTotal += idleFuel * EMISSION_FACTORS_KG[v.fuelType];
        if (shouldPersist) positionRows.push(snapshotRow(v));
        if (v.idleTicks === 3) {
          pushAlert(orgId, orgState, {
            type: 'excessive_idling',
            severity: 'low',
            vehicleId: v.id,
            vehicleLabel: v.label,
            message: `${v.label} idled for over ${v.idleTicks * (TICK_MS / 1000)}s at depot`,
            lat: v.lat,
            lng: v.lng,
          });
        }
        continue;
      }
      v.idleTicks = 0;
    }
    v.status = 'moving';

    const variance = (Math.random() - 0.5) * 12;
    let speed = Math.max(5, v.baseSpeed + variance);

    const roll = Math.random();
    if (roll < 0.025) {
      const prevSpeed = speed;
      speed = Math.max(5, speed * 0.35);
      pushAlert(orgId, orgState, {
        type: 'harsh_braking',
        severity: 'medium',
        vehicleId: v.id,
        vehicleLabel: v.label,
        message: `${v.label} harsh braking event (${Math.round(prevSpeed)} → ${Math.round(speed)} km/h)`,
        lat: v.lat,
        lng: v.lng,
      });
    } else if (roll > 0.975) {
      speed = speed * 1.4;
      pushAlert(orgId, orgState, {
        type: 'harsh_acceleration',
        severity: 'medium',
        vehicleId: v.id,
        vehicleLabel: v.label,
        message: `${v.label} harsh acceleration event (${Math.round(speed)} km/h)`,
        lat: v.lat,
        lng: v.lng,
      });
    }

    if (speed > v.speedLimit * 1.15) {
      pushAlert(orgId, orgState, {
        type: 'speeding',
        severity: 'high',
        vehicleId: v.id,
        vehicleLabel: v.label,
        message: `${v.label} speeding: ${Math.round(speed)} km/h in a ${v.speedLimit} km/h zone`,
        lat: v.lat,
        lng: v.lng,
      });
    }

    const segLenKm = haversineKm(from, to) || 0.0001;
    const kmPerTick = speed * (TICK_MS / 1000 / 3600);
    v.segT += kmPerTick / segLenKm;

    while (v.segT >= 1) {
      v.segT -= 1;
      v.odometerKm += segLenKm;
      v.segIndex = (v.segIndex + 1) % route.length;
      if (v.segIndex === 0) v.tripCount += 1;
    }

    const seg2From = route[v.segIndex];
    const seg2To = route[(v.segIndex + 1) % route.length];
    const pos = lerp(seg2From, seg2To, v.segT);
    v.headingDeg =
      (Math.atan2(seg2To.lng - seg2From.lng, seg2To.lat - seg2From.lat) * 180) / Math.PI;
    v.lat = pos.lat;
    v.lng = pos.lng;
    v.speedKmh = Math.round(speed);
    v.updatedAt = nowIso();
    v.movingSec += TICK_MS / 1000;

    const fuelUsed = kmPerTick * (v.consumptionPer100 / 100);
    v.fuelUsedTotal += fuelUsed;
    v.co2KgTotal += fuelUsed * EMISSION_FACTORS_KG[v.fuelType];

    if (shouldPersist) positionRows.push(snapshotRow(v));
    checkGeofences(orgId, orgState, v);
  }

  if (shouldPersist) persistPositions(orgId, positionRows);
  broadcast(orgId, { type: 'positions', vehicles: serializeVehicles(orgState) });
}

function tick() {
  tickCounter += 1;
  const shouldPersist = tickCounter % DB_WRITE_EVERY_N_TICKS === 0;
  for (const [orgId, orgState] of orgStates.entries()) {
    tickOrg(orgId, orgState, shouldPersist);
  }
}

function snapshotRow(v) {
  return {
    ts: v.updatedAt,
    vehicleId: v.id,
    lat: v.lat,
    lng: v.lng,
    speedKmh: v.speedKmh,
    headingDeg: v.headingDeg,
    status: v.status,
    odometerKm: v.odometerKm,
    fuelUsedTotal: v.fuelUsedTotal,
    co2KgTotal: v.co2KgTotal,
    movingSec: v.movingSec,
    idlingSec: v.idlingSec,
    tripCount: v.tripCount,
  };
}

function serializeVehicles(orgState) {
  return Array.from(orgState.vehicles.values()).map((v) => {
    const totalSec = v.movingSec + v.idlingSec;
    return {
      id: v.id,
      label: v.label,
      driver: v.driver,
      lat: v.lat,
      lng: v.lng,
      speedKmh: v.speedKmh,
      headingDeg: Math.round(v.headingDeg),
      status: v.status,
      speedLimit: v.speedLimit,
      odometerKm: Math.round(v.odometerKm * 10) / 10,
      fuelType: v.fuelType,
      co2Kg: Math.round(v.co2KgTotal * 10) / 10,
      utilisationPct: totalSec ? Math.round((v.movingSec / totalSec) * 1000) / 10 : 0,
      safetyScore: safetyScore(orgState, v.id),
      updatedAt: v.updatedAt,
    };
  });
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------

const app = express();
app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https://*.basemaps.cartocdn.com'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', apiLimiter);

// Stripe's webhook signature check needs the *raw* request body, so this
// route is mounted before express.json() with express.raw() scoped to just
// this path — every other /api/ route still gets parsed JSON as normal.
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!billing.billingEnabled) return res.status(503).json({ error: 'Billing not configured.' });
  let event;
  try {
    event = billing.verifyWebhookSignature(req.body, req.get('Stripe-Signature'));
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature.' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const orgId = session.client_reference_id || session.metadata?.orgId;

        if (orgId && session.mode === 'subscription' && session.subscription) {
          // Initial signup Checkout — establishes the recurring subscription.
          const subscription = await billing.retrieveSubscription(session.subscription);
          const subItemId = subscription.items.data[0]?.id;
          await orgs.setStripeSubscription(db, orgId, {
            subscriptionId: subscription.id,
            subItemId,
            status: subscription.status, // 'active' or 'trialing'
          });
          await audit('subscription_activated', { orgId, detail: subscription.id });
        } else if (orgId && session.mode === 'payment' && session.metadata?.action === 'add_vehicle') {
          // Paid Add Vehicle flow — only create the vehicle now that Stripe
          // confirms the $17.50 one-time charge actually succeeded.
          const org = await orgs.findOrgById(db, orgId);
          if (!org) {
            console.error(`add_vehicle webhook: no org found for ${orgId}`);
            break;
          }
          const { label, driver, fuelType } = session.metadata;
          const v = await insertVehicleForOrg(orgId, { label, driver, fuelType });
          await audit('vehicle_added', { orgId, detail: `${v.id}: ${v.label} (paid via Checkout, session ${session.id})` });
          const orgState = getOrgState(orgId);
          // prorationBehavior: 'none' — the customer already paid the
          // equivalent amount via this one-time charge, so don't also
          // generate a prorated charge for the rest of the current period.
          await syncOrgSubscriptionQuantity(org, orgState.vehicles.size, 'none');
        }
        break;
      }
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const org = await orgs.findOrgByStripeCustomer(db, subscription.customer);
        if (org) {
          await orgs.setStripeSubscription(db, org.id, {
            subscriptionId: subscription.id,
            subItemId: subscription.items.data[0]?.id,
            status: subscription.status,
          });
          await audit('subscription_updated', { orgId: org.id, detail: subscription.status });
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        await orgs.setSubscriptionStatusByCustomer(db, subscription.customer, 'canceled');
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        if (invoice.customer) {
          await orgs.setSubscriptionStatusByCustomer(db, invoice.customer, 'past_due');
        }
        break;
      }
      case 'invoice.paid': {
        const invoice = event.data.object;
        if (invoice.customer) {
          const org = await orgs.findOrgByStripeCustomer(db, invoice.customer);
          // Only clear a past_due flag — don't stomp 'canceled'/'incomplete'
          // if this event arrives out of order.
          if (org && org.subscription_status === 'past_due') {
            await orgs.setSubscriptionStatusByCustomer(db, invoice.customer, 'active');
          }
        }
        break;
      }
      default:
        break;
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Error handling Stripe webhook event', event.type, err);
    res.status(500).json({ error: 'Webhook handler error.' });
  }
});

app.use(express.json());
app.use(sessionMiddleware);

// Login page, signup page, and their assets are intentionally public —
// everything else in this file is gated by requireAuth below.
app.use(express.static(path.join(__dirname, 'public')));
attachAuthRoutes(app);

app.get('/api/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ ok: true, db: 'connected' });
  } catch (err) {
    res.status(503).json({ ok: false, db: 'unreachable', error: err.message });
  }
});

// --- signup (public) --------------------------------------------------------

const PASSWORD_MIN_LENGTH = 12;
const NAME_MAX_LEN = 150;

function validateSignupInput(body) {
  const { orgName, contactName, contactEmail, username, password } = body || {};
  if (typeof orgName !== 'string' || !orgName.trim() || orgName.length > NAME_MAX_LEN) {
    return 'Organisation name is required.';
  }
  if (typeof contactEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
    return 'A valid contact email is required.';
  }
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_.-]{3,50}$/.test(username)) {
    return 'Username must be 3-50 characters (letters, numbers, . _ - only).';
  }
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (contactName !== undefined && (typeof contactName !== 'string' || contactName.length > NAME_MAX_LEN)) {
    return 'Contact name is too long.';
  }
  return null;
}

app.post('/api/signup', async (req, res) => {
  const validationError = validateSignupInput(req.body);
  if (validationError) return res.status(400).json({ error: validationError });

  const { orgName, contactName, contactEmail, username, password } = req.body;

  const existing = await orgs.findOrgByUsername(db, username);
  if (existing) {
    return res.status(409).json({ error: 'That username is already taken.' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const org = await orgs.createOrganization(db, {
      name: orgName.trim(),
      contactName: contactName ? contactName.trim() : null,
      contactEmail: contactEmail.trim(),
      adminUsername: username,
      adminPasswordHash: passwordHash,
    });
    await audit('org_created', { orgId: org.id, username, detail: orgName });

    if (!billing.billingEnabled) {
      // Billing not configured on this deployment — mark active so the
      // account is at least usable, and log it clearly. Production should
      // always have STRIPE_* env vars set before signup is exposed.
      console.warn(`Billing not configured — organization ${org.id} created without a Stripe subscription.`);
      await db.query(`UPDATE organizations SET subscription_status = 'active' WHERE id = $1`, [org.id]);
      return res.status(201).json({ ok: true, checkoutUrl: null });
    }

    const customer = await billing.createCustomer({ orgId: org.id, name: orgName.trim(), email: contactEmail.trim() });
    await orgs.setStripeCustomer(db, org.id, customer.id);
    const session = await billing.createCheckoutSession({ orgId: org.id, stripeCustomerId: customer.id, initialQuantity: 1 });
    res.status(201).json({ ok: true, checkoutUrl: session.url });
  } catch (err) {
    console.error('Signup failed:', err);
    res.status(500).json({ error: 'Signup failed. Please try again.' });
  }
});

// --- everything below requires an authenticated, org-scoped session -------

app.use(requireAuth);
app.use('/api/', requireCsrf);

// Subscription gate — blocks API/dashboard access for an org whose billing
// isn't active. Mounted after requireAuth (so req.orgId is set) and before
// the protected static files / API routes. 'past_due' is allowed through
// with a client-visible flag rather than an outright block, giving a grace
// period while Stripe's automatic retries run; 'incomplete' (checkout never
// finished) and 'canceled' are blocked.
async function requireActiveSubscription(req, res, next) {
  const org = await orgs.findOrgById(db, req.orgId);
  if (!org) return res.status(401).json({ error: 'Not authenticated.' });
  if (org.subscription_status === 'incomplete' || org.subscription_status === 'canceled') {
    if (req.path.startsWith('/api/')) {
      return res.status(402).json({ error: 'Subscription is not active.', subscriptionStatus: org.subscription_status });
    }
    return res.redirect('/login.html?billing=required');
  }
  req.org = org;
  next();
}
app.use(requireActiveSubscription);

app.use(express.static(path.join(__dirname, 'protected')));

app.get('/api/me', (req, res) => {
  const orgState = getOrgState(req.orgId);
  res.json({
    orgId: req.org.id,
    orgName: req.org.name,
    subscriptionStatus: req.org.subscription_status,
    vehicleCount: orgState.vehicles.size,
    pricePerVehicleAud: 17.5,
  });
});

app.get('/api/vehicles', (req, res) => {
  res.json(serializeVehicles(getOrgState(req.orgId)));
});

const VEHICLE_LABEL_MAX_LEN = 100;
const VEHICLE_FUEL_TYPES = new Set(['diesel', 'petrol', 'ev']);

function validateVehicleInput(body) {
  const { label, driver, fuelType } = body || {};
  if (typeof label !== 'string' || !label.trim() || label.length > VEHICLE_LABEL_MAX_LEN) {
    return `label is required (string, 1-${VEHICLE_LABEL_MAX_LEN} chars)`;
  }
  if (driver !== undefined && driver !== null && (typeof driver !== 'string' || driver.length > VEHICLE_LABEL_MAX_LEN)) {
    return 'driver must be a string';
  }
  if (!VEHICLE_FUEL_TYPES.has(fuelType)) {
    return `fuelType must be one of: ${Array.from(VEHICLE_FUEL_TYPES).join(', ')}`;
  }
  return null;
}

async function syncOrgSubscriptionQuantity(org, vehicleCount, prorationBehavior = 'create_prorations') {
  if (!billing.billingEnabled || !org.stripe_sub_item_id) return;
  try {
    await billing.syncSubscriptionQuantity({
      subscriptionId: org.stripe_subscription_id,
      subItemId: org.stripe_sub_item_id,
      quantity: vehicleCount,
      prorationBehavior,
    });
  } catch (err) {
    // Never block the vehicle add/remove on a billing hiccup — log loudly
    // so it can be reconciled, but the fleet operation itself still succeeds.
    console.error(`Failed to sync subscription quantity for org ${org.id}:`, err.message);
  }
}

// Shared by POST /api/vehicles (direct add — used when billing is disabled)
// and the Stripe webhook handler (payment-confirmed add — the normal path
// once billing is enabled). Inserts the row, seeds the in-memory sim state,
// and returns the vehicle so the caller can respond/log as appropriate.
async function insertVehicleForOrg(orgId, { label, driver, fuelType }) {
  const orgState = getOrgState(orgId);
  const defaults = FUEL_DEFAULTS[fuelType];
  const route = ROUTE_KEYS[orgState.vehicles.size % ROUTE_KEYS.length];
  const regoExpiryDate = new Date(Date.now() + 180 * 86400000).toISOString().slice(0, 10);

  const v = {
    id: uid('veh'),
    label: label.trim(),
    driver: driver ? driver.trim() : null,
    route,
    speedLimit: 60,
    baseSpeed: 45,
    fuelType,
    consumptionPer100: defaults.consumptionPer100,
    idleRatePerHour: defaults.idleRatePerHour,
    startingOdometerKm: 0,
    regoExpiryDate,
  };

  await db.query(
    `INSERT INTO vehicles
      (id, label, driver, route, speed_limit, base_speed, fuel_type, consumption_per_100, idle_rate_per_hour, starting_odometer_km, rego_expiry_date, org_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [v.id, v.label, v.driver, v.route, v.speedLimit, v.baseSpeed, v.fuelType, v.consumptionPer100, v.idleRatePerHour, v.startingOdometerKm, v.regoExpiryDate, orgId]
  );
  await initVehiclesForOrg(orgId, [v]);
  return v;
}

// Direct add, no payment prompt — only reachable when billing isn't
// configured on this deployment (see POST /api/vehicles/checkout below for
// the normal, payment-gated path). Kept so local/dev environments without
// Stripe env vars still have a working "Add Vehicle" button.
app.post('/api/vehicles', async (req, res) => {
  if (billing.billingEnabled) {
    return res.status(400).json({ error: 'Use POST /api/vehicles/checkout — adding a vehicle requires payment on this deployment.' });
  }
  const validationError = validateVehicleInput(req.body);
  if (validationError) return res.status(400).json({ error: validationError });

  const { label, driver, fuelType } = req.body;
  try {
    const v = await insertVehicleForOrg(req.orgId, { label, driver, fuelType });
    await audit('vehicle_added', { orgId: req.orgId, username: req.session.username, ip: req.ip, detail: `${v.id}: ${v.label}` });
    const orgState = getOrgState(req.orgId);
    await syncOrgSubscriptionQuantity(req.org, orgState.vehicles.size);
    res.status(201).json(serializeVehicles(orgState).find((sv) => sv.id === v.id));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'insert failed' });
  }
});

// Payment-gated add: creates a one-time $17.50 AUD Stripe Checkout session
// and hands the frontend the URL to redirect to. The vehicle itself is NOT
// created here — it's created by the webhook handler below, only once
// Stripe confirms the payment actually went through (checkout.session.completed).
// This is deliberate: creating the vehicle here (before payment) would let a
// customer add vehicles for free by never completing Checkout.
app.post('/api/vehicles/checkout', async (req, res) => {
  const validationError = validateVehicleInput(req.body);
  if (validationError) return res.status(400).json({ error: validationError });
  if (!billing.billingEnabled) {
    return res.status(400).json({ error: 'Billing is not configured on this deployment.' });
  }
  if (!req.org.stripe_customer_id) {
    return res.status(400).json({ error: 'No Stripe customer on file for this account. Contact support.' });
  }

  const { label, driver, fuelType } = req.body;
  try {
    const session = await billing.createVehicleAddCheckoutSession({
      orgId: req.orgId,
      stripeCustomerId: req.org.stripe_customer_id,
      label: label.trim(),
      driver: driver ? driver.trim() : '',
      fuelType,
    });
    res.json({ checkoutUrl: session.url });
  } catch (err) {
    console.error('Failed to create vehicle-add checkout session:', err);
    res.status(500).json({ error: 'Could not start payment. Please try again.' });
  }
});

app.delete('/api/vehicles/:id', async (req, res) => {
  const orgState = getOrgState(req.orgId);
  if (!orgState.vehicles.has(req.params.id)) {
    return res.status(404).json({ error: 'vehicle not found' });
  }
  try {
    await db.query('DELETE FROM vehicles WHERE id = $1 AND org_id = $2', [req.params.id, req.orgId]);
    orgState.vehicles.delete(req.params.id);
    await audit('vehicle_removed', { orgId: req.orgId, username: req.session.username, ip: req.ip, detail: req.params.id });
    await syncOrgSubscriptionQuantity(req.org, orgState.vehicles.size);
    res.json({ removed: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'delete failed' });
  }
});

app.get('/api/vehicles/:id/trips', async (req, res) => {
  const orgState = getOrgState(req.orgId);
  if (!orgState.vehicles.has(req.params.id)) {
    return res.status(404).json({ error: 'vehicle not found' });
  }
  const hours = Math.min(parseFloat(req.query.hours) || 2, 168);
  const limit = Math.min(parseInt(req.query.limit, 10) || 1000, 1000);
  try {
    const { rows } = await db.query(
      `SELECT ts, lat, lng, speed_kmh FROM positions
       WHERE vehicle_id = $1 AND org_id = $2 AND ts > now() - ($3 || ' hours')::interval
       ORDER BY ts ASC LIMIT $4`,
      [req.params.id, req.orgId, hours, limit]
    );
    res.json(rows.map((r) => ({ t: r.ts, lat: Number(r.lat), lng: Number(r.lng), speed: Number(r.speed_kmh) })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'query failed' });
  }
});

app.get('/api/alerts', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 1000);
  try {
    const params = [req.orgId, limit];
    let vehicleFilter = '';
    if (req.query.vehicleId) {
      params.push(req.query.vehicleId);
      vehicleFilter = 'AND vehicle_id = $3';
    }
    const { rows } = await db.query(
      `SELECT * FROM alerts WHERE org_id = $1 ${vehicleFilter} ORDER BY ts DESC LIMIT $2`,
      params
    );
    res.json(
      rows.map((r) => ({
        id: r.id,
        t: r.ts,
        vehicleId: r.vehicle_id,
        vehicleLabel: r.vehicle_label,
        type: r.type,
        severity: r.severity,
        message: r.message,
        geofenceId: r.geofence_id,
        lat: r.lat != null ? Number(r.lat) : null,
        lng: r.lng != null ? Number(r.lng) : null,
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'query failed' });
  }
});

app.get('/api/reports/daily/:vehicleId', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT date_trunc('day', ts) AS day,
              round((max(odometer_km) - min(odometer_km))::numeric, 1) AS km_travelled,
              round((max(co2_kg_total) - min(co2_kg_total))::numeric, 1) AS co2_kg,
              round(avg(speed_kmh)::numeric, 1) AS avg_speed_kmh
       FROM positions
       WHERE vehicle_id = $1 AND org_id = $2
       GROUP BY day
       ORDER BY day DESC
       LIMIT 30`,
      [req.params.vehicleId, req.orgId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'query failed' });
  }
});

app.get('/api/geofences', (req, res) => {
  res.json(getOrgState(req.orgId).geofences);
});

const GEOFENCE_TYPES = new Set(['depot', 'restricted', 'custom']);
const GEOFENCE_MAX_RADIUS_M = 50000;
const GEOFENCE_NAME_MAX_LEN = 100;

function validateGeofenceInput(body) {
  const { name, lat, lng, radiusM, type } = body || {};
  if (typeof name !== 'string' || !name.trim() || name.length > GEOFENCE_NAME_MAX_LEN) {
    return `name is required (string, 1-${GEOFENCE_NAME_MAX_LEN} chars)`;
  }
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    return 'lat must be a number between -90 and 90';
  }
  if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    return 'lng must be a number between -180 and 180';
  }
  if (typeof radiusM !== 'number' || !Number.isFinite(radiusM) || radiusM <= 0 || radiusM > GEOFENCE_MAX_RADIUS_M) {
    return `radiusM must be a positive number up to ${GEOFENCE_MAX_RADIUS_M}`;
  }
  if (type !== undefined && !GEOFENCE_TYPES.has(type)) {
    return `type must be one of: ${Array.from(GEOFENCE_TYPES).join(', ')}`;
  }
  return null;
}

app.post('/api/geofences', async (req, res) => {
  const validationError = validateGeofenceInput(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }
  const { name, lat, lng, radiusM, type } = req.body;
  const gf = { id: uid('gf'), name: name.trim(), lat, lng, radiusM, type: type || 'custom' };
  try {
    await db.query(
      `INSERT INTO geofences (id, name, lat, lng, radius_m, type, org_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [gf.id, gf.name, gf.lat, gf.lng, gf.radiusM, gf.type, req.orgId]
    );
    getOrgState(req.orgId).geofences.push(gf);
    audit('geofence_created', { orgId: req.orgId, username: req.session.username, ip: req.ip, detail: `${gf.id}: ${gf.name}` });
    res.status(201).json(gf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'insert failed' });
  }
});

app.delete('/api/geofences/:id', async (req, res) => {
  try {
    const result = await db.query('DELETE FROM geofences WHERE id = $1 AND org_id = $2', [req.params.id, req.orgId]);
    const orgState = getOrgState(req.orgId);
    orgState.geofences = orgState.geofences.filter((g) => g.id !== req.params.id);
    for (const v of orgState.vehicles.values()) v.lastGeofence.delete(req.params.id);
    if (result.rowCount > 0) {
      audit('geofence_deleted', { orgId: req.orgId, username: req.session.username, ip: req.ip, detail: req.params.id });
    }
    res.json({ removed: result.rowCount > 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'delete failed' });
  }
});

app.get('/api/audit', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
  try {
    const { rows } = await db.query(
      `SELECT id, ts, event_type, username, ip, success, detail FROM audit_log WHERE org_id = $1 ORDER BY ts DESC LIMIT $2`,
      [req.orgId, limit]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'query failed' });
  }
});

app.get('/api/reports/summary', (req, res) => {
  const orgState = getOrgState(req.orgId);
  const vehicles = Array.from(orgState.vehicles.values());
  const totalKm = vehicles.reduce((s, v) => s + v.odometerKm, 0);
  const avgSpeed =
    vehicles.reduce((s, v) => s + v.speedKmh, 0) / (vehicles.length || 1);
  const idling = vehicles.filter((v) => v.status === 'idling').length;
  const totalCO2Kg = vehicles.reduce((s, v) => s + v.co2KgTotal, 0);
  const avgUtilisation =
    vehicles.reduce((s, v) => {
      const total = v.movingSec + v.idlingSec;
      return s + (total ? (v.movingSec / total) * 100 : 0);
    }, 0) / (vehicles.length || 1);

  const alertCounts = {};
  for (const a of orgState.alerts) {
    alertCounts[a.type] = (alertCounts[a.type] || 0) + 1;
  }

  const perVehicle = vehicles.map((v) => {
    const total = v.movingSec + v.idlingSec;
    return {
      id: v.id,
      label: v.label,
      driver: v.driver,
      odometerKm: Math.round(v.odometerKm * 10) / 10,
      status: v.status,
      speedKmh: v.speedKmh,
      fuelType: v.fuelType,
      co2Kg: Math.round(v.co2KgTotal * 10) / 10,
      utilisationPct: total ? Math.round((v.movingSec / total) * 1000) / 10 : 0,
      tripCount: v.tripCount,
      safetyScore: safetyScore(orgState, v.id),
      alerts: orgState.alerts.filter((a) => a.vehicleId === v.id).length,
    };
  });

  res.json({
    generatedAt: nowIso(),
    fleetSize: vehicles.length,
    totalDistanceKm: Math.round(totalKm * 10) / 10,
    avgSpeedKmh: Math.round(avgSpeed * 10) / 10,
    vehiclesIdling: idling,
    totalAlerts: orgState.alerts.length,
    totalCO2Kg: Math.round(totalCO2Kg * 10) / 10,
    avgUtilisationPct: Math.round(avgUtilisation * 10) / 10,
    alertCounts,
    perVehicle,
  });
});

app.get('/api/reports/emissions', (req, res) => {
  const orgState = getOrgState(req.orgId);
  const vehicles = Array.from(orgState.vehicles.values());
  const totalCO2Kg = vehicles.reduce((s, v) => s + v.co2KgTotal, 0);
  const totalFuelL = vehicles
    .filter((v) => v.fuelType !== 'ev')
    .reduce((s, v) => s + v.fuelUsedTotal, 0);
  const totalEnergyKwh = vehicles
    .filter((v) => v.fuelType === 'ev')
    .reduce((s, v) => s + v.fuelUsedTotal, 0);

  const byFuelType = {};
  for (const v of vehicles) {
    if (!byFuelType[v.fuelType]) byFuelType[v.fuelType] = { vehicles: 0, co2Kg: 0 };
    byFuelType[v.fuelType].vehicles += 1;
    byFuelType[v.fuelType].co2Kg += v.co2KgTotal;
  }
  for (const k of Object.keys(byFuelType)) {
    byFuelType[k].co2Kg = Math.round(byFuelType[k].co2Kg * 10) / 10;
  }

  res.json({
    generatedAt: nowIso(),
    totalCO2Kg: Math.round(totalCO2Kg * 10) / 10,
    totalFuelL: Math.round(totalFuelL * 10) / 10,
    totalEnergyKwh: Math.round(totalEnergyKwh * 10) / 10,
    byFuelType,
    perVehicle: vehicles.map((v) => ({
      id: v.id,
      label: v.label,
      fuelType: v.fuelType,
      co2Kg: Math.round(v.co2KgTotal * 10) / 10,
      fuelUsed: Math.round(v.fuelUsedTotal * 10) / 10,
      unit: v.fuelType === 'ev' ? 'kWh' : 'L',
      co2PerKm: v.odometerKm ? Math.round((v.co2KgTotal / v.odometerKm) * 1000) / 1000 : 0,
    })),
  });
});

app.get('/api/compliance', (req, res) => {
  const vehicles = Array.from(getOrgState(req.orgId).vehicles.values());
  res.json(
    vehicles.map((v) => {
      const kmTotal = v.startingOdometerKm + v.odometerKm;
      const kmSinceService = kmTotal % SERVICE_INTERVAL_KM;
      const kmToNextService = Math.round(SERVICE_INTERVAL_KM - kmSinceService);
      const regoDays = daysUntil(v.regoExpiryDate);
      return {
        id: v.id,
        label: v.label,
        driver: v.driver,
        safetyScore: safetyScore(getOrgState(req.orgId), v.id),
        regoExpiryDate: v.regoExpiryDate,
        regoDaysRemaining: regoDays,
        regoStatus: complianceStatus(regoDays),
        odometerKm: Math.round(kmTotal * 10) / 10,
        kmToNextService,
        serviceStatus: kmToNextService <= 1000 ? (kmToNextService < 0 ? 'overdue' : 'due_soon') : 'ok',
      };
    })
  );
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', verifyClient: verifyWsClient });

// Only pushes to clients belonging to the given org — this is the whole
// tenant-isolation guarantee for the live feed: a WS connection's orgId is
// fixed at auth time (verifyWsClient) and never changes.
function broadcast(orgId, payload) {
  const msg = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN && client.orgId === orgId) client.send(msg);
  }
}

wss.on('connection', (ws, req) => {
  ws.orgId = req.orgId;
  const orgState = getOrgState(ws.orgId);
  ws.send(JSON.stringify({
    type: 'init',
    vehicles: serializeVehicles(orgState),
    geofences: orgState.geofences,
    alerts: orgState.alerts.slice(0, 50),
  }));
});

async function boot() {
  // Bootstrap the legacy single-admin deployment as the 'default' org, from
  // the same env vars the original single-tenant version used — required
  // so the existing production login keeps working unchanged.
  const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
  const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;
  const ADMIN_TOTP_SECRET = process.env.ADMIN_TOTP_SECRET || null;
  if (ADMIN_USERNAME && ADMIN_PASSWORD_HASH) {
    await orgs.upsertDefaultOrg(db, { username: ADMIN_USERNAME, passwordHash: ADMIN_PASSWORD_HASH, totpSecret: ADMIN_TOTP_SECRET });
  } else {
    console.warn('ADMIN_USERNAME/ADMIN_PASSWORD_HASH not set — the default org will not have a login until they are set.');
  }

  await ensureDefaultOrgSeed();

  const allOrgs = await orgs.listOrgs(db);
  let totalVehicles = 0;
  for (const org of allOrgs) {
    const vehicleConfigs = await loadVehiclesForOrg(org.id);
    const orgState = getOrgState(org.id);
    orgState.geofences = await loadGeofencesForOrg(org.id);
    await initVehiclesForOrg(org.id, vehicleConfigs);
    totalVehicles += vehicleConfigs.length;

    const { rows: recentAlerts } = await db.query(
      'SELECT * FROM alerts WHERE org_id = $1 ORDER BY ts DESC LIMIT $2',
      [org.id, ALERTS_MAX]
    );
    orgState.alerts = recentAlerts.map((r) => ({
      id: r.id,
      t: r.ts,
      vehicleId: r.vehicle_id,
      vehicleLabel: r.vehicle_label,
      type: r.type,
      severity: r.severity,
      message: r.message,
      geofenceId: r.geofence_id,
      lat: r.lat != null ? Number(r.lat) : null,
      lng: r.lng != null ? Number(r.lng) : null,
    }));
  }

  setInterval(tick, TICK_MS);

  server.listen(PORT, () => {
    console.log(`Fleet Shield running at http://localhost:${PORT}`);
    console.log(`Restored ${allOrgs.length} organization(s), ${totalVehicles} vehicle(s) total from Postgres.`);
    console.log(`Billing: ${billing.billingEnabled ? 'enabled (Stripe)' : 'DISABLED (STRIPE_* env vars not set)'}`);
  });
}

boot().catch((err) => {
  console.error('Failed to boot server:', err);
  process.exit(1);
});
