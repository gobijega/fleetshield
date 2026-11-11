/**
 * Backfills realistic simulated operating history for the fleet, so the
 * Reports tab has meaningful numbers immediately instead of starting at
 * zero and slowly building up in real time.
 *
 * `/api/reports/summary` (what the Reports tab actually calls) reads from
 * the live in-memory `state` cache — which itself is restored on boot from
 * each vehicle's most recent row in the `positions` table, plus the alerts
 * table for alert history. So "backfilling reports" really just means:
 *   1. give each vehicle one new position row whose cumulative counters
 *      (odometer, fuel, CO2, moving/idling time, trip count) reflect ~N
 *      days of realistic prior operation, and
 *   2. give the fleet a batch of alerts spread across that same period.
 *
 * This is additive — it reads whatever the vehicle's current latest
 * cumulative counters are (zero for a brand-new vehicle, or real numbers
 * for one that's already been running) and adds a synthetic increment on
 * top, so it's safe to run once against a fresh install (called
 * automatically from server.js) or once against an already-live
 * deployment to "top up" its history (via `npm run backfill`).
 */

const { ROUTES, EMISSION_FACTORS_KG } = require('./fleet-data');
const { addDays, todayIn, reportTimeZone } = require('./reports');

// UTC milliseconds of local midnight on `day` (YYYY-MM-DD) in `tz`.
function localMidnight(day, tz) {
  const guess = Date.parse(`${day}T00:00:00Z`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(guess))
      .map((p) => [p.type, p.value])
  );
  const asLocal = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00Z`);
  return guess - (asLocal - guess);
}

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

function randInt(min, max) {
  return Math.floor(randRange(min, max + 1));
}

async function latestCumulative(db, vehicleId) {
  const { rows } = await db.query(
    `SELECT odometer_km, fuel_used_total, co2_kg_total, moving_sec_total, idling_sec_total, trip_count
     FROM positions WHERE vehicle_id = $1 ORDER BY ts DESC LIMIT 1`,
    [vehicleId]
  );
  if (!rows[0]) {
    return { odometerKm: 0, fuelUsedTotal: 0, co2KgTotal: 0, movingSec: 0, idlingSec: 0, tripCount: 0 };
  }
  const r = rows[0];
  return {
    odometerKm: Number(r.odometer_km),
    fuelUsedTotal: Number(r.fuel_used_total),
    co2KgTotal: Number(r.co2_kg_total),
    movingSec: Number(r.moving_sec_total),
    idlingSec: Number(r.idling_sec_total),
    tripCount: r.trip_count,
  };
}

/**
 * Simulates `days` of prior operation for each vehicle (assuming it
 * operates on ~70% of days, i.e. roughly a 5-day working week).
 *
 * For a vehicle with no telemetry yet (a fresh install), this writes one
 * position row at the end of each simulated working day, carrying the
 * running cumulative totals. That gives the Reports tab a real day-by-day
 * history — trends, period comparisons, active days — from the first load.
 *
 * For a vehicle that already has telemetry ("top up" via `npm run
 * backfill`), back-dated rows would sit underneath newer, smaller
 * counters and break the cumulative series, so it keeps the original
 * behaviour: ONE row timestamped now carrying the added history.
 * Either way, live simulation ticks continue growing from the final
 * totals exactly as if the vehicle had really been running that long.
 */
async function backfillVehicleHistory(db, vehicleConfigs, { days = 14 } = {}, orgId = 'default') {
  const summary = [];

  for (const v of vehicleConfigs) {
    const base = await latestCumulative(db, v.id);
    const freshVehicle = base.odometerKm === 0 && base.tripCount === 0 && base.movingSec === 0;
    const depot = (ROUTES[v.route] && ROUTES[v.route][0]) || { lat: -37.8136, lng: 144.9631 };

    const totals = { ...base };
    const dailyRows = [];

    for (let d = days; d >= 1; d--) {
      // Roughly a 5-day working week — not every simulated day has the
      // vehicle out on the road.
      if (Math.random() > 0.7) continue;

      const movingHours = randRange(4.5, 7);
      const idlingHours = randRange(0.5, 1.8);
      // Real-world driving rarely sustains baseSpeed — stop/start, traffic,
      // depot manoeuvring all pull the effective average down.
      const dailyKm = movingHours * v.baseSpeed * randRange(0.65, 0.9);
      const dailyFuel = dailyKm * (v.consumptionPer100 / 100) + idlingHours * v.idleRatePerHour;

      totals.odometerKm += dailyKm;
      totals.fuelUsedTotal += dailyFuel;
      totals.co2KgTotal += dailyFuel * EMISSION_FACTORS_KG[v.fuelType];
      totals.movingSec += movingHours * 3600;
      totals.idlingSec += idlingHours * 3600;
      totals.tripCount += randInt(2, 5);

      // Timestamped d days ago (give or take an hour), so each simulated
      // day's activity lands on the day it happened.
      dailyRows.push({ ts: new Date(Date.now() - d * 86400000 + randRange(-1, 1) * 3600000), ...totals });
    }

    const rows = freshVehicle ? dailyRows : [];
    // Always finish with a row at now() carrying the final totals, which is
    // what the live simulation restores from on boot.
    rows.push({ ts: new Date(), ...totals });

    for (const r of rows) {
      await db.query(
        `INSERT INTO positions
          (ts, vehicle_id, lat, lng, speed_kmh, heading_deg, status, odometer_km, fuel_used_total, co2_kg_total, moving_sec_total, idling_sec_total, trip_count, org_id)
         VALUES ($1, $2, $3, $4, 0, 0, 'idling', $5, $6, $7, $8, $9, $10, $11)`,
        [r.ts.toISOString(), v.id, depot.lat, depot.lng, r.odometerKm, r.fuelUsedTotal, r.co2KgTotal, r.movingSec, r.idlingSec, r.tripCount, orgId]
      );
    }

    summary.push({
      id: v.id,
      addedKm: Math.round(totals.odometerKm - base.odometerKm),
      addedCO2Kg: Math.round(totals.co2KgTotal - base.co2KgTotal),
      addedTrips: totals.tripCount - base.tripCount,
    });
  }

  return summary;
}

const ALERT_TEMPLATES = [
  { type: 'harsh_braking', severity: 'medium', message: (v) => `${v.label} harsh braking event` },
  { type: 'harsh_acceleration', severity: 'medium', message: (v) => `${v.label} harsh acceleration event` },
  { type: 'speeding', severity: 'high', message: (v) => `${v.label} speeding in a ${v.speedLimit} km/h zone` },
  { type: 'excessive_idling', severity: 'low', message: (v) => `${v.label} idled for over 60s at depot` },
  { type: 'geofence_entry', severity: 'info', message: (v) => `${v.label} entered depot zone` },
  { type: 'geofence_exit', severity: 'info', message: (v) => `${v.label} exited depot zone` },
];

/**
 * Inserts a batch of realistic alerts spread across the last `days` days
 * per vehicle, so alert history / safety scoring / alert-type breakdowns
 * on the Reports tab aren't empty either.
 */
async function backfillAlerts(db, vehicleConfigs, { days = 14 } = {}, orgId = 'default') {
  let inserted = 0;
  const tz = reportTimeZone();

  for (const v of vehicleConfigs) {
    // ~12-30 events per vehicle per fortnight.
    const count = Math.round(randInt(12, 30) * (days / 14));
    const depot = (ROUTES[v.route] && ROUTES[v.route][0]) || { lat: -37.8136, lng: 144.9631 };

    for (let i = 0; i < count; i++) {
      const template = ALERT_TEMPLATES[randInt(0, ALERT_TEMPLATES.length - 1)];
      // Events happen while vehicles are working: pick a day, then a time
      // in a roughly 06:00-18:00 shift in the reporting time zone, skewed
      // towards the morning run.
      const day = addDays(todayIn(tz), -randInt(0, days - 1));
      const hour = 6 + Math.min(randRange(0, 12), randRange(0, 12) * 1.4);
      let ts = new Date(localMidnight(day, tz) + hour * 3600000);
      if (ts > new Date()) ts = new Date(Date.now() - randRange(0.05, 1) * 86400000);
      ts = ts.toISOString();
      const id = `al_bf_${Math.random().toString(36).slice(2, 9)}`;

      await db.query(
        `INSERT INTO alerts (id, ts, vehicle_id, vehicle_label, type, severity, message, geofence_id, lat, lng, org_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, ts, v.id, v.label, template.type, template.severity, template.message(v), null, depot.lat, depot.lng, orgId]
      );
      inserted += 1;
    }
  }

  return inserted;
}

module.exports = { backfillVehicleHistory, backfillAlerts };
