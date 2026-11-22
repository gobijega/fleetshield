/**
 * Evidence pack: a one-page, per-period record of what Fleet Shield's data
 * checks found, for a fleet manager to hand to an insurer, auditor or
 * investigator.
 *
 * DRAFT FORMAT. The layout and wording are a first version, to be confirmed
 * with insurers, brokers and Chain of Responsibility reviewers before it is
 * relied on. Keep the content factual: what was checked, what passed, what
 * was found and why, and how to verify the underlying records.
 *
 * Pure functions only (no database, no clock unless passed in), so the
 * same inputs always give the same record and fingerprint. server.js does
 * the queries and calls buildPack().
 */
const crypto = require('crypto');
const { ASSURANCE_TYPES, ASSURANCE_LABELS } = require('./assurance');

const MAX_DAYS = 7; // matches the chained position export (168 h)

// What each check tests, in plain words, and which setting is its threshold.
const CHECK_INFO = Object.freeze({
  gps_jump: {
    tests:
      'Consecutive position fixes never imply an impossible speed (a sign of GPS spoofing or a faulty receiver).',
    threshold: (s) => `Faster than ${s.maxPlausibleKmh} km/h between fixes`,
  },
  gps_signal_loss: {
    tests:
      'The tracker keeps reporting position while the ignition is on (gaps suggest GPS jamming or obstruction).',
    threshold: (s) => `No fix for ${s.signalLossSec} s or more with ignition on`,
  },
  device_tamper: {
    tests:
      'The tracker stays powered while the vehicle is running (power loss suggests unplugging or a cut supply).',
    threshold: () => 'Main power reported disconnected with ignition on',
  },
  odometer_mismatch: {
    tests: 'Reported odometer distance agrees with the distance between position fixes.',
    threshold: () => 'Odometer and GPS distance disagree beyond tolerance',
  },
  after_hours_movement: {
    tests: 'Trips start within the organisation’s operating hours.',
    threshold: (s) =>
      `Trip started outside ${pad(s.operatingHours.start)}:00–${pad(s.operatingHours.end)}:00 (${s.timeZone})`,
  },
});

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Offset (ms) of `timeZone` from UTC at instant `ms`. */
function tzOffsetMs(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second')
  );
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Local midnight of 'YYYY-MM-DD' in `timeZone`, as a UTC epoch ms. */
function localMidnightUtc(dateStr, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - tzOffsetMs(guess, timeZone);
  // Correct once if the offset differs at the result (DST change that day).
  t = guess - tzOffsetMs(t, timeZone);
  return t;
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Today's date ('YYYY-MM-DD') in `timeZone`. */
function localToday(now, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now));
}

/**
 * Parse and validate the requested period. `from`/`to` are inclusive local
 * dates. Defaults to the last 7 local days including today. Returns
 * { ok, error } or { ok, from, to, startMs, endMs, days }.
 */
function parsePeriod({ from, to }, { now = Date.now(), timeZone }) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const today = localToday(now, timeZone);
  const toDate = to || today;
  const fromDate = from || addDays(toDate, -(MAX_DAYS - 1));
  if (!re.test(fromDate) || !re.test(toDate))
    return { ok: false, error: 'Dates must be YYYY-MM-DD.' };
  if (fromDate > toDate) return { ok: false, error: 'The start date is after the end date.' };
  if (toDate > today) return { ok: false, error: 'The period cannot end in the future.' };
  const startMs = localMidnightUtc(fromDate, timeZone);
  const endMs = localMidnightUtc(addDays(toDate, 1), timeZone);
  const days = Math.round((endMs - startMs) / 86400000);
  if (days > MAX_DAYS) return { ok: false, error: `A record covers at most ${MAX_DAYS} days.` };
  return { ok: true, from: fromDate, to: toDate, startMs, endMs: Math.min(endMs, now), days };
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * Build the record.
 *   org        { id, name }
 *   period     from parsePeriod()
 *   settings   { maxPlausibleKmh, signalLossSec, operatingHours, timeZone }
 *   vehicles   [{ id, plate, label, records, firstTs, lastTs, chainHead, truncated }]
 *   events     [{ ts, vehicleId, type, severity, message }]  (assurance only)
 *   meta       { generatedAt, generatedBy, dataSource, simulated }
 */
function buildPack({ org, period, settings, vehicles, events, meta }) {
  const types = ASSURANCE_TYPES;
  const byVehicle = new Map(
    vehicles.map((v) => [v.id, { ...v, findings: 0, high: 0, byType: {} }])
  );
  const checks = types.map((t) => ({
    type: t,
    name: ASSURANCE_LABELS[t],
    tests: CHECK_INFO[t].tests,
    threshold: CHECK_INFO[t].threshold(settings),
    findings: 0,
    vehiclesAffected: 0,
  }));
  const checkByType = new Map(checks.map((c) => [c.type, c]));
  const affected = new Map(types.map((t) => [t, new Set()]));

  const sorted = events.slice().sort((a, b) => new Date(a.ts) - new Date(b.ts));
  for (const e of sorted) {
    const c = checkByType.get(e.type);
    if (!c) continue;
    c.findings += 1;
    affected.get(e.type).add(e.vehicleId);
    const v = byVehicle.get(e.vehicleId);
    if (v) {
      v.findings += 1;
      if (e.severity === 'high') v.high += 1;
      v.byType[e.type] = (v.byType[e.type] || 0) + 1;
    }
  }
  for (const c of checks) {
    c.vehiclesAffected = affected.get(c.type).size;
    c.result = c.findings === 0 ? 'passed' : 'findings';
  }

  const vehicleRows = Array.from(byVehicle.values()).map((v) => ({
    id: v.id,
    plate: v.plate || null,
    label: v.label,
    records: v.records,
    firstTs: v.firstTs ? new Date(v.firstTs).toISOString() : null,
    lastTs: v.lastTs ? new Date(v.lastTs).toISOString() : null,
    chainHead: v.chainHead,
    truncated: !!v.truncated,
    findings: v.findings,
    high: v.high,
    byType: v.byType,
    result: v.records === 0 ? 'no_data' : v.findings === 0 ? 'passed' : 'findings',
  }));

  const totalFindings = checks.reduce((s, c) => s + c.findings, 0);
  const noData = vehicleRows.filter((v) => v.result === 'no_data').length;
  const overall = totalFindings === 0 && noData === 0 ? 'passed' : 'findings';

  const findings = sorted
    .filter((e) => checkByType.has(e.type))
    .map((e) => {
      const v = byVehicle.get(e.vehicleId);
      return {
        ts: new Date(e.ts).toISOString(),
        vehicleId: e.vehicleId,
        plate: v ? v.plate || null : null,
        check: ASSURANCE_LABELS[e.type],
        severity: e.severity,
        detail: e.message,
      };
    });

  // The fingerprint covers everything the page states, so a printed copy
  // can be matched to the audit-log entry written when it was generated.
  const body = {
    format: 'fleet-shield-evidence-record/draft-1',
    org: { id: org.id, name: org.name },
    period: {
      from: period.from,
      to: period.to,
      timeZone: settings.timeZone,
      startMs: period.startMs,
      endMs: period.endMs,
    },
    settings,
    checks: checks.map(({ type, findings, vehiclesAffected, result }) => ({
      type,
      findings,
      vehiclesAffected,
      result,
    })),
    vehicles: vehicleRows.map(({ id, records, chainHead, findings, result }) => ({
      id,
      records,
      chainHead,
      findings,
      result,
    })),
    findings: findings.map(({ ts, vehicleId, check, severity }) => ({
      ts,
      vehicleId,
      check,
      severity,
    })),
    generatedAt: meta.generatedAt,
  };
  const fingerprint = sha256(JSON.stringify(body));
  const reference = `FS-ER-${period.from.replace(/-/g, '')}-${fingerprint.slice(0, 8).toUpperCase()}`;

  return {
    draft: true,
    reference,
    fingerprint,
    org: { id: org.id, name: org.name },
    period: { from: period.from, to: period.to, days: period.days, timeZone: settings.timeZone },
    generatedAt: meta.generatedAt,
    generatedBy: meta.generatedBy,
    dataSource: meta.dataSource,
    simulated: !!meta.simulated,
    overall,
    totals: {
      vehicles: vehicleRows.length,
      records: vehicleRows.reduce((s, v) => s + v.records, 0),
      findings: totalFindings,
      vehiclesWithFindings: vehicleRows.filter((v) => v.findings > 0).length,
      vehiclesWithoutData: noData,
    },
    checks,
    vehicles: vehicleRows,
    findings,
  };
}

module.exports = {
  MAX_DAYS,
  CHECK_INFO,
  parsePeriod,
  localMidnightUtc,
  localToday,
  addDays,
  buildPack,
};
