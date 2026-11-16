'use strict';
/**
 * Alert triage workflow: validation and state transitions, kept free of I/O
 * so it can be unit-tested. server.js applies the result to the database,
 * the in-memory org state and the audit log.
 *
 *   open --acknowledge--> acknowledged --resolve--> resolved
 *   open ---------------------resolve-----------> resolved
 *   acknowledged | resolved --reopen--> open
 */

const STATUSES = Object.freeze(['open', 'acknowledged', 'resolved']);
const ACTIONS = Object.freeze(['acknowledge', 'resolve', 'reopen']);
const RESOLUTIONS = Object.freeze({
  confirmed: 'Confirmed: action taken',
  explained: 'Explained: expected behaviour',
  false_alarm: 'False alarm',
  duplicate: 'Duplicate',
});
const NOTE_MAX = 1000;
const BULK_MAX = 200;

const CATEGORY_OF = Object.freeze({
  speeding: 'safety',
  harsh_braking: 'safety',
  harsh_acceleration: 'safety',
  excessive_idling: 'safety',
  geofence_entry: 'geofence',
  geofence_exit: 'geofence',
  geofence_restricted_entry: 'geofence',
  gps_jump: 'assurance',
  gps_signal_loss: 'assurance',
  device_tamper: 'assurance',
  odometer_mismatch: 'assurance',
  after_hours_movement: 'assurance',
});

function categoryOf(type) {
  return CATEGORY_OF[type] || 'other';
}

/**
 * Validate a requested action. Returns { error } or { action, resolution, note }.
 */
function validateAction(body) {
  const b = body || {};
  if (!ACTIONS.includes(b.action)) {
    return { error: `action must be one of: ${ACTIONS.join(', ')}` };
  }
  let resolution = null;
  if (b.action === 'resolve') {
    if (!Object.prototype.hasOwnProperty.call(RESOLUTIONS, b.resolution)) {
      return { error: `resolution must be one of: ${Object.keys(RESOLUTIONS).join(', ')}` };
    }
    resolution = b.resolution;
  }
  let note = null;
  if (b.note != null) {
    if (typeof b.note !== 'string') return { error: 'note must be a string' };
    note = b.note.trim().slice(0, NOTE_MAX) || null;
  }
  return { action: b.action, resolution, note };
}

/**
 * Apply an action to an alert record (camelCase, as served to the client).
 * Returns { error } for an invalid transition, otherwise { changes, alert }
 * where `changes` holds the column values to persist.
 */
function applyAction(
  alert,
  { action, resolution, note },
  { username, now = new Date().toISOString() }
) {
  const status = alert.status || 'open';
  let changes;
  if (action === 'acknowledge') {
    if (status !== 'open') return { error: `cannot acknowledge an alert that is ${status}` };
    changes = { status: 'acknowledged', acknowledgedAt: now, acknowledgedBy: username };
  } else if (action === 'resolve') {
    if (status === 'resolved') return { error: 'alert is already resolved' };
    changes = { status: 'resolved', resolvedAt: now, resolvedBy: username, resolution };
    if (status === 'open') {
      changes.acknowledgedAt = alert.acknowledgedAt || now;
      changes.acknowledgedBy = alert.acknowledgedBy || username;
    }
  } else {
    if (status === 'open') return { error: 'alert is already open' };
    changes = {
      status: 'open',
      resolvedAt: null,
      resolvedBy: null,
      resolution: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
    };
  }
  if (note !== null) changes.note = note;
  return { changes, alert: { ...alert, ...changes } };
}

function validateBulk(body) {
  const b = body || {};
  if (!Array.isArray(b.ids) || b.ids.length === 0)
    return { error: 'ids must be a non-empty array' };
  if (b.ids.length > BULK_MAX) return { error: `at most ${BULK_MAX} alerts per request` };
  if (!b.ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 64)) {
    return { error: 'ids must be alert id strings' };
  }
  const v = validateAction(b);
  if (v.error) return v;
  return { ...v, ids: [...new Set(b.ids)] };
}

module.exports = {
  STATUSES,
  ACTIONS,
  RESOLUTIONS,
  CATEGORY_OF,
  BULK_MAX,
  categoryOf,
  validateAction,
  validateBulk,
  applyAction,
};
