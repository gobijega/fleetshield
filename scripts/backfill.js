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
 * Usage:
 *   npm run backfill                 # adds ~14 simulated days (default)
 *   npm run backfill -- --days=21    # adds ~21 simulated days
 */
require('dotenv').config();
const { pool, query } = require('../db');
const { loadVehiclesFromDb } = require('../lib/fleet-data');
const { backfillVehicleHistory, backfillAlerts } = require('../lib/backfill');

function parseDays() {
  const arg = process.argv.find((a) => a.startsWith('--days='));
  const days = arg ? parseInt(arg.split('=')[1], 10) : 14;
  return Number.isFinite(days) && days > 0 ? days : 14;
}

async function main() {
  const days = parseDays();
  const db = { query };

  const vehicles = await loadVehiclesFromDb(db);
  if (vehicles.length === 0) {
    console.log('No vehicles found in the database — run `npm run migrate` and boot the server at least once first.');
    return;
  }

  console.log(`Backfilling ~${days} simulated operating days across ${vehicles.length} vehicles...`);
  const summary = await backfillVehicleHistory(db, vehicles, { days });
  const alertsInserted = await backfillAlerts(db, vehicles, { days });

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
