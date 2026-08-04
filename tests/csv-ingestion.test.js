// Unit tests for the CSV telemetry ingestion prototype (lib/ingestion/).
//
// These exercise the real parsing/validation/cumulative-total logic
// directly — no server, no database — matching the "do not create fake
// tests that do not exercise the real validation logic" requirement.
// HTTP-level auth-gating for the route that wires this up is covered
// separately in tests/telemetry-import-route.test.js.
//
// Run with: node --test tests/csv-ingestion.test.js  (or `npm test`)

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const csvAdapter = require('../lib/ingestion/csv-adapter');
const { computeCumulativeSeries, MAX_GAP_SECONDS } = require('../lib/ingestion/cumulative');
const { runCsvImport } = require('../lib/ingestion/import-service');
const { LIMITS } = require('../lib/ingestion/adapter-types');

const FIXTURE_CSV = fs.readFileSync(path.join(__dirname, 'fixtures', 'telemetry-sample.csv'), 'utf8');
const ORG_VEHICLE_IDS = new Set(['VIC-01', 'VIC-02']);

const VEHICLE_VIC01 = { id: 'VIC-01', fuelType: 'diesel', consumptionPer100: 14, idleRatePerHour: 1.3 };
const VEHICLE_VIC02 = { id: 'VIC-02', fuelType: 'diesel', consumptionPer100: 14, idleRatePerHour: 1.3 };

describe('csv-adapter.parse — valid input', () => {
  test('parses the fictional fixture file with no errors', () => {
    const { records, fileErrors, summary } = csvAdapter.parse(
      { text: FIXTURE_CSV },
      { orgVehicleIds: ORG_VEHICLE_IDS }
    );
    assert.deepEqual(fileErrors, []);
    assert.equal(summary.totalRows, 5);
    assert.equal(summary.validRows, 5);
    assert.equal(summary.invalidRows, 0);
    assert.ok(records.every((r) => r.validationStatus === 'valid'));
    assert.equal(records[0].vehicleId, 'VIC-01');
    assert.equal(records[0].integrationType, 'csv');
  });
});

describe('csv-adapter.parse — missing required columns', () => {
  test('rejects a file with no lat/lng columns', () => {
    const text = 'vehicle_id,timestamp\nVIC-01,2026-06-01T08:00:00Z\n';
    const { records, fileErrors } = csvAdapter.parse({ text }, { orgVehicleIds: ORG_VEHICLE_IDS });
    assert.equal(records.length, 0);
    assert.ok(fileErrors.some((e) => /Missing required column: "lat"/.test(e)));
    assert.ok(fileErrors.some((e) => /Missing required column: "lng"/.test(e)));
  });
});

describe('csv-adapter.parse — invalid timestamps', () => {
  test('rejects an unparseable timestamp', () => {
    const text = 'vehicle_id,timestamp,lat,lng\nVIC-01,not-a-date,-37.8,144.9\n';
    const { records } = csvAdapter.parse({ text }, { orgVehicleIds: ORG_VEHICLE_IDS });
    assert.equal(records[0].validationStatus, 'invalid');
    assert.ok(records[0].importErrors.some((e) => /unparseable timestamp/.test(e)));
  });

  test('rejects a timestamp far in the future', () => {
    const text = 'vehicle_id,timestamp,lat,lng\nVIC-01,2099-01-01T00:00:00Z,-37.8,144.9\n';
    const { records } = csvAdapter.parse({ text }, { orgVehicleIds: ORG_VEHICLE_IDS });
    assert.equal(records[0].validationStatus, 'invalid');
    assert.ok(records[0].importErrors.some((e) => /future/.test(e)));
  });
});

describe('csv-adapter.parse — invalid coordinates', () => {
  test('rejects out-of-range latitude', () => {
    const text = 'vehicle_id,timestamp,lat,lng\nVIC-01,2026-06-01T08:00:00Z,999,144.9\n';
    const { records } = csvAdapter.parse({ text }, { orgVehicleIds: ORG_VEHICLE_IDS });
    assert.equal(records[0].validationStatus, 'invalid');
    assert.ok(records[0].importErrors.some((e) => /^lat:/.test(e)));
  });

  test('rejects out-of-range longitude', () => {
    const text = 'vehicle_id,timestamp,lat,lng\nVIC-01,2026-06-01T08:00:00Z,-37.8,999\n';
    const { records } = csvAdapter.parse({ text }, { orgVehicleIds: ORG_VEHICLE_IDS });
    assert.equal(records[0].validationStatus, 'invalid');
    assert.ok(records[0].importErrors.some((e) => /^lng:/.test(e)));
  });
});

describe('csv-adapter.parse — duplicate rows', () => {
  test('flags the second occurrence of the same vehicle+timestamp as a duplicate', () => {
    const text =
      'vehicle_id,timestamp,lat,lng\n' +
      'VIC-01,2026-06-01T08:00:00Z,-37.8,144.9\n' +
      'VIC-01,2026-06-01T08:00:00Z,-37.8,144.9\n';
    const { records } = csvAdapter.parse({ text }, { orgVehicleIds: ORG_VEHICLE_IDS });
    assert.equal(records[0].validationStatus, 'valid');
    assert.equal(records[1].validationStatus, 'invalid');
    assert.ok(records[1].importErrors.some((e) => /Duplicate row/.test(e)));
  });
});

describe('csv-adapter.parse — unknown vehicle identifiers', () => {
  test('rejects a vehicle_id not registered to the org', () => {
    const text = 'vehicle_id,timestamp,lat,lng\nNOT-REAL,2026-06-01T08:00:00Z,-37.8,144.9\n';
    const { records } = csvAdapter.parse({ text }, { orgVehicleIds: ORG_VEHICLE_IDS });
    assert.equal(records[0].validationStatus, 'invalid');
    assert.ok(records[0].importErrors.some((e) => /Unknown vehicle identifier/.test(e)));
  });
});

describe('csv-adapter.parse — file size and row-count limits', () => {
  test('rejects a file larger than MAX_FILE_BYTES', () => {
    const bigField = 'x'.repeat(LIMITS.MAX_FILE_BYTES + 100);
    const text = `vehicle_id,timestamp,lat,lng,source_ref\nVIC-01,2026-06-01T08:00:00Z,-37.8,144.9,${bigField}\n`;
    const { records, fileErrors } = csvAdapter.parse({ text }, { orgVehicleIds: ORG_VEHICLE_IDS });
    assert.equal(records.length, 0);
    assert.ok(fileErrors.some((e) => /exceeds the maximum allowed size/.test(e)));
  });

  test('rejects a file with more data rows than MAX_ROWS', () => {
    const header = 'vehicle_id,timestamp,lat,lng\n';
    const row = 'VIC-01,2026-06-01T08:00:00Z,-37.8,144.9\n';
    const text = header + row.repeat(LIMITS.MAX_ROWS + 1);
    const { records, fileErrors } = csvAdapter.parse({ text }, { orgVehicleIds: ORG_VEHICLE_IDS });
    assert.equal(records.length, 0);
    assert.ok(fileErrors.some((e) => /exceeding the limit/.test(e)));
  });
});

describe('csv-adapter.parse — spreadsheet formula injection defence', () => {
  test('neutralises a free-text field starting with a formula-trigger character', () => {
    const text = 'vehicle_id,timestamp,lat,lng,driver_id\nVIC-01,2026-06-01T08:00:00Z,-37.8,144.9,=cmd|\'/c calc\'!A1\n';
    const { records } = csvAdapter.parse({ text }, { orgVehicleIds: ORG_VEHICLE_IDS });
    assert.equal(records[0].driverId[0], "'", 'formula-trigger char must be neutralised with a leading quote');
    assert.ok(!records[0].driverId.startsWith('='), 'must not be stored as a raw formula');
  });

  test('does not execute or evaluate anything — the field is stored as an inert string', () => {
    const text = 'vehicle_id,timestamp,lat,lng,source_ref\nVIC-01,2026-06-01T08:00:00Z,-37.8,144.9,@SUM(1+1)\n';
    const { records } = csvAdapter.parse({ text }, { orgVehicleIds: ORG_VEHICLE_IDS });
    assert.equal(typeof records[0].rawSourceRef, 'string');
    assert.match(records[0].rawSourceRef, /^'@SUM/);
  });
});

describe('csv-adapter.parse — malformed delimiters', () => {
  test('flags a row with a different field count than the header as invalid rather than crashing', () => {
    const text = 'vehicle_id,timestamp,lat,lng\nVIC-01,2026-06-01T08:00:00Z,-37.8\n';
    assert.doesNotThrow(() => csvAdapter.parse({ text }, { orgVehicleIds: ORG_VEHICLE_IDS }));
    const { records } = csvAdapter.parse({ text }, { orgVehicleIds: ORG_VEHICLE_IDS });
    assert.equal(records[0].validationStatus, 'invalid');
    assert.ok(records[0].importErrors.some((e) => /malformed delimiters/.test(e)));
  });

  test('handles quoted fields containing commas correctly', () => {
    const text = 'vehicle_id,timestamp,lat,lng,driver_id\nVIC-01,2026-06-01T08:00:00Z,-37.8,144.9,"Smith, J."\n';
    const { records } = csvAdapter.parse({ text }, { orgVehicleIds: ORG_VEHICLE_IDS });
    assert.equal(records[0].validationStatus, 'valid');
    assert.equal(records[0].driverId, 'Smith, J.');
  });
});

describe('csv-adapter.parse — empty/malformed files handled without crashing', () => {
  test('empty file produces a file-level error, not a throw', () => {
    assert.doesNotThrow(() => csvAdapter.parse({ text: '' }, { orgVehicleIds: ORG_VEHICLE_IDS }));
    const { fileErrors, records } = csvAdapter.parse({ text: '' }, { orgVehicleIds: ORG_VEHICLE_IDS });
    assert.equal(records.length, 0);
    assert.ok(fileErrors.some((e) => /empty/.test(e)));
  });
});

describe('cumulative.computeCumulativeSeries', () => {
  test('computes moving fuel/CO2 deltas from odometer readings using the vehicle\'s real fuel factors', () => {
    const observations = [
      { timestampIso: '2026-06-01T08:00:00.000Z', lat: -37.81, lng: 144.96, speedKmh: 30, ignitionOn: true, odometerKm: 100 },
      { timestampIso: '2026-06-01T08:05:00.000Z', lat: -37.82, lng: 144.97, speedKmh: 30, ignitionOn: true, odometerKm: 105 },
    ];
    const { rows, warnings } = computeCumulativeSeries(VEHICLE_VIC01, observations, null);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].odometerKm, 105);
    // 5km at 14 L/100km = 0.7 L; diesel EMISSION_FACTORS_KG = 2.68 kg/L
    assert.ok(Math.abs(rows[1].fuelUsedTotal - 0.7) < 1e-9);
    assert.ok(Math.abs(rows[1].co2KgTotal - 0.7 * 2.68) < 1e-9);
    assert.equal(rows[1].status, 'moving');
    assert.deepEqual(warnings, []);
  });

  test('idling time accrues fuel via idleRatePerHour, not distance', () => {
    const observations = [
      { timestampIso: '2026-06-01T08:00:00.000Z', lat: -37.81, lng: 144.96, speedKmh: 0, ignitionOn: true, odometerKm: 100 },
      { timestampIso: '2026-06-01T08:30:00.000Z', lat: -37.81, lng: 144.96, speedKmh: 0, ignitionOn: true, odometerKm: 100 },
    ];
    const { rows } = computeCumulativeSeries(VEHICLE_VIC01, observations, null);
    // 30 minutes idling at 1.3 L/hour = 0.65 L
    assert.ok(Math.abs(rows[1].fuelUsedTotal - 0.65) < 1e-9);
    assert.equal(rows[1].idlingSec, 1800);
    assert.equal(rows[1].status, 'idling');
  });

  test('increments trip_count on a transition into moving', () => {
    const observations = [
      { timestampIso: '2026-06-01T08:00:00.000Z', lat: -37.81, lng: 144.96, speedKmh: 0, ignitionOn: true, odometerKm: 100 },
      { timestampIso: '2026-06-01T08:05:00.000Z', lat: -37.82, lng: 144.97, speedKmh: 30, ignitionOn: true, odometerKm: 103 },
      { timestampIso: '2026-06-01T08:10:00.000Z', lat: -37.81, lng: 144.96, speedKmh: 0, ignitionOn: true, odometerKm: 103 },
      { timestampIso: '2026-06-01T08:15:00.000Z', lat: -37.82, lng: 144.97, speedKmh: 30, ignitionOn: true, odometerKm: 106 },
    ];
    const { rows } = computeCumulativeSeries(VEHICLE_VIC01, observations, null);
    assert.equal(rows[rows.length - 1].tripCount, 2);
  });

  test('caps elapsed time attributed to a gap larger than MAX_GAP_SECONDS and warns', () => {
    const observations = [
      { timestampIso: '2026-06-01T08:00:00.000Z', lat: -37.81, lng: 144.96, speedKmh: 0, ignitionOn: true, odometerKm: 100 },
      { timestampIso: '2026-06-02T08:00:00.000Z', lat: -37.81, lng: 144.96, speedKmh: 0, ignitionOn: true, odometerKm: 100 },
    ];
    const { rows, warnings } = computeCumulativeSeries(VEHICLE_VIC01, observations, null);
    assert.equal(rows[1].idlingSec, MAX_GAP_SECONDS);
    assert.ok(warnings.some((w) => /gap of/.test(w)));
  });

  test('continues from a supplied starting total rather than resetting to zero', () => {
    const startingTotals = {
      tsIso: '2026-06-01T07:55:00.000Z',
      lat: -37.80,
      lng: 144.95,
      odometerKm: 50000,
      fuelUsedTotal: 999,
      co2KgTotal: 500,
      movingSec: 100,
      idlingSec: 50,
      tripCount: 3,
      lastStatus: 'idling',
    };
    const observations = [
      { timestampIso: '2026-06-01T08:00:00.000Z', lat: -37.81, lng: 144.96, speedKmh: 20, ignitionOn: true, odometerKm: 50001 },
    ];
    const { rows } = computeCumulativeSeries(VEHICLE_VIC01, observations, startingTotals);
    assert.equal(rows[0].odometerKm, 50001);
    assert.ok(rows[0].fuelUsedTotal > 999);
    assert.equal(rows[0].tripCount, 4); // idling -> moving transition
  });
});

describe('import-service.runCsvImport — orchestration', () => {
  function fakeVehicles() {
    return [VEHICLE_VIC01, VEHICLE_VIC02];
  }

  test('rejects a fatal file error before ever calling writePositions', async () => {
    let writeCalled = false;
    const result = await runCsvImport({
      csvText: 'vehicle_id,timestamp\nVIC-01,2026-06-01T08:00:00Z\n', // missing lat/lng
      orgId: 'org_1',
      vehicles: fakeVehicles(),
      getLatestPosition: async () => null,
      writePositions: async () => {
        writeCalled = true;
      },
    });
    assert.equal(result.accepted, false);
    assert.equal(writeCalled, false, 'writePositions must not be called when the file is rejected outright');
  });

  test('imports only the valid rows in a mixed valid/invalid file (partial import behaviour)', async () => {
    const text =
      'vehicle_id,timestamp,lat,lng\n' +
      'VIC-01,2026-06-01T08:00:00Z,-37.81,144.96\n' + // valid
      'VIC-01,not-a-date,-37.81,144.96\n' + // invalid: bad timestamp
      'NOT-REAL,2026-06-01T08:05:00Z,-37.81,144.96\n'; // invalid: unknown vehicle

    let writtenRows = null;
    const result = await runCsvImport({
      csvText: text,
      orgId: 'org_1',
      vehicles: fakeVehicles(),
      getLatestPosition: async () => null,
      writePositions: async (orgId, rows) => {
        writtenRows = rows;
      },
    });

    assert.equal(result.accepted, true);
    assert.equal(result.summary.validRows, 1);
    assert.equal(result.summary.invalidRows, 2);
    assert.equal(result.invalidRows.length, 2);
    assert.equal(writtenRows.length, 1);
    assert.equal(writtenRows[0].vehicleId, 'VIC-01');
  });

  test('a database write failure propagates rather than being silently swallowed', async () => {
    const text = 'vehicle_id,timestamp,lat,lng\nVIC-01,2026-06-01T08:00:00Z,-37.81,144.96\n';
    await assert.rejects(
      runCsvImport({
        csvText: text,
        orgId: 'org_1',
        vehicles: fakeVehicles(),
        getLatestPosition: async () => null,
        writePositions: async () => {
          throw new Error('simulated DB failure');
        },
      }),
      /simulated DB failure/
    );
  });

  test('continues cumulative totals from getLatestPosition rather than restarting at zero', async () => {
    const text = 'vehicle_id,timestamp,lat,lng,odometer_km\nVIC-01,2026-06-01T08:00:00Z,-37.81,144.96,60100\n';
    let writtenRows = null;
    await runCsvImport({
      csvText: text,
      orgId: 'org_1',
      vehicles: fakeVehicles(),
      getLatestPosition: async (vehicleId) =>
        vehicleId === 'VIC-01'
          ? { ts: '2026-06-01T07:00:00.000Z', lat: -37.80, lng: 144.95, odometer_km: 60000, fuel_used_total: 500, co2_kg_total: 1340, moving_sec_total: 0, idling_sec_total: 0, trip_count: 1, status: 'idling' }
          : null,
      writePositions: async (orgId, rows) => {
        writtenRows = rows;
      },
    });
    assert.equal(writtenRows[0].odometerKm, 60100);
    assert.ok(writtenRows[0].fuelUsedTotal > 500, 'fuel total should continue accumulating, not reset to zero');
  });
});
