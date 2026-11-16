'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const m = require('../lib/maintenance');

const NOW = Date.parse('2026-11-17T00:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();

test('distance-only schedule: ok, due soon, overdue', () => {
  const s = { intervalKm: 10000, intervalDays: null, lastDoneKm: 20000, lastDoneAt: null };
  assert.equal(m.computeDue(s, 25000, NOW).status, 'ok');
  const soon = m.computeDue(s, 29500, NOW);
  assert.equal(soon.status, 'due_soon');
  assert.equal(soon.kmRemaining, 500);
  assert.equal(soon.dueKm, 30000);
  const over = m.computeDue(s, 30200, NOW);
  assert.equal(over.status, 'overdue');
  assert.equal(over.kmRemaining, -200);
});

test('time-only schedule uses the calendar', () => {
  const s = { intervalKm: null, intervalDays: 180, lastDoneKm: null, lastDoneAt: daysAgo(170) };
  const d = m.computeDue(s, 0, NOW);
  assert.equal(d.daysRemaining, 10);
  assert.equal(d.status, 'due_soon');
  assert.equal(m.computeDue({ ...s, lastDoneAt: daysAgo(200) }, 0, NOW).status, 'overdue');
});

test('whichever trigger comes first wins', () => {
  const s = { intervalKm: 10000, intervalDays: 365, lastDoneKm: 0, lastDoneAt: daysAgo(400) };
  assert.equal(m.computeDue(s, 1000, NOW).status, 'overdue'); // time overdue, distance fine
  const s2 = { ...s, lastDoneAt: daysAgo(10) };
  assert.equal(m.computeDue(s2, 9800, NOW).status, 'due_soon'); // distance due soon, time fine
});

test('PM work orders get a sensible due date and priority', () => {
  assert.equal(m.pmWorkOrderDueDate({ dueAt: '2026-12-01T00:00:00.000Z' }, NOW), '2026-12-01');
  assert.equal(m.pmWorkOrderDueDate({ dueAt: null, kmRemaining: -5 }, NOW), '2026-11-17');
  assert.equal(m.pmWorkOrderDueDate({ dueAt: null, kmRemaining: 400 }, NOW), '2026-11-24');
  assert.equal(m.pmPriority({ status: 'overdue' }), 'high');
  assert.equal(m.pmPriority({ status: 'due_soon' }), 'medium');
});

test('default schedules differ for EVs', () => {
  assert.equal(m.defaultSchedules('diesel')[0].name, 'General service');
  assert.equal(m.defaultSchedules('ev')[0].name, 'General service (EV)');
  for (const s of m.defaultSchedules('petrol')) assert.ok(s.intervalKm || s.intervalDays);
});

test('work order validation', () => {
  assert.match(m.validateWorkOrder({}).error, /title/);
  assert.match(m.validateWorkOrder({ title: 'x', type: 'bogus' }).error, /type/);
  assert.match(m.validateWorkOrder({ title: 'x', dueDate: '17/11/2026' }).error, /YYYY-MM-DD/);
  const ok = m.validateWorkOrder({ title: ' Pads ', checklist: ['a', '', { text: 'b', done: true }] });
  assert.equal(ok.title, 'Pads');
  assert.deepEqual(ok.checklist, [
    { text: 'a', done: false },
    { text: 'b', done: false },
  ]);
});

test('work order patch validation and closed-state guard', () => {
  assert.match(m.validateWorkOrderPatch({ status: 'nope' }).error, /status/);
  assert.match(m.validateWorkOrderPatch({ costs: [{ kind: 'beer', amount: 1 }] }).error, /cost kind/);
  assert.match(m.validateWorkOrderPatch({ costs: [{ kind: 'parts', amount: -1 }] }).error, /amount/);
  assert.match(m.validateWorkOrderPatch({ status: 'cancelled' }, { status: 'done' }).error, /already done/);
  const p = m.validateWorkOrderPatch({ costs: [{ kind: 'parts', description: 'pads', amount: '120.456' }], assignee: '' });
  assert.equal(p.changes.costs[0].amount, 120.46);
  assert.equal(p.changes.assignee, null);
  assert.equal(m.costTotal([{ amount: 10.1 }, { amount: 0.2 }]), 10.3);
});

test('schedule validation needs an interval', () => {
  assert.match(m.validateSchedule({ vehicleId: 'v', name: 'x' }).error, /interval/);
  assert.match(m.validateSchedule({ vehicleId: 'v', name: 'x', intervalKm: 50 }).error, /intervalKm/);
  const s = m.validateSchedule({ vehicleId: 'v', name: 'Trans', intervalKm: '40000', checklist: ['Drain', ''] });
  assert.equal(s.intervalKm, 40000);
  assert.deepEqual(s.checklist, ['Drain']);
  assert.deepEqual(m.validateSchedule({ active: false }, { partial: true }), { active: false });
});

test('inspection validation requires every item and reports failures', () => {
  const all = m.INSPECTION_ITEMS.map((item) => ({ item, result: 'pass' }));
  assert.match(m.validateInspection({ vehicleId: 'v', inspector: 'A', results: all.slice(1) }).error, /missing/);
  const passed = m.validateInspection({ vehicleId: 'v', inspector: 'A', results: all });
  assert.equal(passed.passed, true);
  const withFail = all.map((r) => (r.item === 'Brakes' ? { ...r, result: 'fail', note: 'pulls left' } : r));
  const failed = m.validateInspection({ vehicleId: 'v', inspector: 'A', results: withFail });
  assert.equal(failed.passed, false);
  assert.deepEqual(failed.failed.map((f) => f.item), ['Brakes']);
});
