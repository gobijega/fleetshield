/**
 * Shared fleet configuration/constants + small helpers used by both the
 * live simulation server (server.js) and standalone scripts (backfill,
 * migrate). Pulled out on its own so scripts can reuse the exact same
 * route/vehicle/emission-factor data without booting the full server.
 */

// ---------------------------------------------------------------------------
// Routes (Melbourne metro, VIC — matches tender region)
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

// kg CO2-e per litre (diesel/petrol, tailpipe) or per kWh (EV, average grid
// intensity, well-to-wheel) — standard approach for fleet emissions/ESG
// reporting.
const EMISSION_FACTORS_KG = { diesel: 2.68, petrol: 2.31, ev: 0.85 };

const SERVICE_INTERVAL_KM = 10000;

// Seed data — only used to populate the database the first time it's empty.
// After that, the `vehicles` table in Postgres is the source of truth.
const SEED_VEHICLES = [
  { id: 'VIC-01', plate: '1TK 4RD', label: 'Service Truck 01', driver: 'J. Ahmed', route: 'cbdLoop', speedLimit: 50, baseSpeed: 38, fuelType: 'diesel', consumptionPer100: 14, idleRatePerHour: 1.3, startingOdometerKm: 62000, regoOffsetDays: 45 },
  { id: 'VIC-02', plate: '1TK 4RE', label: 'Service Truck 02', driver: 'S. Nguyen', route: 'cbdLoop', speedLimit: 50, baseSpeed: 42, fuelType: 'diesel', consumptionPer100: 14, idleRatePerHour: 1.3, startingOdometerKm: 58000, regoOffsetDays: 210 },
  { id: 'VIC-03', plate: 'XWC 203', label: 'Waste Collection 03', driver: 'M. Ricci', route: 'bayside', speedLimit: 60, baseSpeed: 50, fuelType: 'diesel', consumptionPer100: 22, idleRatePerHour: 2.0, startingOdometerKm: 91000, regoOffsetDays: -5 },
  { id: 'VIC-04', plate: 'XWC 204', label: 'Waste Collection 04', driver: 'K. Walsh', route: 'bayside', speedLimit: 60, baseSpeed: 44, fuelType: 'diesel', consumptionPer100: 21, idleRatePerHour: 1.9, startingOdometerKm: 88000, regoOffsetDays: 15 },
  { id: 'VIC-05', plate: '2PU 5KL', label: 'Parks Ute 05', driver: 'D. Singh', route: 'outerEast', speedLimit: 70, baseSpeed: 58, fuelType: 'petrol', consumptionPer100: 10, idleRatePerHour: 0.9, startingOdometerKm: 34000, regoOffsetDays: 300 },
  { id: 'VIC-06', plate: '2PU 6KM', label: 'Parks Ute 06', driver: 'R. Thompson', route: 'outerEast', speedLimit: 70, baseSpeed: 62, fuelType: 'petrol', consumptionPer100: 9.5, idleRatePerHour: 0.85, startingOdometerKm: 29000, regoOffsetDays: 260 },
  { id: 'VIC-07', plate: 'EV 07DV', label: 'Depot Van 07', driver: 'L. Chen', route: 'westGate', speedLimit: 70, baseSpeed: 55, fuelType: 'ev', consumptionPer100: 21, idleRatePerHour: 1.0, startingOdometerKm: 18000, regoOffsetDays: 320 },
  { id: 'VIC-08', plate: 'EV 08DV', label: 'Depot Van 08', driver: 'A. Kovac', route: 'westGate', speedLimit: 70, baseSpeed: 48, fuelType: 'ev', consumptionPer100: 22, idleRatePerHour: 1.1, startingOdometerKm: 15000, regoOffsetDays: 340 },
  { id: 'VIC-09', plate: '1MN 9OB', label: 'Maintenance 09', driver: "P. O'Brien", route: 'northCorridor', speedLimit: 60, baseSpeed: 40, fuelType: 'petrol', consumptionPer100: 11, idleRatePerHour: 1.0, startingOdometerKm: 71000, regoOffsetDays: 8 },
  { id: 'VIC-10', plate: '1MN 0NP', label: 'Maintenance 10', driver: 'N. Patel', route: 'northCorridor', speedLimit: 60, baseSpeed: 53, fuelType: 'petrol', consumptionPer100: 10.5, idleRatePerHour: 0.95, startingOdometerKm: 66000, regoOffsetDays: 180 },
];

const SEED_GEOFENCES = [
  { id: 'gf_cbd_depot', name: 'CBD Depot Yard', lat: -37.8136, lng: 144.9631, radiusM: 600, type: 'depot' },
  { id: 'gf_restricted_dock', name: 'Restricted Zone – Docklands', lat: -37.8155, lng: 144.9470, radiusM: 900, type: 'restricted' },
  { id: 'gf_bayside_depot', name: 'Bayside Depot', lat: -37.8467, lng: 144.9789, radiusM: 500, type: 'depot' },
];

// ---------------------------------------------------------------------------
// Small helpers
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

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function nowIso() {
  return new Date().toISOString();
}

// Loads vehicle configs currently in the database — used instead of
// SEED_VEHICLES anywhere the *live/customised* fleet matters (e.g.
// backfilling a fleet that's since had vehicles added/edited via the DB).
async function loadVehiclesFromDb(db) {
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

module.exports = {
  ROUTES,
  EMISSION_FACTORS_KG,
  SERVICE_INTERVAL_KM,
  SEED_VEHICLES,
  SEED_GEOFENCES,
  haversineKm,
  uid,
  nowIso,
  loadVehiclesFromDb,
};
