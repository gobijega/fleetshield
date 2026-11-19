/**
 * Record trust report — "how much of this fleet data can you trust?"
 *
 * The one number a founding pilot is meant to measure: the share of an
 * export's records that fail at least one check. It runs on the same
 * NormalizedObservation[] that csv-adapter.js produces (valid and invalid
 * rows), so a pilot export gets this report straight from the import.
 *
 * The rules match the public health check on jegasec.com/health-check, so
 * the figure a prospect sees in their browser and the figure the pilot
 * reports are the same measure:
 *
 *   Record-level (a row fails if it is itself wrong)
 *     rejected            failed import validation: unreadable timestamp,
 *                         invalid coordinates, duplicate row, etc.
 *     impossible_jump     needs more than DEFAULTS.maxPlausibleKmh to reach
 *                         from the last trusted fix (spoofing signature)
 *     frozen_position     FROZEN_MIN_FIXES+ identical coordinates while
 *                         reporting FROZEN_MIN_SPEED+ km/h (every row in
 *                         the run fails)
 *     odometer_backwards  odometer lower than the previous reading
 *
 *   Vehicle-day level (not a fault in any one row)
 *     moved_without_reporting  a silence longer than max(5 min, 3× the
 *                              tracker's median interval) ending 1 km+ away
 *     odometer_mismatch        daily odometer distance disagrees with GPS
 *                              beyond both tolerances, on a day with no gap
 *
 * Rows rejected only because the vehicle is not registered to the
 * organisation are a set-up problem, not a data-trust one; they are
 * counted as not assessed and kept out of the percentage.
 *
 * Days are UTC calendar days, as in the health check.
 *
 * Nothing here is a verdict. A failed record is a question for the
 * operator review; the pilot reports how many were confirmed or explained.
 */

'use strict';

const { DEFAULTS, haversineKm, detectOdometerMismatch } = require('../assurance');

const FROZEN_MIN_FIXES = 3;
const FROZEN_MIN_SPEED = 20;
const MOVED_GAP_KM = 1;
const MIN_GAP_SEC = 300;
const MAX_EXAMPLES = 50;

const RECORD_CHECKS = Object.freeze([
  'rejected',
  'impossible_jump',
  'frozen_position',
  'odometer_backwards',
]);
const DAY_CHECKS = Object.freeze(['moved_without_reporting', 'odometer_mismatch']);

const isUnknownVehicleOnly = (r) =>
  (r.importErrors || []).length > 0 &&
  r.importErrors.every((e) => /^Unknown vehicle identifier/.test(e));

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Share passed, rounded down so any failure never reads as 100%. */
function pctPassed(failed, total) {
  return total ? Math.floor(((total - failed) / total) * 1000) / 10 : null;
}
/** Share failed, rounded up so a single failure never reads as 0%. */
function pctFailed(failed, total) {
  return total ? Math.ceil((failed / total) * 1000) / 10 : null;
}

/**
 * @param {object[]} records NormalizedObservation[] from csv-adapter parse().
 * @param {object} [opts] overrides for assurance DEFAULTS thresholds.
 */
function buildRecordTrustReport(records, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const failed = new Map(); // row index → Set(check)
  const byCheck = Object.fromEntries([...RECORD_CHECKS, ...DAY_CHECKS].map((k) => [k, 0]));
  const vdays = new Set();
  const flaggedDays = new Map(); // "vid|day" → Set(check)
  const perVehicle = new Map();
  let notAssessed = 0;

  const failRow = (idx, check) => {
    if (!failed.has(idx)) failed.set(idx, new Set());
    failed.get(idx).add(check);
    byCheck[check] += 1;
  };
  const flagDay = (vid, day, check) => {
    const k = `${vid}|${day}`;
    if (!flaggedDays.has(k)) flaggedDays.set(k, new Set());
    flaggedDays.get(k).add(check);
  };

  const byVehicle = new Map();
  records.forEach((r, idx) => {
    if (r.validationStatus !== 'valid') {
      if (isUnknownVehicleOnly(r)) {
        notAssessed += 1;
        return;
      }
      failRow(idx, 'rejected');
      const t = Date.parse(r.timestampIso);
      if (r.vehicleId && Number.isFinite(t)) {
        vdays.add(`${r.vehicleId}|${utcDay(t)}`);
        flagDay(r.vehicleId, utcDay(t), 'rejected');
      }
      return;
    }
    const t = Date.parse(r.timestampIso);
    if (!byVehicle.has(r.vehicleId)) byVehicle.set(r.vehicleId, []);
    byVehicle
      .get(r.vehicleId)
      .push({ idx, t, lat: r.lat, lng: r.lng, speed: r.speedKmh, odo: r.odometerKm });
  });

  for (const [vid, fixes] of byVehicle) {
    fixes.sort((a, b) => a.t - b.t || a.idx - b.idx);
    const intervals = [];
    for (let i = 1; i < fixes.length; i++) {
      const d = (fixes[i].t - fixes[i - 1].t) / 1000;
      if (d > 0) intervals.push(d);
    }
    intervals.sort((a, b) => a - b);
    const medianSec = intervals.length ? intervals[Math.floor(intervals.length / 2)] : 0;
    const gapSec = Math.max(MIN_GAP_SEC, medianSec * 3);

    const days = new Map(); // day → { odoStart, odoEnd, lastOdo, gpsKm, gapped }
    let prev = null; // last trusted fix
    let frozen = [];
    const flushFrozen = () => {
      if (frozen.length >= FROZEN_MIN_FIXES)
        frozen.forEach((f) => failRow(f.idx, 'frozen_position'));
    };

    for (const f of fixes) {
      const day = utcDay(f.t);
      vdays.add(`${vid}|${day}`);
      let dd = days.get(day);
      if (!dd)
        days.set(day, (dd = { odoStart: NaN, odoEnd: NaN, lastOdo: NaN, gpsKm: 0, gapped: false }));

      if (Number.isFinite(f.odo)) {
        if (Number.isFinite(dd.lastOdo) && f.odo < dd.lastOdo - 0.05)
          failRow(f.idx, 'odometer_backwards');
        if (!Number.isFinite(dd.odoStart)) dd.odoStart = f.odo;
        dd.odoEnd = f.odo;
        dd.lastOdo = f.odo;
      }

      if (prev) {
        const dt = (f.t - prev.t) / 1000;
        const km = haversineKm(prev, f);
        if (dt >= o.minJumpIntervalSec && km / (dt / 3600) > o.maxPlausibleKmh) {
          failRow(f.idx, 'impossible_jump');
          continue; // keep comparing against the last trusted fix
        }
        if (km >= MOVED_GAP_KM && dt > gapSec) {
          byCheck.moved_without_reporting += 1;
          flagDay(vid, day, 'moved_without_reporting');
          dd.gapped = true;
        }
        if (utcDay(prev.t) === day) dd.gpsKm += km;
      }

      const moving = Number.isFinite(f.speed) && f.speed >= FROZEN_MIN_SPEED;
      if (frozen.length && moving && frozen[0].lat === f.lat && frozen[0].lng === f.lng) {
        frozen.push(f);
      } else {
        flushFrozen();
        frozen = moving ? [f] : [];
      }
      prev = f;
    }
    flushFrozen();

    for (const [day, dd] of days) {
      if (!Number.isFinite(dd.odoStart)) continue;
      const odoKm = dd.odoEnd - dd.odoStart;
      if (odoKm < 0) continue; // already caught as odometer_backwards
      const m = detectOdometerMismatch(odoKm, dd.gpsKm, o);
      // Across a gap GPS distance is a straight-line underestimate, so an
      // odometer running ahead on a gapped day is expected, not a finding.
      if (!m || (m.diffKm > 0 && dd.gapped)) continue;
      byCheck.odometer_mismatch += 1;
      flagDay(vid, day, 'odometer_mismatch');
    }
  }

  // Failed records flag their vehicle-day; per-vehicle counts cover every
  // assessed row, accepted or rejected.
  records.forEach((r, idx) => {
    if (r.validationStatus !== 'valid' && isUnknownVehicleOnly(r)) return;
    const vid = r.vehicleId || '(blank)';
    if (!perVehicle.has(vid)) perVehicle.set(vid, { vehicleId: vid, records: 0, failed: 0 });
    const v = perVehicle.get(vid);
    v.records += 1;
    if (failed.has(idx)) {
      v.failed += 1;
      if (r.validationStatus === 'valid')
        flagDay(vid, utcDay(Date.parse(r.timestampIso)), [...failed.get(idx)][0]);
    }
  });

  const assessed = records.length - notAssessed;
  const failedCount = failed.size;
  return {
    recordsAssessed: assessed,
    recordsNotAssessed: notAssessed,
    recordsFailed: failedCount,
    recordsPassedPercent: pctPassed(failedCount, assessed),
    recordsFailedPercent: pctFailed(failedCount, assessed),
    vehicleDays: {
      total: vdays.size,
      flagged: [...flaggedDays.keys()].filter((k) => vdays.has(k)).length,
    },
    byCheck,
    byVehicle: [...perVehicle.values()]
      .map((v) => ({ ...v, failedPercent: pctFailed(v.failed, v.records) }))
      .sort((a, b) => b.failed - a.failed || a.vehicleId.localeCompare(b.vehicleId)),
    failedRecords: [...failed.entries()]
      .sort((a, b) => a[0] - b[0])
      .slice(0, MAX_EXAMPLES)
      .map(([idx, checks]) => ({
        row: idx + 2,
        vehicleId: records[idx].vehicleId,
        checks: [...checks],
      })),
  };
}

module.exports = { buildRecordTrustReport, RECORD_CHECKS, DAY_CHECKS };
