const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const ep = require('../lib/evidence-pack');

const TZ = 'Australia/Melbourne';
const settings = {
  maxPlausibleKmh: 250,
  signalLossSec: 60,
  operatingHours: { start: 6, end: 20 },
  timeZone: TZ,
};
const org = { id: 'org1', name: 'Test Fleet Pty Ltd' };
const meta = {
  generatedAt: '2026-11-22T09:00:00.000Z',
  generatedBy: 'admin',
  dataSource: 'test',
  simulated: true,
};

describe('period', () => {
  const now = Date.parse('2026-11-22T09:00:00Z'); // 20:00 Melbourne (AEDT, UTC+11)

  test('local midnight in Melbourne during daylight saving', () => {
    assert.equal(
      new Date(ep.localMidnightUtc('2026-11-20', TZ)).toISOString(),
      '2026-11-19T13:00:00.000Z'
    );
  });

  test('local midnight in Melbourne outside daylight saving', () => {
    assert.equal(
      new Date(ep.localMidnightUtc('2026-06-20', TZ)).toISOString(),
      '2026-06-19T14:00:00.000Z'
    );
  });

  test('defaults to the last 7 local days, ending now', () => {
    const p = ep.parsePeriod({}, { now, timeZone: TZ });
    assert.equal(p.ok, true);
    assert.equal(p.to, '2026-11-22');
    assert.equal(p.from, '2026-11-16');
    assert.equal(p.days, 7);
    assert.equal(p.endMs, now);
  });

  test('a single past day covers that local day exactly', () => {
    const p = ep.parsePeriod({ from: '2026-11-20', to: '2026-11-20' }, { now, timeZone: TZ });
    assert.equal(p.ok, true);
    assert.equal(p.endMs - p.startMs, 86400000);
  });

  test('rejects bad input', () => {
    assert.equal(ep.parsePeriod({ from: '20/11/2026' }, { now, timeZone: TZ }).ok, false);
    assert.equal(
      ep.parsePeriod({ from: '2026-11-21', to: '2026-11-20' }, { now, timeZone: TZ }).ok,
      false
    );
    assert.equal(
      ep.parsePeriod({ from: '2026-11-01', to: '2026-11-20' }, { now, timeZone: TZ }).ok,
      false
    );
    assert.equal(ep.parsePeriod({ to: '2026-11-30' }, { now, timeZone: TZ }).ok, false);
  });
});

describe('record', () => {
  const period = ep.parsePeriod(
    { from: '2026-11-20', to: '2026-11-20' },
    { now: Date.parse('2026-11-22T09:00:00Z'), timeZone: TZ }
  );
  const vehicles = [
    {
      id: 'V1',
      plate: '1AB 2CD',
      label: 'Van 1',
      records: 2000,
      firstTs: '2026-11-19T13:00:05Z',
      lastTs: '2026-11-20T12:59:55Z',
      chainHead: 'a'.repeat(64),
    },
    {
      id: 'V2',
      plate: '3EF 4GH',
      label: 'Van 2',
      records: 1800,
      firstTs: '2026-11-19T13:00:05Z',
      lastTs: '2026-11-20T12:59:55Z',
      chainHead: 'b'.repeat(64),
    },
    {
      id: 'V3',
      plate: null,
      label: 'Van 3',
      records: 0,
      firstTs: null,
      lastTs: null,
      chainHead: '0'.repeat(64),
    },
  ];
  const events = [
    {
      ts: '2026-11-20T02:00:00Z',
      vehicleId: 'V1',
      type: 'device_tamper',
      severity: 'high',
      message: 'power disconnected',
    },
    {
      ts: '2026-11-20T01:00:00Z',
      vehicleId: 'V1',
      type: 'gps_jump',
      severity: 'high',
      message: 'jumped 18 km',
    },
    {
      ts: '2026-11-20T03:00:00Z',
      vehicleId: 'V2',
      type: 'device_tamper',
      severity: 'high',
      message: 'power disconnected',
    },
  ];

  test('every check is listed, with pass or findings', () => {
    const r = ep.buildPack({ org, period, settings, vehicles, events, meta });
    assert.equal(r.checks.length, 5);
    const tamper = r.checks.find((c) => c.type === 'device_tamper');
    assert.equal(tamper.findings, 2);
    assert.equal(tamper.vehiclesAffected, 2);
    assert.equal(tamper.result, 'findings');
    assert.equal(r.checks.find((c) => c.type === 'odometer_mismatch').result, 'passed');
    assert.match(r.checks.find((c) => c.type === 'gps_jump').threshold, /250 km\/h/);
  });

  test('vehicles get a result; no data is never a pass', () => {
    const r = ep.buildPack({ org, period, settings, vehicles, events, meta });
    assert.equal(r.vehicles.find((v) => v.id === 'V1').result, 'findings');
    assert.equal(r.vehicles.find((v) => v.id === 'V3').result, 'no_data');
    assert.equal(r.overall, 'findings');
    assert.equal(r.totals.vehiclesWithoutData, 1);
  });

  test('a clean period with data for every vehicle passes overall', () => {
    const r = ep.buildPack({
      org,
      period,
      settings,
      vehicles: vehicles.slice(0, 2),
      events: [],
      meta,
    });
    assert.equal(r.overall, 'passed');
    assert.ok(r.checks.every((c) => c.result === 'passed'));
  });

  test('findings are listed oldest first, with the reason', () => {
    const r = ep.buildPack({ org, period, settings, vehicles, events, meta });
    assert.deepEqual(
      r.findings.map((f) => f.detail),
      ['jumped 18 km', 'power disconnected', 'power disconnected']
    );
    assert.equal(r.findings[0].plate, '1AB 2CD');
  });

  test('the fingerprint is stable and changes when the content changes', () => {
    const a = ep.buildPack({ org, period, settings, vehicles, events, meta });
    const b = ep.buildPack({ org, period, settings, vehicles, events, meta });
    assert.equal(a.fingerprint, b.fingerprint);
    assert.match(a.reference, /^FS-ER-20261120-[0-9A-F]{8}$/);
    const c = ep.buildPack({ org, period, settings, vehicles, events: events.slice(1), meta });
    assert.notEqual(a.fingerprint, c.fingerprint);
  });

  test('it is marked as a draft format', () => {
    assert.equal(ep.buildPack({ org, period, settings, vehicles, events, meta }).draft, true);
  });
});
