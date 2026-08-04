/**
 * Cumulative-total computation for imported telemetry — PROTOTYPE.
 *
 * The `positions` table stores running totals (fuel_used_total,
 * co2_kg_total, moving_sec_total, idling_sec_total, trip_count) alongside
 * each raw reading, so the dashboard can restore in-memory state on restart
 * by reading a vehicle's single latest row (see server.js's
 * restoreLatestPosition/initVehiclesForOrg). The live simulation
 * (tickOrg) computes these incrementally, tick by tick.
 *
 * A batch CSV import has to reproduce the same running-total shape from a
 * static, already-ordered list of readings instead of a live loop. This
 * module does that as a pure function: given a vehicle's known fuel
 * characteristics (the same EMISSION_FACTORS_KG / consumptionPer100 /
 * idleRatePerHour values the live simulation uses — see lib/fleet-data.js)
 * and a chronologically-sorted list of valid NormalizedObservations for
 * that vehicle, it derives the same set of cumulative columns, continuing
 * from a supplied starting point (typically the vehicle's current latest
 * position row, so an import never resets history).
 *
 * Known limitation, documented rather than hidden: unlike the live
 * simulation (which advances in fixed, short ticks), a batch of imported
 * readings can have arbitrary gaps between consecutive samples. A very
 * large gap (e.g. a device offline for days) cannot be safely attributed
 * to "moving" or "idling" — the vehicle's real state during the gap is
 * unknown. This module caps the elapsed time counted per gap at
 * MAX_GAP_SECONDS and does not fabricate distance/fuel for time beyond
 * that cap. This is a deliberate conservative choice, not a bug: it avoids
 * silently inventing telemetry for periods with no actual data.
 */

'use strict';

const { EMISSION_FACTORS_KG, haversineKm } = require('../fleet-data');

// Gaps longer than this between two consecutive readings for the same
// vehicle are treated as "unknown state" — no distance/fuel/moving/idling
// time is attributed to the gap itself, only to the instant of each
// reading. 2 hours is generous for a CSV export cadence (e.g. hourly or
// daily extracts) while still refusing to invent multi-day totals from a
// single pair of readings.
const MAX_GAP_SECONDS = 2 * 60 * 60;

function emptyTotals() {
  return {
    tsIso: null,
    lat: null,
    lng: null,
    odometerKm: 0,
    fuelUsedTotal: 0,
    co2KgTotal: 0,
    movingSec: 0,
    idlingSec: 0,
    tripCount: 0,
    lastStatus: null,
  };
}

function deriveStatus(obs) {
  if (obs.ignitionOn === false) return 'off';
  if (obs.speedKmh !== null && obs.speedKmh !== undefined) {
    return obs.speedKmh > 0 ? 'moving' : 'idling';
  }
  // No speed and no explicit ignition-off signal: assume idling rather than
  // moving, since inventing a "moving" segment (and therefore fuel use)
  // from silence is the riskier default.
  return obs.ignitionOn === true ? 'idling' : 'idling';
}

/**
 * @param {object} vehicle - { id, fuelType, consumptionPer100, idleRatePerHour }
 *   as returned by lib/fleet-data.js's loadVehiclesFromDb / server.js's
 *   loadVehiclesForOrg.
 * @param {object[]} observations - valid NormalizedObservation records for
 *   this vehicle only, any order (this function sorts them).
 * @param {object|null} startingTotals - the vehicle's current latest known
 *   totals (e.g. from restoreLatestPosition), or null to start from zero.
 *   Starting from zero is only appropriate for a vehicle with no prior
 *   history; callers importing into a vehicle that already has live
 *   simulation history should always pass its latest known row.
 * @returns {{ rows: object[], warnings: string[] }} rows are shaped for
 *   direct use with server.js's persistPositions() column list.
 */
function computeCumulativeSeries(vehicle, observations, startingTotals) {
  const warnings = [];
  const sorted = [...observations].sort((a, b) => (a.timestampIso < b.timestampIso ? -1 : 1));

  let totals = startingTotals
    ? {
        tsIso: startingTotals.tsIso || null,
        lat: startingTotals.lat ?? null,
        lng: startingTotals.lng ?? null,
        odometerKm: Number(startingTotals.odometerKm) || 0,
        fuelUsedTotal: Number(startingTotals.fuelUsedTotal) || 0,
        co2KgTotal: Number(startingTotals.co2KgTotal) || 0,
        movingSec: Number(startingTotals.movingSec) || 0,
        idlingSec: Number(startingTotals.idlingSec) || 0,
        tripCount: Number(startingTotals.tripCount) || 0,
        lastStatus: startingTotals.lastStatus || null,
      }
    : emptyTotals();

  const emissionFactor = EMISSION_FACTORS_KG[vehicle.fuelType];
  if (emissionFactor === undefined) {
    warnings.push(`Unknown fuel type "${vehicle.fuelType}" for vehicle ${vehicle.id}; fuel/CO2 totals will not be computed.`);
  }

  const rows = [];

  for (const obs of sorted) {
    const status = deriveStatus(obs);
    let elapsedSec = 0;
    if (totals.tsIso) {
      const gapSec = (Date.parse(obs.timestampIso) - Date.parse(totals.tsIso)) / 1000;
      if (gapSec < 0) {
        warnings.push(`Vehicle ${vehicle.id}: reading at ${obs.timestampIso} is earlier than the previous total (${totals.tsIso}); skipped ordering assumption for this row.`);
      } else {
        elapsedSec = Math.min(gapSec, MAX_GAP_SECONDS);
        if (gapSec > MAX_GAP_SECONDS) {
          warnings.push(`Vehicle ${vehicle.id}: gap of ${Math.round(gapSec)}s before ${obs.timestampIso} exceeds ${MAX_GAP_SECONDS}s; only ${MAX_GAP_SECONDS}s counted toward moving/idling time.`);
        }
      }
    }

    // The very first reading for a vehicle (no prior state at all —
    // startingTotals was null and this is the earliest observation in the
    // batch) establishes the odometer/position baseline rather than being
    // treated as a delta from an initialised zero, which would otherwise
    // invent a huge fake "distance travelled" equal to the vehicle's
    // actual odometer reading.
    const isBaselineReading = totals.tsIso === null;
    let distanceKm = 0;
    if (isBaselineReading) {
      if (obs.odometerKm !== null) totals.odometerKm = obs.odometerKm;
    } else {
      if (obs.odometerKm !== null && totals.odometerKm !== null && obs.odometerKm >= totals.odometerKm) {
        distanceKm = obs.odometerKm - totals.odometerKm;
      } else if (totals.lat !== null && totals.lng !== null && obs.lat !== null && obs.lng !== null) {
        distanceKm = haversineKm({ lat: totals.lat, lng: totals.lng }, { lat: obs.lat, lng: obs.lng });
      }
      // A single very large point-to-point jump (bad GPS fix, or a genuine
      // gap in coverage) shouldn't be attributed as real distance travelled
      // in the capped elapsed-time window. Cap implied speed at a generous
      // 200 km/h for the elapsed window; anything faster is treated as a
      // data/gap artefact and distance is not counted for fuel purposes.
      if (elapsedSec > 0) {
        const impliedSpeedKmh = distanceKm / (elapsedSec / 3600);
        if (impliedSpeedKmh > 200) {
          warnings.push(`Vehicle ${vehicle.id}: implied speed ${Math.round(impliedSpeedKmh)} km/h before ${obs.timestampIso} looks like a data gap or bad fix; distance not counted toward fuel for this row.`);
          distanceKm = 0;
        }
      } else {
        distanceKm = 0;
      }
      totals.odometerKm += distanceKm;
    }

    let fuelDelta = 0;
    if (status === 'moving' && emissionFactor !== undefined) {
      fuelDelta = distanceKm * (vehicle.consumptionPer100 / 100);
      totals.movingSec += elapsedSec;
    } else if (status === 'idling' && emissionFactor !== undefined) {
      fuelDelta = vehicle.idleRatePerHour * (elapsedSec / 3600);
      totals.idlingSec += elapsedSec;
    }
    const co2Delta = emissionFactor !== undefined ? fuelDelta * emissionFactor : 0;

    if (totals.lastStatus !== 'moving' && status === 'moving') {
      totals.tripCount += 1;
    }

    totals.fuelUsedTotal += fuelDelta;
    totals.co2KgTotal += co2Delta;
    totals.tsIso = obs.timestampIso;
    totals.lat = obs.lat;
    totals.lng = obs.lng;
    totals.lastStatus = status;

    rows.push({
      ts: obs.timestampIso,
      vehicleId: vehicle.id,
      lat: obs.lat,
      lng: obs.lng,
      speedKmh: obs.speedKmh,
      headingDeg: null, // not derivable from sparse imported points; left null rather than guessed
      status,
      odometerKm: totals.odometerKm,
      fuelUsedTotal: totals.fuelUsedTotal,
      co2KgTotal: totals.co2KgTotal,
      movingSec: totals.movingSec,
      idlingSec: totals.idlingSec,
      tripCount: totals.tripCount,
    });
  }

  return { rows, warnings };
}

module.exports = { computeCumulativeSeries, MAX_GAP_SECONDS };
