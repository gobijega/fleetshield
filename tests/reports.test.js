// Reporting engine (lib/reports.js) — period resolution, day-by-day
// activity from cumulative counters, period comparison and findings.
//
// Run with: node --test tests/*.test.js (or `npm test`)

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolvePeriod,
  parseFuelFilter,
  dailyActivity,
  buildReport,
  addDays,
} = require('../lib/reports');

const TZ = 'Australia/Melbourne';
// 2026-11-12 05:00 Melbourne (UTC+11) = 2026-11-11T18:00Z
const NOW = new Date('2026-11-11T18:00:00Z');

describe('resolvePeriod', () => {
  test('defaults to the last 14 local days ending today, with an equal prior period', () => {
    const p = resolvePeriod({}, TZ, NOW);
    assert.equal(p.to, '2026-11-12'); // local date, not the UTC date
    assert.equal(p.from, '2026-10-30');
    assert.equal(p.days, 14);
    assert.deepEqual(p.previous, { from: '2026-10-16', to: '2026-10-29' });
    assert.equal(p.includesToday, true);
  });

  test('today preset compares with yesterday', () => {
    const p = resolvePeriod({ preset: 'today' }, TZ, NOW);
    assert.equal(p.from, '2026-11-12');
    assert.deepEqual(p.previous, { from: '2026-11-11', to: '2026-11-11' });
  });

  test('custom ranges are inclusive and clamp an end date in the future', () => {
    const p = resolvePeriod({ from: '2026-11-01', to: '2026-12-01' }, TZ, NOW);
    assert.equal(p.to, '2026-11-12');
    assert.equal(p.days, 12);
    assert.equal(p.preset, null);
  });

  test('rejects malformed, reversed, future and over-long ranges', () => {
    assert.ok(resolvePeriod({ from: '2026-11-31', to: '2026-12-01' }, TZ, NOW).error);
    assert.ok(resolvePeriod({ from: 'yesterday', to: '2026-11-01' }, TZ, NOW).error);
    assert.ok(resolvePeriod({ from: '2026-11-05', to: '2026-11-01' }, TZ, NOW).error);
    assert.ok(resolvePeriod({ from: '2026-12-01', to: '2026-12-02' }, TZ, NOW).error);
    assert.ok(resolvePeriod({ from: '2026-01-01', to: '2026-11-01' }, TZ, NOW).error);
    assert.ok(resolvePeriod({ preset: '365d' }, TZ, NOW).error);
    assert.ok(resolvePeriod({ preset: '__proto__' }, TZ, NOW).error);
  });
});

describe('parseFuelFilter', () => {
  test('accepts all/known fuel types and rejects anything else', () => {
    assert.deepEqual(parseFuelFilter(undefined), { fuel: null });
    assert.deepEqual(parseFuelFilter('all'), { fuel: null });
    assert.deepEqual(parseFuelFilter('ev'), { fuel: 'ev' });
    assert.ok(parseFuelFilter('hydrogen').error);
  });
});

// Builds midnight-boundary rows from a list of per-day increments.
function boundaryRowsFor(vehicleId, firstBoundary, increments, start = {}) {
  const rows = [];
  let c = {
    odometer_km: 0,
    fuel_used_total: 0,
    co2_kg_total: 0,
    moving_sec_total: 0,
    idling_sec_total: 0,
    trip_count: 0,
    ...start,
  };
  let hasHistory = Object.keys(start).length > 0;
  for (let i = 0; i <= increments.length; i++) {
    const day = addDays(firstBoundary, i);
    rows.push(
      hasHistory
        ? { vehicle_id: vehicleId, day, ...c }
        : { vehicle_id: vehicleId, day, odometer_km: null }
    );
    const inc = increments[i];
    if (inc) {
      hasHistory = true;
      c = {
        odometer_km: c.odometer_km + (inc.km || 0),
        fuel_used_total: c.fuel_used_total + (inc.fuel || 0),
        co2_kg_total: c.co2_kg_total + (inc.co2 || 0),
        moving_sec_total: c.moving_sec_total + (inc.moving || 0),
        idling_sec_total: c.idling_sec_total + (inc.idle || 0),
        trip_count: c.trip_count + (inc.trips || 0),
      };
    }
  }
  return rows;
}

describe('dailyActivity', () => {
  test('differences consecutive midnight counters into per-day activity', () => {
    const rows = boundaryRowsFor('A', '2026-11-01', [{ km: 10 }, { km: 0 }, { km: 25.5 }], {
      odometer_km: 1000,
    });
    const days = dailyActivity(rows, ['A'], '2026-11-01', '2026-11-03').get('A');
    assert.equal(days.get('2026-11-01').km, 10);
    assert.equal(days.get('2026-11-02').km, 0);
    assert.equal(days.get('2026-11-03').km, 25.5);
  });

  test('a vehicle with no history before a day starts from zero', () => {
    const rows = boundaryRowsFor('A', '2026-11-01', [null, { km: 40 }]);
    const days = dailyActivity(rows, ['A'], '2026-11-01', '2026-11-02').get('A');
    assert.equal(days.get('2026-11-01').km, 0);
    assert.equal(days.get('2026-11-02').km, 40);
  });

  test('a counter going backwards is never negative activity', () => {
    const rows = [
      {
        vehicle_id: 'A',
        day: '2026-11-01',
        odometer_km: 500,
        fuel_used_total: 0,
        co2_kg_total: 0,
        moving_sec_total: 0,
        idling_sec_total: 0,
        trip_count: 0,
      },
      {
        vehicle_id: 'A',
        day: '2026-11-02',
        odometer_km: 20,
        fuel_used_total: 0,
        co2_kg_total: 0,
        moving_sec_total: 0,
        idling_sec_total: 0,
        trip_count: 0,
      },
    ];
    assert.equal(
      dailyActivity(rows, ['A'], '2026-11-01', '2026-11-01').get('A').get('2026-11-01').km,
      0
    );
  });
});

describe('buildReport', () => {
  const period = resolvePeriod({ preset: '7d' }, TZ, NOW); // 06–12 Nov, prev 30 Oct–05 Nov
  const vehicles = [
    { id: 'A', label: 'Truck A', driver: 'Ann', fuelType: 'diesel', idleRatePerHour: 1.5 },
    { id: 'B', label: 'Van B', driver: 'Bo', fuelType: 'ev', idleRatePerHour: 1 },
  ];
  // 14 days of increments: previous 7 then current 7.
  const dieselDay = { km: 100, fuel: 15, co2: 15 * 2.68, moving: 4 * 3600, idle: 3600, trips: 3 };
  const evDay = { km: 50, fuel: 10, co2: 10 * 0.85, moving: 2 * 3600, idle: 0, trips: 2 };
  const boundaryRows = [
    ...boundaryRowsFor(
      'A',
      period.previous.from,
      [...Array(7).fill(dieselDay), ...Array(7).fill({ ...dieselDay, km: 120 })],
      { odometer_km: 5000 }
    ),
    ...boundaryRowsFor('B', period.previous.from, Array(14).fill(evDay), { odometer_km: 100 }),
  ];
  const alertRows = [
    {
      vehicle_id: 'A',
      type: 'speeding',
      severity: 'high',
      day: '2026-11-10',
      dow: 2,
      hour: 7,
      n: 3,
    },
    {
      vehicle_id: 'A',
      type: 'harsh_braking',
      severity: 'medium',
      day: '2026-11-11',
      dow: 3,
      hour: 8,
      n: 2,
    },
    {
      vehicle_id: 'B',
      type: 'geofence_exit',
      severity: 'info',
      day: '2026-11-11',
      dow: 3,
      hour: 9,
      n: 4,
    },
    {
      vehicle_id: 'A',
      type: 'speeding',
      severity: 'high',
      day: '2026-11-01',
      dow: 7,
      hour: 7,
      n: 1,
    }, // previous period
    {
      vehicle_id: 'ZZ',
      type: 'speeding',
      severity: 'high',
      day: '2026-11-10',
      dow: 2,
      hour: 7,
      n: 9,
    }, // out of scope
  ];
  const report = buildReport({ period, vehicles, boundaryRows, alertRows, generatedAt: NOW });

  test('period totals and comparison', () => {
    assert.equal(report.kpis.distanceKm.value, 7 * 120 + 7 * 50);
    assert.equal(report.kpis.distanceKm.previous, 7 * 100 + 7 * 50);
    assert.equal(report.kpis.distanceKm.changePct, 13.3); // 1190 vs 1050
    assert.equal(report.kpis.fuelL.value, 105); // diesel only
    assert.equal(report.kpis.energyKwh.value, 70); // EV only
    assert.equal(report.kpis.idleFuelL.value, 11); // 7 h × 1.5 L/h, rounded
  });

  test('alerts are scoped to the period and the vehicles in scope', () => {
    assert.equal(report.kpis.events.value, 5); // info excluded, ZZ excluded
    assert.equal(report.kpis.events.previous, 1);
    assert.equal(report.kpis.highSeverity.value, 3);
    const a = report.perVehicle.find((v) => v.id === 'A');
    assert.deepEqual(a.alerts, { high: 3, medium: 2, low: 0, info: 0 });
    // weighted 3×8 + 2×4 = 32 over 840 km → 3.81 per 100 km
    assert.equal(a.riskPer100Km, 3.81);
    assert.equal(report.alertHeatmap.cells[1][7], 3); // Tuesday 07:00
    assert.equal(report.alertHeatmap.cells[2][9], 0); // info not in heatmap
  });

  test('per-vehicle measures', () => {
    const a = report.perVehicle.find((v) => v.id === 'A');
    assert.equal(a.distanceKm, 840);
    assert.equal(a.activeDays, 7);
    assert.equal(a.utilisationPct, 80); // 4 h moving of 5 h engine-on
    assert.equal(a.co2GPerKm, Math.round(((7 * 15 * 2.68) / 840) * 1000));
    assert.equal(a.daily.length, 7);
    assert.equal(a.previous.distanceKm, 700);
  });

  test('series and breakdowns cover every day of the period', () => {
    assert.equal(report.series.length, 7);
    assert.equal(report.series[0].day, '2026-11-06');
    assert.equal(report.series[0].distanceKm, 170);
    assert.deepEqual(
      report.byFuelType.map((f) => f.fuelType),
      ['diesel', 'ev']
    );
    assert.equal(report.alertTypes[0].type, 'speeding'); // highest weighted impact first
  });

  test('findings are factual and only fire when supported', () => {
    assert.ok(Array.isArray(report.findings));
    const titles = report.findings.map((f) => f.title);
    assert.ok(titles.includes('Idling'));
    // Only one non-EV vehicle in a 2-vehicle fleet — no concentration claim.
    assert.ok(!titles.includes('Emissions are concentrated'));
  });

  test('an empty period says so rather than inventing findings', () => {
    const empty = buildReport({
      period,
      vehicles,
      boundaryRows: [],
      alertRows: [],
      generatedAt: NOW,
    });
    assert.equal(empty.kpis.distanceKm.value, 0);
    assert.equal(empty.findings.length, 1);
    assert.equal(empty.findings[0].title, 'No activity recorded');
  });

  test('a period running to now is compared with the same elapsed time, not whole days', () => {
    const today = resolvePeriod({ preset: 'today' }, TZ, NOW); // prev = yesterday
    const rows = boundaryRowsFor('A', today.previous.from, [{ km: 200 }, { km: 30 }], {
      odometer_km: 1000,
    });
    // By this time yesterday, A had covered 25 km of yesterday's 200.
    const cutoffRows = [
      {
        vehicle_id: 'A',
        odometer_km: 1025,
        fuel_used_total: 0,
        co2_kg_total: 0,
        moving_sec_total: 0,
        idling_sec_total: 0,
        trip_count: 0,
      },
    ];
    const alerts = [
      {
        vehicle_id: 'A',
        type: 'speeding',
        severity: 'high',
        day: today.previous.from,
        dow: 3,
        hour: 4,
        before_cutoff: true,
        n: 1,
      },
      {
        vehicle_id: 'A',
        type: 'speeding',
        severity: 'high',
        day: today.previous.from,
        dow: 3,
        hour: 15,
        before_cutoff: false,
        n: 6,
      },
    ];
    const r = buildReport({
      period: today,
      vehicles: vehicles.slice(0, 1),
      boundaryRows: rows,
      alertRows: alerts,
      cutoffRows,
      generatedAt: NOW,
    });
    assert.equal(r.period.comparisonBasis, 'elapsed');
    assert.equal(r.kpis.distanceKm.value, 30);
    assert.equal(r.kpis.distanceKm.previous, 25);
    assert.equal(r.kpis.events.previous, 1); // the afternoon events had not happened yet
  });

  test('changes are withheld when telemetry does not cover the comparison period', () => {
    const r = buildReport({
      period,
      vehicles,
      boundaryRows,
      alertRows,
      historyStartsOn: '2026-11-03',
      generatedAt: NOW,
    });
    assert.equal(r.period.comparisonComplete, false);
    assert.equal(r.kpis.distanceKm.changePct, null);
    assert.equal(r.kpis.distanceKm.previous, null);
    assert.ok(!r.findings.some((f) => f.title.startsWith('Safety events')));
  });

  test('rates over very short distances are not reported', () => {
    const tiny = boundaryRowsFor('A', period.previous.from, [...Array(13).fill(null), { km: 5 }], {
      odometer_km: 10,
    });
    const r = buildReport({
      period,
      vehicles: vehicles.slice(0, 1),
      boundaryRows: tiny,
      alertRows: alertRows.slice(0, 1),
      generatedAt: NOW,
    });
    assert.equal(r.perVehicle[0].riskPer100Km, null);
    assert.equal(r.kpis.riskPer100Km.value, null);
    assert.equal(r.perVehicle[0].co2GPerKm, null);
  });
});
