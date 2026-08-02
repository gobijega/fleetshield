/**
 * Tops up the fleet's simulated operating history so the Reports tab shows
 * meaningful numbers. Runs automatically on a fresh install (see
 * ensureSeedData() in server.js), but this script exists so the same
 * backfill can be applied on demand against an already-running deployment
 * (e.g. the live Render/Timescale Cloud instance) — useful if it's been up
 * a short time and Reports still looks sparse.
 *
 * It's additive: each vehicle's current cumulative totals (odometer, fuel,
 * CO2, moving/idling time, trip count) are read from its latest `positions`
 * row and a synthetic increment is added on top, so this is safe to run
 * against a fleet that already has some real history — it won't overwrite
 * or discard it. Running it more than once will keep adding another batch
 * of simulated days each time, so use --days to control how much to add.
 *
 * Multi-tenant note: this tops up the 'default' org only (the original
 * single-admin deployment / its demo fleet) — a signed-up customer's own
 * org gets its own vehicles via the in-app "Add vehicle" form, not this
 * script.
 *
 * Usage:
 *   npm run backfill                 # adds ~14 simulated days (default)
 *   npm run backfill -- --days=21    # adds ~21 simulated days
 */
require('dotenv').config();
const { pool, query } = require('../db');
const { backfillVehicleHistory, backfillAlerts } = require('../lib/backfill');

function parseDays() {
  const arg = process.argv.find((a) => a.startsWith('--days='));
  const days = arg ? parseInt(arg.split('=')[1], 10) : 14;
  return Number.isFinite(days) && days > 0 ? days : 14;
}

async function loadDefaultOrgVehicles(db) {
  const { rows } = await db.query(`SELECT * FROM vehicles WHERE org_id = 'default' ORDER BY id`);
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

async function main() {
  const days = parseDays();
  const db = { query };

  const vehicles = await loadDefaultOrgVehicles(db);
  if (vehicles.length === 0) {
    console.log('No vehicles found for the default org — run `npm run migrate` and boot the server at least once first.');
    return;
  }

  console.log(`Backfilling ~${days} simulated operating days across ${vehicles.length} vehicles...`);
  const summary = await backfillVehicleHistory(db, vehicles, { days }, 'default');
  const alertsInserted = await backfillAlerts(db, vehicles, { days }, 'default');

  for (const v of summary) {
    console.log(`  ${v.id}: +${v.addedKm} km, +${v.addedCO2Kg} kg CO2, +${v.addedTrips} trips`);
  }
  console.log(`Done. Inserted ${alertsInserted} alerts. Restart the server (or wait for the next tick) to see updated Reports.`);
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
