'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const wf = require('../lib/alert-workflow');

const base = { id: 'al_1', t: '2026-11-16T00:00:00Z', type: 'speeding', severity: 'high', status: 'open' };
const who = { username: 'ops', now: '2026-11-16T00:05:00Z' };

test('validateAction rejects unknown actions and missing resolutions', () => {
  assert.match(wf.validateAction({ action: 'delete' }).error, /action must be/);
  assert.match(wf.validateAction({ action: 'resolve' }).error, /resolution must be/);
  assert.match(wf.validateAction({ action: 'resolve', resolution: 'nope' }).error, /resolution must be/);
  assert.match(wf.validateAction({ action: 'acknowledge', note: 5 }).error, /note must be a string/);
});

test('validateAction trims and caps notes', () => {
  const v = wf.validateAction({ action: 'resolve', resolution: 'explained', note: `  ${'x'.repeat(1500)}  ` });
  assert.equal(v.resolution, 'explained');
  assert.equal(v.note.length, 1000);
  assert.equal(wf.validateAction({ action: 'acknowledge', note: '   ' }).note, null);
});

test('acknowledge moves open -> acknowledged and records who and when', () => {
  const r = wf.applyAction(base, wf.validateAction({ action: 'acknowledge' }), who);
  assert.equal(r.alert.status, 'acknowledged');
  assert.equal(r.changes.acknowledgedBy, 'ops');
  assert.equal(r.changes.acknowledgedAt, who.now);
  assert.match(wf.applyAction(r.alert, { action: 'acknowledge', resolution: null, note: null }, who).error, /cannot acknowledge/);
});

test('resolving an open alert also stamps acknowledgement', () => {
  const r = wf.applyAction(base, wf.validateAction({ action: 'resolve', resolution: 'false_alarm', note: 'sensor' }), who);
  assert.equal(r.alert.status, 'resolved');
  assert.equal(r.alert.resolution, 'false_alarm');
  assert.equal(r.alert.acknowledgedAt, who.now);
  assert.equal(r.alert.note, 'sensor');
  assert.match(wf.applyAction(r.alert, { action: 'resolve', resolution: 'duplicate', note: null }, who).error, /already resolved/);
});

test('reopen clears the workflow fields; open alerts cannot be reopened', () => {
  const resolved = wf.applyAction(base, { action: 'resolve', resolution: 'confirmed', note: null }, who).alert;
  const r = wf.applyAction(resolved, { action: 'reopen', resolution: null, note: null }, who);
  assert.equal(r.alert.status, 'open');
  assert.equal(r.alert.resolvedAt, null);
  assert.equal(r.alert.acknowledgedAt, null);
  assert.match(wf.applyAction(base, { action: 'reopen', resolution: null, note: null }, who).error, /already open/);
});

test('validateBulk bounds the batch and dedupes ids', () => {
  assert.match(wf.validateBulk({ ids: [], action: 'acknowledge' }).error, /non-empty/);
  assert.match(wf.validateBulk({ ids: Array.from({ length: 201 }, (_, i) => `a${i}`), action: 'acknowledge' }).error, /at most 200/);
  assert.match(wf.validateBulk({ ids: [1], action: 'acknowledge' }).error, /id strings/);
  assert.deepEqual(wf.validateBulk({ ids: ['a', 'a', 'b'], action: 'acknowledge' }).ids, ['a', 'b']);
});

test('categoryOf groups alert types', () => {
  assert.equal(wf.categoryOf('speeding'), 'safety');
  assert.equal(wf.categoryOf('geofence_restricted_entry'), 'geofence');
  assert.equal(wf.categoryOf('gps_signal_loss'), 'assurance');
  assert.equal(wf.categoryOf('something_new'), 'other');
});
