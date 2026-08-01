/**
 * Vehicle Telematics Solution — MVP backend
 *
 * Simulates a fleet of vehicles moving along real-world-style routes,
 * generates driver-behaviour events, evaluates geofences, and streams live
 * updates to connected dashboards over WebSocket while exposing a REST API
 * for alerts, geofences, and reports.
 *
 * Persistence: fleet configuration, geofences, alert history, and every
 * position tick are stored in Postgres/TimescaleDB. On boot, each vehicle's
 * cumulative counters (odometer, fuel/CO2 used, moving/idling time, trip
 * count) are restored from its latest stored row, so a restart doesn't lose
 * fleet history — only the DB is the source of truth for anything that
 * needs to survive a redeploy. The in-memory `state` object below is a hot
 * cache for the 2s simulation tick and live WebSocket push, kept in sync
 * with the database on every write.
 *
 * No real hardware/device feed is required — this demonstrates the
 * software layer (ingestion, processing, alerting, reporting, live map)
 * that a real telematics deployment would sit on top of.
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const TICK_MS = 2000; // simulation heartbeat

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function lerp(a, b, t) {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Fleet & route definitions (Melbourne metro, VIC — matches tender region)
// ---------------------------------------------------------------------------

const ROUTES = {
  cbdLoop: [
    { lat: -37.8136, lng: 144.9631 }, // Melbourne CBD (depot)
    { lat: -37.8226, lng: 144.9648 }, // Southbank
    { lat: -37.8199, lng: 144.9834 }, // East Melbourne
    { lat: -37.8076, lng: 144.9605 }, // Carlton
    { lat: -37.8136, lng: 144.9631 },
  ],
  bayside: [
    { lat: -37.8467, lng: 144.9789 }, // St Kilda (depot)
    { lat: -37.8679, lng: 144.9878 }, // Elwood
    { lat: -37.9014, lng: 145.0011 }, // Brighton
    { lat: -37.8679, lng: 144.9878 },
    { lat: -37.8467, lng: 144.9789 },
  ],
  outerEast: [
    { lat: -37.8199, lng: 145.2119 }, // Ringwood (depot)
    { lat: -37.8300, lng: 145.2700 }, // Bayswater
    { lat: -37.7986, lng: 145.3011 }, // Croydon
    { lat: -37.8300, lng: 145.2700 },
    { lat: -37.8199, lng: 145.2119 },
  ],
  westGate: [
    { lat: -37.8317, lng: 144.8907 }, // Footscray (depot)
    { lat: -37.8397, lng: 144.8306 }, // Sunshine
    { lat: -37.8664, lng: 144.7663 }, // Deer Park
    { lat: -37.8397, lng: 144.8306 },
    { lat: -37.8317, lng: 144.8907 },
  ],
  northCorridor: [
    { lat: -37.7080, lng: 144.9648 }, // Preston (depot)
    { lat: -37.6790, lng: 144.9958 }, // Reservoir
    { lat: -37.6510, lng: 145.0201 }, // South Morang
    { lat: -37.6790, lng: 144.9958 },
    { lat: -37.7080, lng: 144.9648 },
  ],
};

// Fuel/energy consumption + emission-factor profile per vehicle. Consumption is
// L/100km for diesel & petrol, kWh/100km for EVs; idle rate is per hour in the
// same unit. Emission factors are kg CO2-e per litre (diesel/petrol, tailpipe)
// or per kWh (EV, using an average grid-intensity factor for well-to-wheel
// reporting) — standard approach for fleet emissions/ESG reporting.
const EMISSION_FACTORS_KG = { diesel: 2.68, petrol: 2.31, ev: 0.85 };

// Seed data — only used to populate the database the first time it's empty.
// After that, the `vehicles` table in Postgres is the source of truth; edit
// rows there (or re-seed) rather than this array to change the fleet.
const SEED_VEHICLES = [
  { id: 'VIC-01', label: 'Council Truck 01', driver: 'J. Ahmed', route: 'cbdLoop', speedLimit: 50, baseSpeed: 38, fuelType: 'diesel', consumptionPer100: 14, idleRatePerHour: 1.3, startingOdometerKm: 62000, regoOffsetDays: 45 },
  { id: 'VIC-02', label: 'Council Truck 02', driver: 'S. Nguyen', route: 'cbdLoop', speedLimit: 50, baseSpeed: 42, fuelType: 'diesel', consumptionPer100: 14, idleRatePerHour: 1.3, startingOdometerKm: 58000, regoOffsetDays: 210 },
  { id: 'VIC-03', label: 'Waste Collection 03', driver: 'M. Ricci', route: 'bayside', speedLimit: 60, baseSpeed: 50, fuelType: 'diesel', consumptionPer100: 22, idleRatePerHour: 2.0, startingOdometerKm: 91000, regoOffsetDays: -5 },
  { id: 'VIC-04', label: 'Waste Collection 04', driver: 'K. Walsh', route: 'bayside', speedLimit: 60, baseSpeed: 44, fuelType: 'diesel', consumptionPer100: 21, idleRatePerHour: 1.9, startingOdometerKm: 88000, regoOffsetDays: 15 },
  { id: 'VIC-05', label: 'Parks Ute 05', driver: 'D. Singh', route: 'outerEast', speedLimit: 70, baseSpeed: 58, fuelType: 'petrol', consumptionPer100: 10, idleRatePerHour: 0.9, startingOdometerKm: 34000, regoOffsetDays: 300 },
  { id: 'VIC-06', label: 'Parks Ute 06', driver: 'R. Thompson', route: 'outerEast', speedLimit: 70, baseSpeed: 62, fuelType: 'petrol', consumptionPer100: 9.5, idleRatePerHour: 0.85, startingOdometerKm: 29000, regoOffsetDays: 260 },
  { id: 'VIC-07', label: 'Depot Van 07', driver: 'L. Chen', route: 'westGate', speedLimit: 70, baseSpeed: 55, fuelType: 'ev', consumptionPer100: 21, idleRatePerHour: 1.0, startingOdometerKm: 18000, regoOffsetDays: 320 },
  { id: 'VIC-08', label: 'Depot Van 08', driver: 'A. Kovac', route: 'westGate', speedLimit: 70, baseSpeed: 48, fuelType: 'ev', consumptionPer100: 22, idleRatePerHour: 1.1, startingOdometerKm: 15000, regoOffsetDays: 340 },
  { id: 'VIC-09', label: 'Maintenance 09', driver: "P. O'Brien", route: 'northCorridor', speedLimit: 60, baseSpeed: 40, fuelType: 'petrol', consumptionPer100: 11, idleRatePerHour: 1.0, startingOdometerKm: 71000, regoOffsetDays: 8 },
  { id: 'VIC-10', label: 'Maintenance 10', driver: 'N. Patel', route: 'northCorridor', speedLimit: 60, baseSpeed: 53, fuelType: 'petrol', consumptionPer100: 10.5, idleRatePerHour: 0.95, startingOdometerKm: 66000, regoOffsetDays: 180 },
];

const SEED_GEOFENCES = [
  { id: 'gf_cbd_depot', name: 'CBD Depot Yard', lat: -37.8136, lng: 144.9631, radiusM: 600, type: 'depot' },
  { id: 'gf_restricted_dock', name: 'Restricted Zone – Docklands', lat: -37.8155, lng: 144.9470, radiusM: 900, type: 'restricted' },
  { id: 'gf_bayside_depot', name: 'Bayside Depot', lat: -37.8467, lng: 144.9789, radiusM: 500, type: 'depot' },
];

const SERVICE_INTERVAL_KM = 10000;

// How often (in ticks) to persist a position row per vehicle. At TICK_MS=2000
// and DB_WRITE_EVERY_N_TICKS=1, that's 10 vehicles x 1 row / 2s ≈ 5 rows/sec
// (~430k rows/day) — comfortably within what TimescaleDB is built for, but
// easy to throttle down for a small/free-tier database.
const DB_WRITE_EVERY_N_TICKS = parseInt(process.env.DB_WRITE_EVERY_N_TICKS || '1', 10);

// ---------------------------------------------------------------------------
// Simulation state (hot cache — mirrors Postgres, restored from it on boot)
// ---------------------------------------------------------------------------

const state = {
  vehicles: new Map(), // id -> live state
  alerts: [], // most recent first, capped — fast cache for WS init/broadcast
  geofences: [],
};

const ALERTS_MAX = 500;
let tickCounter = 0;

const ALERT_SEVERITY_WEIGHT = { high: 8, medium: 4, low: 1, info: 0 };

function safetyScore(vehicleId) {
  const weight = state.alerts
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
// Database bootstrap: seed if empty, then load + restore cumulative state
// ---------------------------------------------------------------------------

async function ensureSeedData() {
  const { rows: vRows } = await db.query('SELECT count(*)::int AS n FROM vehicles');
  if (vRows[0].n === 0) {
    console.log('vehicles table empty — seeding from SEED_VEHICLES...');
    for (const v of SEED_VEHICLES) {
      const regoExpiryDate = new Date(Date.now() + v.regoOffsetDays * 86400000)
        .toISOString()
        .slice(0, 10);
      await db.query(
        `INSERT INTO vehicles
          (id, label, driver, route, speed_limit, base_speed, fuel_type, consumption_per_100, idle_rate_per_hour, starting_odometer_km, rego_expiry_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (id) DO NOTHING`,
        [v.id, v.label, v.driver, v.route, v.speedLimit, v.baseSpeed, v.fuelType, v.consumptionPer100, v.idleRatePerHour, v.startingOdometerKm, regoExpiryDate]
      );
    }
  }

  const { rows: gRows } = await db.query('SELECT count(*)::int AS n FROM geofences');
  if (gRows[0].n === 0) {
    console.log('geofences table empty — seeding from SEED_GEOFENCES...');
    for (const g of SEED_GEOFENCES) {
      await db.query(
        `INSERT INTO geofences (id, name, lat, lng, radius_m, type) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO NOTHING`,
        [g.id, g.name, g.lat, g.lng, g.radiusM, g.type]
      );
    }
  }
}

async function loadVehiclesFromDb() {
  const { rows } = await db.query('SELECT * FROM vehicles ORDER BY id');
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

async function loadGeofencesFromDb() {
  const { rows } = await db.query('SELECT * FROM geofences ORDER BY created_at');
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

async function initVehicles(vehicleConfigs) {
  for (const v of vehicleConfigs) {
    const route = ROUTES[v.route];
    const last = await restoreLatestPosition(v.id);
    state.vehicles.set(v.id, {
      ...v,
      segIndex: 0,
      segT: Math.random(), // stagger starting positions along the loop
      lat: route[0].lat,
      lng: route[0].lng,
      speedKmh: 0,
      headingDeg: 0,
      status: 'moving', // moving | idling
      idleTicks: 0,
      lastGeofence: new Set(),
      updatedAt: nowIso(),
      // Cumulative counters — restored from the last persisted row if one
      // exists, so a restart continues the fleet's history instead of
      // resetting it to zero.
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

function pushAlert(alert) {
  const full = { id: uid('al'), t: nowIso(), ...alert };
  state.alerts.unshift(full);
  if (state.alerts.length > ALERTS_MAX) state.alerts.length = ALERTS_MAX;
  broadcast({ type: 'alert', alert: full });

  // Durable write-through — fire and forget so the simulation loop never
  // blocks on the database. Failures are logged, not thrown.
  db.query(
    `INSERT INTO alerts (id, ts, vehicle_id, vehicle_label, type, severity, message, geofence_id, lat, lng)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [full.id, full.t, full.vehicleId || null, full.vehicleLabel || null, full.type, full.severity, full.message || null, full.geofenceId || null, full.lat ?? null, full.lng ?? null]
  ).catch((err) => console.error('Failed to persist alert', err.message));

  return full;
}

function checkGeofences(v) {
  for (const gf of state.geofences) {
    const distM = haversineKm(v, gf) * 1000;
    const inside = distM <= gf.radiusM;
    const wasInside = v.lastGeofence.has(gf.id);

    if (inside && !wasInside) {
      v.lastGeofence.add(gf.id);
      pushAlert({
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
      pushAlert({
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

function persistPositions(rows) {
  if (rows.length === 0) return;
  const cols = ['ts', 'vehicle_id', 'lat', 'lng', 'speed_kmh', 'heading_deg', 'status', 'odometer_km', 'fuel_used_total', 'co2_kg_total', 'moving_sec_total', 'idling_sec_total', 'trip_count'];
  const values = [];
  const placeholders = rows.map((r, i) => {
    const base = i * cols.length;
    values.push(r.ts, r.vehicleId, r.lat, r.lng, r.speedKmh, r.headingDeg, r.status, r.odometerKm, r.fuelUsedTotal, r.co2KgTotal, r.movingSec, r.idlingSec, r.tripCount);
    return `(${cols.map((_, j) => `$${base + j + 1}`).join(',')})`;
  });
  const sql = `INSERT INTO positions (${cols.join(',')}) VALUES ${placeholders.join(',')}`;
  db.query(sql, values).catch((err) => console.error('Failed to persist positions batch', err.message));
}

function tick() {
  tickCounter += 1;
  const shouldPersist = tickCounter % DB_WRITE_EVERY_N_TICKS === 0;
  const positionRows = [];

  for (const v of state.vehicles.values()) {
    const route = ROUTES[v.route];
    const from = route[v.segIndex];
    const to = route[(v.segIndex + 1) % route.length];

    // Depot pause / idling behaviour at the start of each loop
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
          pushAlert({
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

    // Speed variance incl. occasional harsh events
    const variance = (Math.random() - 0.5) * 12;
    let speed = Math.max(5, v.baseSpeed + variance);

    const roll = Math.random();
    if (roll < 0.025) {
      // harsh braking
      const prevSpeed = speed;
      speed = Math.max(5, speed * 0.35);
      pushAlert({
        type: 'harsh_braking',
        severity: 'medium',
        vehicleId: v.id,
        vehicleLabel: v.label,
        message: `${v.label} harsh braking event (${Math.round(prevSpeed)} → ${Math.round(speed)} km/h)`,
        lat: v.lat,
        lng: v.lng,
      });
    } else if (roll > 0.975) {
      // harsh acceleration / speeding
      speed = speed * 1.4;
      pushAlert({
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
      pushAlert({
        type: 'speeding',
        severity: 'high',
        vehicleId: v.id,
        vehicleLabel: v.label,
        message: `${v.label} speeding: ${Math.round(speed)} km/h in a ${v.speedLimit} km/h zone`,
        lat: v.lat,
        lng: v.lng,
      });
    }

    // Advance position along the route segment based on speed
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
    checkGeofences(v);
  }

  if (shouldPersist) persistPositions(positionRows);
  broadcast({ type: 'positions', vehicles: serializeVehicles() });
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

function serializeVehicles() {
  return Array.from(state.vehicles.values()).map((v) => {
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
      safetyScore: safetyScore(v.id),
      updatedAt: v.updatedAt,
    };
  });
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/vehicles', (req, res) => {
  res.json(serializeVehicles());
});

// Historical position query — reads straight from Postgres/TimescaleDB, so
// this reflects real history and survives restarts (unlike the old in-memory
// breadcrumb trail). Defaults to the last 2 hours, capped at 1000 points.
app.get('/api/vehicles/:id/trips', async (req, res) => {
  if (!state.vehicles.has(req.params.id)) {
    return res.status(404).json({ error: 'vehicle not found' });
  }
  const hours = Math.min(parseFloat(req.query.hours) || 2, 168);
  const limit = Math.min(parseInt(req.query.limit, 10) || 1000, 1000);
  try {
    const { rows } = await db.query(
      `SELECT ts, lat, lng, speed_kmh FROM positions
       WHERE vehicle_id = $1 AND ts > now() - ($2 || ' hours')::interval
       ORDER BY ts ASC LIMIT $3`,
      [req.params.id, hours, limit]
    );
    res.json(rows.map((r) => ({ t: r.ts, lat: Number(r.lat), lng: Number(r.lng), speed: Number(r.speed_kmh) })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'query failed' });
  }
});

// Historical alert log from Postgres (not capped at the in-memory 500 like
// before) — this is what actually survives a redeploy.
app.get('/api/alerts', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 1000);
  try {
    const params = [limit];
    let where = '';
    if (req.query.vehicleId) {
      params.push(req.query.vehicleId);
      where = 'WHERE vehicle_id = $2';
    }
    const { rows } = await db.query(
      `SELECT * FROM alerts ${where} ORDER BY ts DESC LIMIT $1`,
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

// Daily rollup per vehicle — demonstrates TimescaleDB-backed historical
// reporting (distance, CO2, avg speed per day) that a live in-memory-only
// server could never offer.
app.get('/api/reports/daily/:vehicleId', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT date_trunc('day', ts) AS day,
              round((max(odometer_km) - min(odometer_km))::numeric, 1) AS km_travelled,
              round((max(co2_kg_total) - min(co2_kg_total))::numeric, 1) AS co2_kg,
              round(avg(speed_kmh)::numeric, 1) AS avg_speed_kmh
       FROM positions
       WHERE vehicle_id = $1
       GROUP BY day
       ORDER BY day DESC
       LIMIT 30`,
      [req.params.vehicleId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'query failed' });
  }
});

app.get('/api/geofences', (req, res) => {
  res.json(state.geofences);
});

app.post('/api/geofences', async (req, res) => {
  const { name, lat, lng, radiusM, type } = req.body || {};
  if (!name || typeof lat !== 'number' || typeof lng !== 'number' || !radiusM) {
    return res.status(400).json({ error: 'name, lat, lng, radiusM are required' });
  }
  const gf = { id: uid('gf'), name, lat, lng, radiusM, type: type || 'custom' };
  try {
    await db.query(
      `INSERT INTO geofences (id, name, lat, lng, radius_m, type) VALUES ($1,$2,$3,$4,$5,$6)`,
      [gf.id, gf.name, gf.lat, gf.lng, gf.radiusM, gf.type]
    );
    state.geofences.push(gf);
    res.status(201).json(gf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'insert failed' });
  }
});

app.delete('/api/geofences/:id', async (req, res) => {
  try {
    const result = await db.query('DELETE FROM geofences WHERE id = $1', [req.params.id]);
    state.geofences = state.geofences.filter((g) => g.id !== req.params.id);
    for (const v of state.vehicles.values()) v.lastGeofence.delete(req.params.id);
    res.json({ removed: result.rowCount > 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'delete failed' });
  }
});

app.get('/api/reports/summary', (req, res) => {
  const vehicles = Array.from(state.vehicles.values());
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
  for (const a of state.alerts) {
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
      safetyScore: safetyScore(v.id),
      alerts: state.alerts.filter((a) => a.vehicleId === v.id).length,
    };
  });

  res.json({
    generatedAt: nowIso(),
    fleetSize: vehicles.length,
    totalDistanceKm: Math.round(totalKm * 10) / 10,
    avgSpeedKmh: Math.round(avgSpeed * 10) / 10,
    vehiclesIdling: idling,
    totalAlerts: state.alerts.length,
    totalCO2Kg: Math.round(totalCO2Kg * 10) / 10,
    avgUtilisationPct: Math.round(avgUtilisation * 10) / 10,
    alertCounts,
    perVehicle,
  });
});

app.get('/api/reports/emissions', (req, res) => {
  const vehicles = Array.from(state.vehicles.values());
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
  const vehicles = Array.from(state.vehicles.values());
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
        safetyScore: safetyScore(v.id),
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

app.get('/api/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ ok: true, db: 'connected' });
  } catch (err) {
    res.status(503).json({ ok: false, db: 'unreachable', error: err.message });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(msg);
  }
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'init', vehicles: serializeVehicles(), geofences: state.geofences, alerts: state.alerts.slice(0, 50) }));
});

async function boot() {
  await ensureSeedData();
  const vehicleConfigs = await loadVehiclesFromDb();
  state.geofences = await loadGeofencesFromDb();
  await initVehicles(vehicleConfigs);

  // Warm the in-memory alert cache from the DB so safety scores and the
  // WebSocket init payload aren't empty right after a restart.
  const { rows: recentAlerts } = await db.query(
    'SELECT * FROM alerts ORDER BY ts DESC LIMIT $1',
    [ALERTS_MAX]
  );
  state.alerts = recentAlerts.map((r) => ({
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

  setInterval(tick, TICK_MS);

  server.listen(PORT, () => {
    console.log(`Telematics MVP running at http://localhost:${PORT}`);
    console.log(`Restored ${state.vehicles.size} vehicles, ${state.geofences.length} geofences, ${state.alerts.length} recent alerts from Postgres.`);
  });
}

boot().catch((err) => {
  console.error('Failed to boot server:', err);
  process.exit(1);
});
