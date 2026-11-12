/**
 * Telematics data assurance — checks whether a vehicle's reported data can
 * be trusted, separately from how the vehicle is being driven.
 *
 * Every check here works only from what a tracking device would report
 * (position fixes, ignition, odometer, power state). Nothing reads the
 * simulation's internal "truth", so the same functions can run on a real
 * device feed unchanged.
 *
 *   gps_jump              consecutive fixes imply an impossible speed —
 *                         a GNSS spoofing indicator
 *   gps_signal_loss       no position fix for too long with the ignition
 *                         on — a GNSS jamming indicator
 *   device_tamper         device reports main power disconnected with the
 *                         ignition on (unplugged / power cut)
 *   odometer_mismatch     reported odometer distance disagrees with the
 *                         distance travelled between fixes
 *   after_hours_movement  trip started outside the organisation's
 *                         operating hours
 *
 * Assurance events are kept out of driver safety scoring (a jammed GPS is
 * not the driver's fault) — see ASSURANCE_TYPES uses in server.js and
 * lib/reports.js.
 */

const ASSURANCE_TYPES = Object.freeze([
  'gps_jump',
  'gps_signal_loss',
  'device_tamper',
  'odometer_mismatch',
  'after_hours_movement',
]);

const ASSURANCE_LABELS = Object.freeze({
  gps_jump: 'Possible GPS spoofing',
  gps_signal_loss: 'GPS signal lost (possible jamming)',
  device_tamper: 'Device power disconnected',
  odometer_mismatch: 'Odometer mismatch',
  after_hours_movement: 'After-hours movement',
});

const DEFAULTS = Object.freeze({
  // Fastest a road vehicle plausibly travels between two fixes. Above this
  // the fix itself is suspect. Generous so ordinary GPS noise never trips it.
  maxPlausibleKmh: 180,
  // Ignore jumps over very short intervals where clock jitter dominates.
  minJumpIntervalSec: 1,
  // Ignition on and no fix for this long = signal loss.
  signalLossSec: 60,
  // Odometer vs GPS distance: flag when the difference exceeds both of these.
  odometerToleranceKm: 1.5,
  odometerTolerancePct: 15,
  // Local operating hours [start, end), 24h clock.
  operatingHours: { start: 6, end: 19 },
  timeZone: 'Australia/Melbourne',
});

// Penalty per event in the trailing window, for the data trust score.
const TRUST_PENALTY = Object.freeze({
  gps_jump: 15,
  gps_signal_loss: 8,
  device_tamper: 25,
  odometer_mismatch: 12,
  after_hours_movement: 0, // an operational concern, not a data-quality one
});

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function toMs(t) {
  return t instanceof Date ? t.getTime() : typeof t === 'number' ? t : Date.parse(t);
}

/**
 * Speed implied by two fixes ({lat, lng, t}). Returns null when the
 * interval is too short to judge.
 */
function impliedSpeedKmh(prev, cur, opts = DEFAULTS) {
  const dtSec = (toMs(cur.t) - toMs(prev.t)) / 1000;
  if (!(dtSec >= opts.minJumpIntervalSec)) return null;
  return haversineKm(prev, cur) / (dtSec / 3600);
}

/** A position jump no road vehicle could make → { distanceKm, impliedKmh } or null. */
function detectJump(prev, cur, opts = DEFAULTS) {
  if (!prev || !cur) return null;
  const kmh = impliedSpeedKmh(prev, cur, opts);
  if (kmh === null || kmh <= opts.maxPlausibleKmh) return null;
  return { distanceKm: haversineKm(prev, cur), impliedKmh: kmh };
}

/** Ignition on and no fix for longer than the threshold. */
function isSignalLost({ lastFixAt, ignitionOn, now }, opts = DEFAULTS) {
  if (!ignitionOn || lastFixAt == null) return false;
  return (toMs(now) - toMs(lastFixAt)) / 1000 > opts.signalLossSec;
}

/**
 * Compare odometer distance with GPS distance over the same interval.
 * Returns { odoKm, gpsKm, diffKm } when they disagree beyond tolerance.
 */
function detectOdometerMismatch(odoKm, gpsKm, opts = DEFAULTS) {
  const diffKm = odoKm - gpsKm;
  const abs = Math.abs(diffKm);
  const pct = gpsKm > 0 ? (abs / gpsKm) * 100 : abs > 0 ? Infinity : 0;
  if (abs > opts.odometerToleranceKm && pct > opts.odometerTolerancePct) {
    return { odoKm, gpsKm, diffKm };
  }
  return null;
}

function localHour(t, timeZone = DEFAULTS.timeZone) {
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone, hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(toMs(t)));
  return Number(parts.find((p) => p.type === 'hour').value);
}

function isOutsideOperatingHours(t, opts = DEFAULTS) {
  const h = localHour(t, opts.timeZone);
  const { start, end } = opts.operatingHours;
  return start <= end ? h < start || h >= end : h < start && h >= end;
}

/**
 * Data trust score, 0–100, from assurance events in a trailing window.
 * 100 = nothing suspicious about this vehicle's data recently.
 */
function trustScore(events, { now = Date.now(), windowHours = 24 } = {}) {
  const since = toMs(now) - windowHours * 3600 * 1000;
  let penalty = 0;
  for (const e of events) {
    if (toMs(e.t) >= since) penalty += TRUST_PENALTY[e.type] || 0;
  }
  return Math.max(0, 100 - penalty);
}

module.exports = {
  ASSURANCE_TYPES,
  ASSURANCE_LABELS,
  DEFAULTS,
  TRUST_PENALTY,
  haversineKm,
  impliedSpeedKmh,
  detectJump,
  isSignalLost,
  detectOdometerMismatch,
  localHour,
  isOutsideOperatingHours,
  trustScore,
};
