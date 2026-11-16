'use strict';
/**
 * Maintenance: preventive-maintenance (PM) due calculations, default
 * schedules, pre-start inspection items, and input validation for work
 * orders, schedules and inspections. No I/O here, so it can be unit-tested;
 * server.js does the persistence.
 *
 * PM is measured against the telematics odometer (starting odometer plus
 * distance reported by the tracker), so distance-based services fall due
 * without anyone typing in a meter reading.
 */

const WO_TYPES = Object.freeze(['preventive', 'corrective', 'inspection', 'other']);
const WO_PRIORITIES = Object.freeze(['low', 'medium', 'high', 'critical']);
const WO_STATUSES = Object.freeze(['open', 'in_progress', 'on_hold', 'done', 'cancelled']);
const WO_OPEN_STATUSES = Object.freeze(['open', 'in_progress', 'on_hold']);
const COST_KINDS = Object.freeze(['parts', 'labour', 'other']);

// A PM item is "due soon" inside these windows, and a work order is raised
// for it automatically at that point (one open work order per schedule).
const DUE_SOON_KM = 1000;
const DUE_SOON_DAYS = 14;

const INSPECTION_ITEMS = Object.freeze([
  'Tyres and wheel nuts',
  'Lights and indicators',
  'Brakes',
  'Mirrors and windscreen',
  'Wipers and washers',
  'Horn',
  'Seatbelts',
  'Fluid leaks under vehicle',
  'Body damage',
  'Load and restraints',
  'First aid kit',
  'Fire extinguisher',
]);

/**
 * Default PM program for a vehicle. Distances and intervals are typical
 * manufacturer-style values for light commercial vehicles; each is editable
 * per vehicle on the Maintenance tab.
 */
function defaultSchedules(fuelType) {
  const common = [
    {
      name: 'General service',
      intervalKm: 10000,
      intervalDays: 365,
      checklist: [
        'Replace engine oil and filter',
        'Check and top up fluids',
        'Inspect belts and hoses',
        'Scan for fault codes',
        'Road test',
      ],
    },
    {
      name: 'Tyre rotation and inspection',
      intervalKm: 10000,
      intervalDays: null,
      checklist: [
        'Rotate tyres',
        'Check tread depth and sidewalls',
        'Set pressures to placard',
        'Torque wheel nuts',
      ],
    },
    {
      name: 'Brake inspection',
      intervalKm: 20000,
      intervalDays: 365,
      checklist: [
        'Measure pad and rotor thickness',
        'Check brake fluid',
        'Inspect lines and hoses',
        'Test park brake',
      ],
    },
    {
      name: 'Safety equipment check',
      intervalKm: null,
      intervalDays: 180,
      checklist: [
        'Fire extinguisher tagged and in date',
        'First aid kit stocked',
        'Hazard triangle present',
        'Seatbelts and restraints',
      ],
    },
  ];
  if (fuelType === 'ev') {
    common[0] = {
      name: 'General service (EV)',
      intervalKm: 15000,
      intervalDays: 365,
      checklist: [
        'Inspect high-voltage cabling and connectors',
        'Check coolant for battery and drive unit',
        'Replace cabin filter',
        'Scan for fault codes',
        'Road test',
      ],
    };
  }
  return common;
}

function daysBetween(fromMs, toMs) {
  return Math.round((toMs - fromMs) / 86400000);
}

/**
 * When is a schedule next due, and how urgent is it?
 *   schedule: { intervalKm, intervalDays, lastDoneKm, lastDoneAt }
 *   odometerKm: current telematics odometer
 * Returns { dueKm, kmRemaining, dueAt, daysRemaining, status } where status
 * is 'overdue' | 'due_soon' | 'ok', taking whichever trigger comes first.
 */
function computeDue(schedule, odometerKm, now = Date.now()) {
  const out = { dueKm: null, kmRemaining: null, dueAt: null, daysRemaining: null, status: 'ok' };
  const statuses = [];
  if (schedule.intervalKm) {
    const base = schedule.lastDoneKm != null ? schedule.lastDoneKm : 0;
    out.dueKm = Math.round(base + schedule.intervalKm);
    out.kmRemaining = Math.round(out.dueKm - odometerKm);
    statuses.push(
      out.kmRemaining < 0 ? 'overdue' : out.kmRemaining <= DUE_SOON_KM ? 'due_soon' : 'ok'
    );
  }
  if (schedule.intervalDays) {
    const baseMs = schedule.lastDoneAt ? new Date(schedule.lastDoneAt).getTime() : now;
    const dueMs = baseMs + schedule.intervalDays * 86400000;
    out.dueAt = new Date(dueMs).toISOString();
    out.daysRemaining = daysBetween(now, dueMs);
    statuses.push(
      out.daysRemaining < 0 ? 'overdue' : out.daysRemaining <= DUE_SOON_DAYS ? 'due_soon' : 'ok'
    );
  }
  out.status = statuses.includes('overdue')
    ? 'overdue'
    : statuses.includes('due_soon')
      ? 'due_soon'
      : 'ok';
  return out;
}

// Calendar dates are fleet-local (the reports use the same zone).
const FLEET_TZ = 'Australia/Melbourne';
function localDate(ms = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: FLEET_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

/** Due date (YYYY-MM-DD, fleet-local) to put on an auto-raised PM work order. */
function pmWorkOrderDueDate(due, now = Date.now()) {
  if (due.dueAt) return localDate(Date.parse(due.dueAt));
  // Distance-only schedule: allow a week, or today if already overdue.
  const days = due.kmRemaining != null && due.kmRemaining < 0 ? 0 : 7;
  return localDate(now + days * 86400000);
}

function pmPriority(due) {
  return due.status === 'overdue' ? 'high' : 'medium';
}

// ---------------------------------------------------------------- validation
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : null);
const isDate = (v) =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

function cleanChecklist(list, { allowDone = true } = {}) {
  if (list == null) return [];
  if (!Array.isArray(list)) return { error: 'checklist must be an array' };
  if (list.length > 50) return { error: 'checklist has more than 50 items' };
  const out = [];
  for (const item of list) {
    const text = str(typeof item === 'string' ? item : item && item.text, 200);
    if (!text) continue;
    out.push({ text, done: allowDone ? Boolean(item && item.done) : false });
  }
  return out;
}

function cleanCosts(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) return { error: 'costs must be an array' };
  if (list.length > 50) return { error: 'more than 50 cost lines' };
  const out = [];
  for (const c of list) {
    if (!c || !COST_KINDS.includes(c.kind))
      return { error: `cost kind must be one of: ${COST_KINDS.join(', ')}` };
    const amount = Number(c.amount);
    if (!Number.isFinite(amount) || amount < 0 || amount > 1e7)
      return { error: 'cost amount must be between 0 and 10,000,000' };
    out.push({
      kind: c.kind,
      description: str(c.description, 200) || '',
      amount: Math.round(amount * 100) / 100,
    });
  }
  return out;
}

function costTotal(costs) {
  return Math.round((costs || []).reduce((s, c) => s + (Number(c.amount) || 0), 0) * 100) / 100;
}

/** Validate a new work order. Returns { error } or a clean object. */
function validateWorkOrder(body) {
  const b = body || {};
  const title = str(b.title, 160);
  if (!title) return { error: 'title is required' };
  const type = b.type || 'corrective';
  if (!WO_TYPES.includes(type)) return { error: `type must be one of: ${WO_TYPES.join(', ')}` };
  const priority = b.priority || 'medium';
  if (!WO_PRIORITIES.includes(priority))
    return { error: `priority must be one of: ${WO_PRIORITIES.join(', ')}` };
  if (b.dueDate != null && b.dueDate !== '' && !isDate(b.dueDate))
    return { error: 'dueDate must be YYYY-MM-DD' };
  const checklist = cleanChecklist(b.checklist, { allowDone: false });
  if (checklist.error) return checklist;
  return {
    title,
    description: str(b.description, 4000),
    type,
    priority,
    vehicleId: b.vehicleId ? String(b.vehicleId).slice(0, 64) : null,
    assignee: str(b.assignee, 120) || null,
    dueDate: b.dueDate || null,
    outOfService: Boolean(b.outOfService),
    checklist,
  };
}

/**
 * Validate a work-order update. Only the fields present are changed.
 * Returns { error } or { changes } with camelCase keys.
 */
function validateWorkOrderPatch(body, current) {
  const b = body || {};
  const changes = {};
  if (b.status !== undefined) {
    if (!WO_STATUSES.includes(b.status))
      return { error: `status must be one of: ${WO_STATUSES.join(', ')}` };
    changes.status = b.status;
  }
  if (b.priority !== undefined) {
    if (!WO_PRIORITIES.includes(b.priority))
      return { error: `priority must be one of: ${WO_PRIORITIES.join(', ')}` };
    changes.priority = b.priority;
  }
  if (b.title !== undefined) {
    const t = str(b.title, 160);
    if (!t) return { error: 'title cannot be empty' };
    changes.title = t;
  }
  if (b.description !== undefined) changes.description = str(b.description, 4000);
  if (b.assignee !== undefined) changes.assignee = str(b.assignee, 120) || null;
  if (b.dueDate !== undefined) {
    if (b.dueDate !== null && b.dueDate !== '' && !isDate(b.dueDate))
      return { error: 'dueDate must be YYYY-MM-DD' };
    changes.dueDate = b.dueDate || null;
  }
  if (b.outOfService !== undefined) changes.outOfService = Boolean(b.outOfService);
  if (b.checklist !== undefined) {
    const c = cleanChecklist(b.checklist);
    if (c.error) return c;
    changes.checklist = c;
  }
  if (b.costs !== undefined) {
    const c = cleanCosts(b.costs);
    if (c.error) return c;
    changes.costs = c;
  }
  if (current && changes.status && changes.status !== current.status) {
    const closed = ['done', 'cancelled'];
    if (closed.includes(current.status) && closed.includes(changes.status)) {
      return { error: `work order is already ${current.status}` };
    }
  }
  return { changes };
}

function validateSchedule(body, { partial = false } = {}) {
  const b = body || {};
  const out = {};
  if (!partial || b.name !== undefined) {
    const name = str(b.name, 120);
    if (!name) return { error: 'name is required' };
    out.name = name;
  }
  const num = (v, lo, hi, label) => {
    if (v === null || v === '' || v === undefined) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi)
      return { error: `${label} must be a whole number between ${lo} and ${hi}` };
    return n;
  };
  if (!partial || b.intervalKm !== undefined) {
    const v = num(b.intervalKm, 100, 1000000, 'intervalKm');
    if (v && v.error) return v;
    out.intervalKm = v;
  }
  if (!partial || b.intervalDays !== undefined) {
    const v = num(b.intervalDays, 1, 3650, 'intervalDays');
    if (v && v.error) return v;
    out.intervalDays = v;
  }
  if (!partial && !out.intervalKm && !out.intervalDays)
    return { error: 'set a distance interval, a time interval, or both' };
  if (!partial || b.checklist !== undefined) {
    const c = cleanChecklist(b.checklist, { allowDone: false });
    if (c.error) return c;
    out.checklist = c.map((i) => i.text);
  }
  if (b.active !== undefined) out.active = Boolean(b.active);
  if (!partial) out.vehicleId = b.vehicleId ? String(b.vehicleId).slice(0, 64) : null;
  if (!partial && !out.vehicleId) return { error: 'vehicleId is required' };
  return out;
}

/** Validate a pre-start inspection. Every standard item needs a result. */
function validateInspection(body) {
  const b = body || {};
  if (!b.vehicleId) return { error: 'vehicleId is required' };
  const inspector = str(b.inspector, 120);
  if (!inspector) return { error: 'inspector name is required' };
  if (!Array.isArray(b.results)) return { error: 'results must be an array' };
  const byItem = new Map(b.results.map((r) => [r && r.item, r]));
  const results = [];
  for (const item of INSPECTION_ITEMS) {
    const r = byItem.get(item);
    if (!r || !['pass', 'fail', 'na'].includes(r.result))
      return { error: `missing or invalid result for "${item}"` };
    results.push({ item, result: r.result, note: str(r.note, 300) || '' });
  }
  const failed = results.filter((r) => r.result === 'fail');
  return {
    vehicleId: String(b.vehicleId).slice(0, 64),
    inspector,
    notes: str(b.notes, 2000) || null,
    results,
    passed: failed.length === 0,
    failed,
  };
}

module.exports = {
  WO_TYPES,
  WO_PRIORITIES,
  WO_STATUSES,
  WO_OPEN_STATUSES,
  COST_KINDS,
  DUE_SOON_KM,
  DUE_SOON_DAYS,
  INSPECTION_ITEMS,
  defaultSchedules,
  computeDue,
  pmWorkOrderDueDate,
  localDate,
  pmPriority,
  costTotal,
  validateWorkOrder,
  validateWorkOrderPatch,
  validateSchedule,
  validateInspection,
};
