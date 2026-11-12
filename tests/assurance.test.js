const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const a = require('../lib/assurance');
const ev = require('../lib/evidence');

const t0 = Date.parse('2026-11-12T03:00:00Z'); // 14:00 Melbourne (AEDT)

describe('GPS spoofing — impossible jumps', () => {
  test('ordinary driving is not flagged', () => {
    // ~0.5 km in 30 s = 60 km/h
    const prev = { lat: -37.8136, lng: 144.9631, t: t0 };
    const cur = { lat: -37.8091, lng: 144.9631, t: t0 + 30000 };
    assert.equal(a.detectJump(prev, cur), null);
  });

  test('a 15 km jump in 2 s is flagged with the implied speed', () => {
    const prev = { lat: -37.8136, lng: 144.9631, t: t0 };
    const cur = { lat: -37.6786, lng: 144.9631, t: t0 + 2000 };
    const j = a.detectJump(prev, cur);
    assert.ok(j);
    assert.ok(j.distanceKm > 14 && j.distanceKm < 16);
    assert.ok(j.impliedKmh > 20000);
  });

  test('intervals under a second are not judged (clock jitter)', () => {
    const prev = { lat: -37.8, lng: 144.9, t: t0 };
    assert.equal(a.detectJump(prev, { lat: -37.7, lng: 144.9, t: t0 + 500 }), null);
  });

  test('no previous fix, nothing to compare', () => {
    assert.equal(a.detectJump(null, { lat: 0, lng: 0, t: t0 }), null);
  });
});

describe('GPS jamming — signal loss with ignition on', () => {
  test('flags only past the threshold and only with ignition on', () => {
    assert.equal(a.isSignalLost({ lastFixAt: t0, ignitionOn: true, now: t0 + 59000 }), false);
    assert.equal(a.isSignalLost({ lastFixAt: t0, ignitionOn: true, now: t0 + 61000 }), true);
    assert.equal(a.isSignalLost({ lastFixAt: t0, ignitionOn: false, now: t0 + 600000 }), false);
    assert.equal(a.isSignalLost({ lastFixAt: null, ignitionOn: true, now: t0 }), false);
  });
});

describe('Odometer vs GPS distance', () => {
  test('small or proportionally minor differences pass', () => {
    assert.equal(a.detectOdometerMismatch(1.0, 0.9), null);
    assert.equal(a.detectOdometerMismatch(20.0, 18.8), null); // 1.2 km, under 1.5 km
  });
  test('a 6 km step over 0.8 km of driving is flagged', () => {
    const m = a.detectOdometerMismatch(6.8, 0.8);
    assert.ok(m);
    assert.equal(Math.round(m.diffKm), 6);
  });
  test('a rollback is flagged too', () => {
    assert.ok(a.detectOdometerMismatch(-4, 0.8));
  });
});

describe('Operating hours', () => {
  test('uses local time in the configured zone', () => {
    assert.equal(a.localHour(t0, 'Australia/Melbourne'), 14);
    assert.equal(a.isOutsideOperatingHours(t0), false);
    // 02:00 Melbourne
    assert.equal(a.isOutsideOperatingHours(Date.parse('2026-11-11T15:00:00Z')), true);
  });
  test('supports overnight shifts that wrap midnight', () => {
    const opts = { ...a.DEFAULTS, operatingHours: { start: 22, end: 6 } };
    assert.equal(a.isOutsideOperatingHours(Date.parse('2026-11-11T15:00:00Z'), opts), false); // 02:00 inside
    assert.equal(a.isOutsideOperatingHours(t0, opts), true); // 14:00 outside
  });
});

describe('Data trust score', () => {
  test('starts at 100 and drops with recent events, never below 0', () => {
    assert.equal(a.trustScore([], { now: t0 }), 100);
    assert.equal(a.trustScore([{ type: 'gps_jump', t: t0 - 1000 }], { now: t0 }), 85);
    assert.equal(a.trustScore([{ type: 'after_hours_movement', t: t0 }], { now: t0 }), 100);
    const many = Array.from({ length: 10 }, () => ({ type: 'device_tamper', t: t0 }));
    assert.equal(a.trustScore(many, { now: t0 }), 0);
  });
  test('events older than the window are ignored', () => {
    assert.equal(a.trustScore([{ type: 'gps_jump', t: t0 - 25 * 3600 * 1000 }], { now: t0 }), 100);
  });
});

describe('Tamper-evident evidence export', () => {
  const rows = [
    { ts: '2026-11-12T03:00:00Z', lat: -37.81, lng: 144.96, speed_kmh: 40, heading_deg: 90, status: 'moving', odometer_km: 100 },
    { ts: '2026-11-12T03:00:02Z', lat: -37.8101, lng: 144.9605, speed_kmh: 42, heading_deg: 91, status: 'moving', odometer_km: 100.02 },
    { ts: '2026-11-12T03:00:04Z', lat: -37.8102, lng: 144.961, speed_kmh: 0, heading_deg: 91, status: 'idling', odometer_km: 100.04 },
  ];
  const meta = { vehicle_id: 'VIC-01', plate: '1TK 4RD' };

  test('an untouched export verifies, and the head matches', () => {
    const { csv, head } = ev.buildEvidenceCsv(rows, meta);
    const r = ev.verifyEvidenceCsv(csv);
    assert.equal(r.ok, true);
    assert.equal(r.rows, 3);
    assert.equal(r.head, head);
  });

  test('editing any value breaks the chain at that row', () => {
    const { csv } = ev.buildEvidenceCsv(rows, meta);
    const tampered = csv.replace('-37.810100', '-37.820100');
    const r = ev.verifyEvidenceCsv(tampered);
    assert.equal(r.ok, false);
    assert.equal(r.firstBadRow, 2);
  });

  test('deleting a row is detected', () => {
    const { csv } = ev.buildEvidenceCsv(rows, meta);
    const lines = csv.split('\n');
    const dataStart = lines.findIndex((l) => l.startsWith('ts,'));
    lines.splice(dataStart + 2, 1);
    assert.equal(ev.verifyEvidenceCsv(lines.join('\n')).ok, false);
  });

  test('truncating the end is caught by the declared chain head', () => {
    const { csv } = ev.buildEvidenceCsv(rows, meta);
    const lines = csv.trimEnd().split('\n');
    lines.pop();
    const r = ev.verifyEvidenceCsv(lines.join('\n'));
    assert.equal(r.ok, false);
  });

  test('an empty period still produces a verifiable file', () => {
    const { csv, head } = ev.buildEvidenceCsv([], meta);
    assert.equal(head, ev.GENESIS);
    assert.equal(ev.verifyEvidenceCsv(csv).ok, true);
  });
});
