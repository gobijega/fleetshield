/**
 * Vehicle Telematics Solution — MVP backend
 *
 * Simulates a fleet of vehicles moving along real-world-style routes,
 * generates driver-behaviour events, evaluates geofences, stores trip
 * history, and streams live updates to connected dashboards over
 * WebSocket while exposing a REST API for alerts, geofences, and reports.
 *
 * No real hardware/device feed is required — this demonstrates the
 * software layer (ingestion, processing, alerting, reporting, live map)
 * that a real telematics deployment would sit on top of.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

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

const VEHICLES = [
  { id: 'VIC-01', label: 'Council Truck 01', driver: 'J. Ahmed', route: 'cbdLoop', speedLimit: 50, baseSpeed: 38 },
  { id: 'VIC-02', label: 'Council Truck 02', driver: 'S. Nguyen', route: 'cbdLoop', speedLimit: 50, baseSpeed: 42 },
  { id: 'VIC-03', label: 'Waste Collection 03', driver: 'M. Ricci', route: 'bayside', speedLimit: 60, baseSpeed: 50 },
  { id: 'VIC-04', label: 'Waste Collection 04', driver: 'K. Walsh', route: 'bayside', speedLimit: 60, baseSpeed: 44 },
  { id: 'VIC-05', label: 'Parks Ute 05', driver: 'D. Singh', route: 'outerEast', speedLimit: 70, baseSpeed: 58 },
  { id: 'VIC-06', label: 'Parks Ute 06', driver: 'R. Thompson', route: 'outerEast', speedLimit: 70, baseSpeed: 62 },
  { id: 'VIC-07', label: 'Depot Van 07', driver: 'L. Chen', route: 'westGate', speedLimit: 70, baseSpeed: 55 },
  { id: 'VIC-08', label: 'Depot Van 08', driver: 'A. Kovac', route: 'westGate', speedLimit: 70, baseSpeed: 48 },
  { id: 'VIC-09', label: 'Maintenance 09', driver: 'P. O\'Brien', route: 'northCorridor', speedLimit: 60, baseSpeed: 40 },
  { id: 'VIC-10', label: 'Maintenance 10', driver: 'N. Patel', route: 'northCorridor', speedLimit: 60, baseSpeed: 53 },
];

const GEOFENCES = [
  { id: 'gf_cbd_depot', name: 'CBD Depot Yard', lat: -37.8136, lng: 144.9631, radiusM: 600, type: 'depot' },
  { id: 'gf_restricted_dock', name: 'Restricted Zone – Docklands', lat: -37.8155, lng: 144.9470, radiusM: 900, type: 'restricted' },
  { id: 'gf_bayside_depot', name: 'Bayside Depot', lat: -37.8467, lng: 144.9789, radiusM: 500, type: 'depot' },
];

// ---------------------------------------------------------------------------
// Simulation state
// ---------------------------------------------------------------------------

const state = {
  vehicles: new Map(), // id -> live state
  alerts: [], // most recent first, capped
  trips: new Map(), // vehicleId -> array of {t, lat, lng, speed}
  geofences: GEOFENCES,
};

const ALERTS_MAX = 500;
const TRIP_POINTS_MAX = 300;

function initVehicles() {
  for (const v of VEHICLES) {
    const route = ROUTES[v.route];
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
      odometerKm: 0,
      lastGeofence: new Set(),
      updatedAt: nowIso(),
    });
    state.trips.set(v.id, []);
  }
}

function pushAlert(alert) {
  const full = { id: uid('al'), t: nowIso(), ...alert };
  state.alerts.unshift(full);
  if (state.alerts.length > ALERTS_MAX) state.alerts.length = ALERTS_MAX;
  broadcast({ type: 'alert', alert: full });
  return full;
}

function pushTripPoint(vehicleId, point) {
  const arr = state.trips.get(vehicleId);
  arr.push(point);
  if (arr.length > TRIP_POINTS_MAX) arr.shift();
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

function tick() {
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
        pushTripPoint(v.id, { t: v.updatedAt, lat: v.lat, lng: v.lng, speed: 0 });
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

    pushTripPoint(v.id, { t: v.updatedAt, lat: v.lat, lng: v.lng, speed: v.speedKmh });
    checkGeofences(v);
  }

  broadcast({ type: 'positions', vehicles: serializeVehicles() });
}

function serializeVehicles() {
  return Array.from(state.vehicles.values()).map((v) => ({
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
    updatedAt: v.updatedAt,
  }));
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

app.get('/api/vehicles/:id/trips', (req, res) => {
  const trips = state.trips.get(req.params.id);
  if (!trips) return res.status(404).json({ error: 'vehicle not found' });
  res.json(trips);
});

app.get('/api/alerts', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, ALERTS_MAX);
  res.json(state.alerts.slice(0, limit));
});

app.get('/api/geofences', (req, res) => {
  res.json(state.geofences);
});

app.post('/api/geofences', (req, res) => {
  const { name, lat, lng, radiusM, type } = req.body || {};
  if (!name || typeof lat !== 'number' || typeof lng !== 'number' || !radiusM) {
    return res.status(400).json({ error: 'name, lat, lng, radiusM are required' });
  }
  const gf = { id: uid('gf'), name, lat, lng, radiusM, type: type || 'custom' };
  state.geofences.push(gf);
  res.status(201).json(gf);
});

app.delete('/api/geofences/:id', (req, res) => {
  const before = state.geofences.length;
  state.geofences = state.geofences.filter((g) => g.id !== req.params.id);
  for (const v of state.vehicles.values()) v.lastGeofence.delete(req.params.id);
  res.json({ removed: before !== state.geofences.length });
});

app.get('/api/reports/summary', (req, res) => {
  const vehicles = Array.from(state.vehicles.values());
  const totalKm = vehicles.reduce((s, v) => s + v.odometerKm, 0);
  const avgSpeed =
    vehicles.reduce((s, v) => s + v.speedKmh, 0) / (vehicles.length || 1);
  const idling = vehicles.filter((v) => v.status === 'idling').length;

  const alertCounts = {};
  for (const a of state.alerts) {
    alertCounts[a.type] = (alertCounts[a.type] || 0) + 1;
  }

  const perVehicle = vehicles.map((v) => ({
    id: v.id,
    label: v.label,
    driver: v.driver,
    odometerKm: Math.round(v.odometerKm * 10) / 10,
    status: v.status,
    speedKmh: v.speedKmh,
    alerts: state.alerts.filter((a) => a.vehicleId === v.id).length,
  }));

  res.json({
    generatedAt: nowIso(),
    fleetSize: vehicles.length,
    totalDistanceKm: Math.round(totalKm * 10) / 10,
    avgSpeedKmh: Math.round(avgSpeed * 10) / 10,
    vehiclesIdling: idling,
    totalAlerts: state.alerts.length,
    alertCounts,
    perVehicle,
  });
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

initVehicles();
setInterval(tick, TICK_MS);

server.listen(PORT, () => {
  console.log(`Telematics MVP running at http://localhost:${PORT}`);
});
