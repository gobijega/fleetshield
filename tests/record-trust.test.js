// Tests for the record trust report (lib/ingestion/record-trust.js): the
// share of an export's records that fail a check — the number a founding
// pilot is set up to measure. Runs the real CSV adapter on small files.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const csvAdapter = require('../lib/ingestion/csv-adapter');
const { buildRecordTrustReport } = require('../lib/ingestion/record-trust');
const { runCsvImport } = require('../lib/ingestion/import-service');

const IDS = new Set(['VIC-01', 'VIC-02']);
const HEADER = 'vehicle_id,timestamp,lat,lng,speed_kmh,odometer_km';
const FIXTURE_CSV = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'telemetry-sample.csv'),
  'utf8'
);

function report(lines) {
  const { records } = csvAdapter.parse(
    { text: [HEADER, ...lines].join('\n') },
    { orgVehicleIds: IDS }
  );
  return buildRecordTrustReport(records);
}

// A steady drive: one fix a minute heading north at ~33 km/h, odometer in step.
function drive(
  vid,
  n,
  { start = '2026-06-01T08:00:00Z', lat = -37.8, lng = 144.96, odo = 1000 } = {}
) {
  const t0 = Date.parse(start);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const la = lat + i * 0.005; // ~0.556 km per minute
    rows.push(
      `${vid},${new Date(t0 + i * 60000).toISOString()},${la.toFixed(6)},${lng},33,${(odo + i * 0.556).toFixed(3)}`
    );
  }
  return rows;
}

describe('record trust report', () => {
  test('a clean export passes in full', () => {
    const r = report(drive('VIC-01', 30));
    assert.equal(r.recordsAssessed, 30);
    assert.equal(r.recordsFailed, 0);
    assert.equal(r.recordsPassedPercent, 100);
    assert.deepEqual(r.vehicleDays, { total: 1, flagged: 0 });
  });

  test('the fixture file is clean', () => {
    const { records } = csvAdapter.parse({ text: FIXTURE_CSV }, { orgVehicleIds: IDS });
    const r = buildRecordTrustReport(records);
    assert.equal(r.recordsFailed, 0);
  });

  test('an impossible jump fails that record only, and later fixes are compared with the last trusted one', () => {
    const rows = drive('VIC-01', 10);
    rows.splice(5, 1, 'VIC-01,2026-06-01T08:05:00Z,-33.8688,151.2093,33,1002.780'); // Sydney, a minute later
    const r = report(rows);
    assert.equal(r.recordsFailed, 1);
    assert.equal(r.byCheck.impossible_jump, 1);
    assert.deepEqual(r.failedRecords, [
      { row: 7, vehicleId: 'VIC-01', checks: ['impossible_jump'] },
    ]);
    assert.deepEqual(r.vehicleDays, { total: 1, flagged: 1 });
  });

  test('every row in a frozen run fails', () => {
    const rows = drive('VIC-01', 6);
    const frozen = ['08:06', '08:07', '08:08'].map(
      (hm, i) => `VIC-01,2026-06-01T${hm}:00Z,-37.770000,144.96,45,${1003.4 + i * 0.7}`
    );
    const r = report([...rows, ...frozen]);
    assert.equal(r.byCheck.frozen_position, 3);
    assert.equal(r.recordsFailed, 3);
  });

  test('an odometer running backwards fails that record', () => {
    const rows = drive('VIC-01', 10);
    rows[6] = rows[6].replace(/,[\d.]+$/, ',900.000');
    const r = report(rows);
    assert.ok(r.byCheck.odometer_backwards >= 1);
    assert.ok(r.failedRecords.some((f) => f.row === 8 && f.checks.includes('odometer_backwards')));
  });

  test('rejected rows count as failed; unknown vehicles are not assessed', () => {
    const rows = [
      ...drive('VIC-01', 10),
      'VIC-01,2026-06-01T09:00:00Z,999,144.96,0,1010',
      ...drive('NOPE-9', 3),
    ];
    const r = report(rows);
    assert.equal(r.recordsNotAssessed, 3);
    assert.equal(r.recordsAssessed, 11);
    assert.equal(r.byCheck.rejected, 1);
    assert.equal(r.recordsFailed, 1);
  });

  test('a silent move flags the vehicle-day without failing any record', () => {
    const a = drive('VIC-01', 10);
    const b = drive('VIC-01', 10, { start: '2026-06-01T08:40:00Z', lat: -37.7, odo: 1016 });
    const r = report([...a, ...b]);
    assert.equal(r.recordsFailed, 0);
    assert.equal(r.byCheck.moved_without_reporting, 1);
    assert.deepEqual(r.vehicleDays, { total: 1, flagged: 1 });
  });

  test('odometer disagreeing with GPS on an ungapped day flags the vehicle-day', () => {
    const rows = drive('VIC-01', 30).map((l, i) =>
      l.replace(/,[\d.]+$/, ',' + (1000 + i * 1.2).toFixed(3))
    );
    const r = report(rows);
    assert.equal(r.byCheck.odometer_mismatch, 1);
    assert.equal(r.recordsFailed, 0);
    assert.equal(r.vehicleDays.flagged, 1);
  });

  test('one failure never rounds to 100% passed or 0% failed', () => {
    const rows = drive('VIC-01', 2000);
    rows[1000] = rows[1000].replace(/,[\d.]+$/, ',1.000');
    const r = report(rows);
    assert.ok(r.recordsFailed >= 1);
    assert.ok(r.recordsPassedPercent < 100);
    assert.ok(r.recordsFailedPercent > 0);
  });

  test('vehicles are listed worst first', () => {
    const v1 = drive('VIC-01', 10);
    v1.splice(5, 1, 'VIC-01,2026-06-01T08:05:00Z,-33.8688,151.2093,33,1002.780');
    const r = report([...drive('VIC-02', 10), ...v1]);
    assert.equal(r.byVehicle[0].vehicleId, 'VIC-01');
    assert.equal(r.byVehicle[0].failed, 1);
    assert.equal(r.byVehicle[1].failed, 0);
  });
});

describe('runCsvImport includes the trust report', () => {
  test('accepted imports carry trustReport', async () => {
    const result = await runCsvImport({
      csvText: FIXTURE_CSV,
      orgId: 'org-1',
      vehicles: [
        { id: 'VIC-01', fuelType: 'diesel', consumptionPer100: 14, idleRatePerHour: 1.3 },
        { id: 'VIC-02', fuelType: 'diesel', consumptionPer100: 14, idleRatePerHour: 1.3 },
      ],
      getLatestPosition: async () => null,
      writePositions: async () => {},
    });
    assert.equal(result.accepted, true);
    assert.equal(result.trustReport.recordsAssessed, 5);
    assert.equal(result.trustReport.recordsPassedPercent, 100);
  });
});
