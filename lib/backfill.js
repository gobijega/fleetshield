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
 * operates on ~70% of days, i.e. roughly a 5-day working week) and inserts
 * ONE new position row per vehicle carrying the resulting cumulative
 * totals, timestamped now. Live simulation ticks then continue growing
 * from there exactly as if the vehicle had really been running that long.
 */
async function backfillVehicleHistory(db, vehicleConfigs, { days = 14 } = {}, orgId = 'default') {
  const summary = [];

  for (const v of vehicleConfigs) {
    const base = await latestCumulative(db, v.id);

    let addOdometerKm = 0;
    let addFuel = 0;
    let addCO2 = 0;
    let addMovingSec = 0;
    let addIdlingSec = 0;
    let addTrips = 0;

    for (let d = 0; d < days; d++) {
      // Roughly a 5-day working week — not every simulated day has the
      // vehicle out on the road.
      if (Math.random() > 0.7) continue;

      const movingHours = randRange(4.5, 7);
      const idlingHours = randRange(0.5, 1.8);
      // Real-world driving rarely sustains baseSpeed — stop/start, traffic,
      // depot manoeuvring all pull the effective average down.
      const dailyKm = movingHours * v.baseSpeed * randRange(0.65, 0.9);
      const dailyFuel = dailyKm * (v.consumptionPer100 / 100) + idlingHours * v.idleRatePerHour;

      addOdometerKm += dailyKm;
      addFuel += dailyFuel;
      addCO2 += dailyFuel * EMISSION_FACTORS_KG[v.fuelType];
      addMovingSec += movingHours * 3600;
      addIdlingSec += idlingHours * 3600;
      addTrips += randInt(2, 5);
    }

    const totals = {
      odometerKm: base.odometerKm + addOdometerKm,
      fuelUsedTotal: base.fuelUsedTotal + addFuel,
      co2KgTotal: base.co2KgTotal + addCO2,
      movingSec: base.movingSec + addMovingSec,
      idlingSec: base.idlingSec + addIdlingSec,
      tripCount: base.tripCount + addTrips,
    };

    const depot = (ROUTES[v.route] && ROUTES[v.route][0]) || { lat: -37.8136, lng: 144.9631 };

    await db.query(
      `INSERT INTO positions
        (ts, vehicle_id, lat, lng, speed_kmh, heading_deg, status, odometer_km, fuel_used_total, co2_kg_total, moving_sec_total, idling_sec_total, trip_count, org_id)
       VALUES (now(), $1, $2, $3, 0, 0, 'idling', $4, $5, $6, $7, $8, $9, $10)`,
      [v.id, depot.lat, depot.lng, totals.odometerKm, totals.fuelUsedTotal, totals.co2KgTotal, totals.movingSec, totals.idlingSec, totals.tripCount, orgId]
    );

    summary.push({ id: v.id, addedKm: Math.round(addOdometerKm), addedCO2Kg: Math.round(addCO2), addedTrips: addTrips });
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

  for (const v of vehicleConfigs) {
    const count = randInt(12, 30);
    const depot = (ROUTES[v.route] && ROUTES[v.route][0]) || { lat: -37.8136, lng: 144.9631 };

    for (let i = 0; i < count; i++) {
      const template = ALERT_TEMPLATES[randInt(0, ALERT_TEMPLATES.length - 1)];
      const daysAgo = randRange(0.05, days);
      const ts = new Date(Date.now() - daysAgo * 86400000).toISOString();
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
