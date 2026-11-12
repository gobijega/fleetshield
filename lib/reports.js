/**
 * Fleet reporting engine — period-based, comparable, exposure-normalised.
 *
 * Powers GET /api/reports/fleet (the Reports tab). Unlike the older
 * /api/reports/summary, which reads lifetime counters from the in-memory
 * simulation cache, this reads history from Postgres so any reporting
 * period can be asked for and compared with the period before it.
 *
 * How the numbers are derived
 * ---------------------------
 * Every positions row carries *cumulative* counters (odometer, fuel/energy,
 * CO2, moving seconds, idling seconds, trip count). So the activity in a
 * window is simply "counter at the end of the window minus counter at the
 * start". We read each vehicle's latest row before every local midnight in
 * the range (one index probe per vehicle per day — cheap even when the
 * positions hypertable holds millions of 2-second ticks) and difference
 * consecutive boundaries to get per-day activity. That is exact, survives
 * gaps in telemetry, and never scans raw ticks.
 *
 * Alerts are aggregated in SQL by vehicle, type, severity, local day,
 * weekday and hour, which is enough for every breakdown on the page.
 *
 * Days are local days in REPORT_TIMEZONE (default Australia/Melbourne), so
 * "Tuesday" and "07:00" mean what a fleet manager in Victoria expects.
 *
 * The SQL lives in fetchReportInputs(); everything else is pure and unit
 * tested in tests/reports.test.js.
 */

const { EMISSION_FACTORS_KG } = require('./fleet-data');

const DEFAULT_TZ = 'Australia/Melbourne';
const { ASSURANCE_TYPES } = require('./assurance');
const MAX_PERIOD_DAYS = 92;
const PRESETS = { today: 1, '7d': 7, '14d': 14, '30d': 30, '90d': 90 };
const SEVERITIES = ['high', 'medium', 'low', 'info'];
// Same weights as the live safety score in server.js, so the two agree.
const SEVERITY_WEIGHT = { high: 8, medium: 4, low: 1, info: 0 };
const FUEL_TYPES = ['diesel', 'petrol', 'ev'];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
// A vehicle counts as "active" on a day if it covered more than this.
const ACTIVE_DAY_MIN_KM = 1;

// ---------------------------------------------------------------------------
// Date helpers — local calendar dates are handled as 'YYYY-MM-DD' strings
// and stepped in UTC, which has no DST, so day arithmetic is always exact.
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(str) {
  if (typeof str !== 'string' || !DATE_RE.test(str)) return false;
  const d = new Date(`${str}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === str;
}

function addDays(str, n) {
  const d = new Date(`${str}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function diffDays(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
}

function dateRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function todayIn(tz, now = new Date()) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function reportTimeZone() {
  const tz = process.env.REPORT_TIMEZONE;
  return tz && isValidTimeZone(tz) ? tz : DEFAULT_TZ;
}

/**
 * Resolves query parameters into a reporting period plus the equal-length
 * period immediately before it. Returns { error } on bad input.
 *
 *   ?preset=today|7d|14d|30d|90d        (default 14d, ending today)
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD      (inclusive, local dates)
 */
function resolvePeriod(query = {}, tz = DEFAULT_TZ, now = new Date()) {
  const today = todayIn(tz, now);
  let from;
  let to;
  let preset = null;

  if (query.from || query.to) {
    if (!isValidDate(query.from) || !isValidDate(query.to)) {
      return { error: 'from and to must both be dates in YYYY-MM-DD format' };
    }
    from = query.from;
    to = query.to;
    if (from > to) return { error: 'from must be on or before to' };
    if (from > today) return { error: 'the period cannot start in the future' };
    if (to > today) to = today;
  } else {
    preset = query.preset || '14d';
    if (!Object.prototype.hasOwnProperty.call(PRESETS, preset)) {
      return { error: `preset must be one of: ${Object.keys(PRESETS).join(', ')}` };
    }
    to = today;
    from = addDays(today, -(PRESETS[preset] - 1));
  }

  const days = diffDays(from, to) + 1;
  if (days > MAX_PERIOD_DAYS) {
    return { error: `periods are limited to ${MAX_PERIOD_DAYS} days` };
  }

  return {
    preset,
    from,
    to,
    days,
    includesToday: to === today,
    previous: { from: addDays(from, -days), to: addDays(from, -1) },
    timeZone: tz,
  };
}

function parseFuelFilter(value) {
  if (value === undefined || value === '' || value === 'all') return { fuel: null };
  if (!FUEL_TYPES.includes(value))
    return { error: `fuel must be one of: all, ${FUEL_TYPES.join(', ')}` };
  return { fuel: value };
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/**
 * Reads everything a report needs in three queries. `vehicleIds` scopes the
 * report (the fuel filter is applied before calling this).
 */
async function fetchReportInputs(db, { orgId, vehicleIds, period }) {
  const tz = period.timeZone;
  const firstBoundary = period.previous.from;
  const lastBoundary = addDays(period.to, 1);

  // Cumulative counters at each local midnight from the start of the
  // comparison period to the end of the reporting period. The final
  // boundary is capped at now() so "today" reads up to the latest tick.
  const boundaries = vehicleIds.length
    ? await db.query(
        `SELECT v.id AS vehicle_id, b.day::text AS day,
                p.odometer_km, p.fuel_used_total, p.co2_kg_total,
                p.moving_sec_total, p.idling_sec_total, p.trip_count
           FROM unnest($2::text[]) AS v(id)
           CROSS JOIN LATERAL (
             SELECT d::date AS day, least(d::timestamp AT TIME ZONE $5, now()) AS boundary
               FROM generate_series($3::date, $4::date, interval '1 day') AS d
           ) AS b
           LEFT JOIN LATERAL (
             SELECT odometer_km, fuel_used_total, co2_kg_total,
                    moving_sec_total, idling_sec_total, trip_count
               FROM positions
              WHERE vehicle_id = v.id AND org_id = $1 AND ts < b.boundary
              ORDER BY ts DESC
              LIMIT 1
           ) AS p ON true`,
        [orgId, vehicleIds, firstBoundary, lastBoundary, tz]
      )
    : { rows: [] };

  const alerts = vehicleIds.length
    ? await db.query(
        `SELECT vehicle_id, type, severity,
                ((ts AT TIME ZONE $5)::date)::text AS day,
                extract(isodow FROM ts AT TIME ZONE $5)::int AS dow,
                extract(hour FROM ts AT TIME ZONE $5)::int AS hour,
                (ts < now() - make_interval(days => $6)) AS before_cutoff,
                count(*)::int AS n
           FROM alerts
          WHERE org_id = $1
            AND vehicle_id = ANY($2::text[])
            AND ts >= ($3::date::timestamp AT TIME ZONE $5)
            AND ts <  ($4::date::timestamp AT TIME ZONE $5)
            -- Data-assurance events (spoofing, jamming, tampering) are not
            -- driver behaviour; they live on the Assurance tab instead.
            AND NOT (type = ANY($7::text[]))
          GROUP BY 1, 2, 3, 4, 5, 6, 7`,
        [orgId, vehicleIds, firstBoundary, lastBoundary, tz, period.days, ASSURANCE_TYPES]
      )
    : { rows: [] };

  // When the period runs to "now", compare it with the same elapsed time
  // in the previous period (e.g. today until 09:40 against yesterday until
  // 09:40), not with whole days — otherwise every partial period looks
  // like a collapse. These are the counters at that cut-off.
  const cutoff =
    period.includesToday && vehicleIds.length
      ? await db.query(
          `SELECT v.id AS vehicle_id, p.odometer_km, p.fuel_used_total, p.co2_kg_total,
                  p.moving_sec_total, p.idling_sec_total, p.trip_count
             FROM unnest($2::text[]) AS v(id)
             LEFT JOIN LATERAL (
               SELECT odometer_km, fuel_used_total, co2_kg_total,
                      moving_sec_total, idling_sec_total, trip_count
                 FROM positions
                WHERE vehicle_id = v.id AND org_id = $1
                  AND ts < now() - make_interval(days => $3)
                ORDER BY ts DESC
                LIMIT 1
             ) AS p ON true`,
          [orgId, vehicleIds, period.days]
        )
      : null;

  const coverage = await db.query(
    `SELECT ((min(ts) AT TIME ZONE $2)::date)::text AS first_day FROM positions WHERE org_id = $1`,
    [orgId, tz]
  );

  return {
    boundaryRows: boundaries.rows,
    alertRows: alerts.rows,
    cutoffRows: cutoff ? cutoff.rows : null,
    historyStartsOn: coverage.rows[0] ? coverage.rows[0].first_day : null,
  };
}

// ---------------------------------------------------------------------------
// Pure computation
// ---------------------------------------------------------------------------

const round = (n, dp = 1) => {
  const f = 10 ** dp;
  return Math.round((Number(n) || 0) * f) / f;
};

const METRIC_KEYS = ['km', 'fuel', 'co2Kg', 'movingSec', 'idleSec', 'trips'];
const zeroMetrics = () => ({ km: 0, fuel: 0, co2Kg: 0, movingSec: 0, idleSec: 0, trips: 0 });
const zeroSeverities = () => ({ high: 0, medium: 0, low: 0, info: 0 });

function cumulativeFrom(row) {
  if (!row || row.odometer_km === null || row.odometer_km === undefined) return null;
  return {
    km: Number(row.odometer_km),
    fuel: Number(row.fuel_used_total),
    co2Kg: Number(row.co2_kg_total),
    movingSec: Number(row.moving_sec_total),
    idleSec: Number(row.idling_sec_total),
    trips: Number(row.trip_count) || 0,
  };
}

/** Per-vehicle, per-local-day activity, by differencing midnight counters. */
function dailyActivity(boundaryRows, vehicleIds, firstDay, lastDay) {
  const byVehicle = new Map(vehicleIds.map((id) => [id, new Map()]));
  for (const row of boundaryRows) {
    const m = byVehicle.get(row.vehicle_id);
    if (m) m.set(row.day, cumulativeFrom(row));
  }

  const out = new Map();
  for (const id of vehicleIds) {
    const counters = byVehicle.get(id);
    const days = new Map();
    for (const day of dateRange(firstDay, lastDay)) {
      const start = counters.get(day) || null;
      const end = counters.get(addDays(day, 1)) || null;
      const metrics = zeroMetrics();
      if (end) {
        // No reading before this day's start means the vehicle had no
        // history yet; its counters start from zero.
        for (const k of METRIC_KEYS) {
          // Clamp at zero: a counter that goes backwards (a re-seeded
          // vehicle, an odometer replaced) is not negative activity.
          metrics[k] = Math.max(0, end[k] - (start ? start[k] : 0));
        }
      }
      days.set(day, metrics);
    }
    out.set(id, days);
  }
  return out;
}

function sumMetrics(list) {
  const total = zeroMetrics();
  for (const m of list) for (const k of METRIC_KEYS) total[k] += m[k];
  return total;
}

function pctChange(current, previous) {
  if (!previous) return current ? null : 0; // null = "new", not computable
  return round(((current - previous) / previous) * 100, 1);
}

// Below six minutes of engine-on time a utilisation percentage says
// nothing (a vehicle that ran for 8 seconds reads as "100%").
const UTILISATION_MIN_SEC = 360;

function utilisation(m) {
  const engineOn = m.movingSec + m.idleSec;
  return engineOn >= UTILISATION_MIN_SEC ? (m.movingSec / engineOn) * 100 : null;
}

function riskPoints(sev) {
  return SEVERITIES.reduce((s, k) => s + sev[k] * SEVERITY_WEIGHT[k], 0);
}

// Below this distance a per-100-km rate swings wildly (a single event over
// 5 km reads as 160 per 100 km), so it is reported as not available.
const RATE_MIN_KM = 20;

function per100Km(value, km) {
  return km >= RATE_MIN_KM ? (value / km) * 100 : null;
}

function formatDuration(hours) {
  return hours >= 10 ? `${Math.round(hours)} h` : `${round(hours, 1)} h`;
}

/**
 * Builds the full report object from raw inputs.
 *
 * vehicles: [{ id, label, driver, fuelType, idleRatePerHour }]
 */
function buildReport({
  period,
  vehicles,
  boundaryRows,
  alertRows,
  cutoffRows = null,
  historyStartsOn = null,
  fuel = null,
  generatedAt = new Date(),
}) {
  const vehicleIds = vehicles.map((v) => v.id);
  const periodDays = dateRange(period.from, period.to);
  const prevDays = dateRange(period.previous.from, period.previous.to);
  const activity = dailyActivity(boundaryRows, vehicleIds, period.previous.from, period.to);
  const inPeriod = (day) => day >= period.from && day <= period.to;
  const toElapsedTime = Boolean(cutoffRows);
  // Period-on-period change is only meaningful when telemetry covers the
  // whole comparison period.
  const comparisonComplete = !historyStartsOn || historyStartsOn <= period.previous.from;

  // Previous-period activity per vehicle: whole days, or — when the period
  // runs to now — counters from the start of the previous period up to the
  // same elapsed time.
  const prevByVehicle = new Map();
  if (toElapsedTime) {
    const cutoff = new Map(cutoffRows.map((r) => [r.vehicle_id, cumulativeFrom(r)]));
    const startRows = new Map(
      boundaryRows
        .filter((r) => r.day === period.previous.from)
        .map((r) => [r.vehicle_id, cumulativeFrom(r)])
    );
    for (const id of vehicleIds) {
      const end = cutoff.get(id);
      const start = startRows.get(id);
      const m = zeroMetrics();
      if (end) for (const k of METRIC_KEYS) m[k] = Math.max(0, end[k] - (start ? start[k] : 0));
      prevByVehicle.set(id, m);
    }
  } else {
    for (const id of vehicleIds)
      prevByVehicle.set(id, sumMetrics(prevDays.map((d) => activity.get(id).get(d))));
  }

  // --- alerts --------------------------------------------------------------
  const alertsByVehicle = new Map(
    vehicleIds.map((id) => [id, { cur: zeroSeverities(), prev: zeroSeverities(), byType: {} }])
  );
  const dailyAlerts = new Map(periodDays.map((d) => [d, zeroSeverities()]));
  const byType = {};
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
  const prevFleetSev = zeroSeverities();

  for (const r of alertRows) {
    const bucket = alertsByVehicle.get(r.vehicle_id);
    if (!bucket || !SEVERITIES.includes(r.severity)) continue;
    const n = Number(r.n) || 0;
    if (inPeriod(r.day)) {
      bucket.cur[r.severity] += n;
      bucket.byType[r.type] = (bucket.byType[r.type] || 0) + n;
      dailyAlerts.get(r.day)[r.severity] += n;
      if (!byType[r.type]) byType[r.type] = zeroSeverities();
      byType[r.type][r.severity] += n;
      if (r.severity !== 'info') heat[(r.dow - 1 + 7) % 7][r.hour] += n;
    } else if (!toElapsedTime || r.before_cutoff !== false) {
      bucket.prev[r.severity] += n;
      prevFleetSev[r.severity] += n;
    }
  }

  // --- per vehicle ---------------------------------------------------------
  const perVehicle = vehicles.map((v) => {
    const days = activity.get(v.id);
    const cur = sumMetrics(periodDays.map((d) => days.get(d)));
    const prev = prevByVehicle.get(v.id);
    const sev = alertsByVehicle.get(v.id).cur;
    const prevSev = alertsByVehicle.get(v.id).prev;
    const idleHours = cur.idleSec / 3600;
    const idleFuel = idleHours * (Number(v.idleRatePerHour) || 0);
    const events = sev.high + sev.medium + sev.low;
    const risk = per100Km(riskPoints(sev), cur.km);
    return {
      id: v.id,
      label: v.label,
      driver: v.driver || null,
      fuelType: v.fuelType,
      unit: v.fuelType === 'ev' ? 'kWh' : 'L',
      activeDays: periodDays.filter((d) => days.get(d).km > ACTIVE_DAY_MIN_KM).length,
      distanceKm: round(cur.km),
      fuelUsed: round(cur.fuel),
      co2Kg: round(cur.co2Kg),
      co2GPerKm: cur.km >= RATE_MIN_KM ? Math.round((cur.co2Kg / cur.km) * 1000) : null,
      movingHours: round(cur.movingSec / 3600),
      idleHours: round(idleHours),
      utilisationPct: utilisation(cur) === null ? null : round(utilisation(cur)),
      idlePct: round(
        cur.movingSec + cur.idleSec ? (cur.idleSec / (cur.movingSec + cur.idleSec)) * 100 : 0
      ),
      idleFuel: round(idleFuel),
      idleCo2Kg: round(idleFuel * (EMISSION_FACTORS_KG[v.fuelType] || 0)),
      trips: Math.round(cur.trips),
      events,
      alerts: sev,
      alertsByType: alertsByVehicle.get(v.id).byType,
      riskPer100Km: risk === null ? null : round(risk, 2),
      previous: {
        distanceKm: round(prev.km),
        co2Kg: round(prev.co2Kg),
        events: prevSev.high + prevSev.medium + prevSev.low,
      },
      daily: periodDays.map((d) => {
        const m = days.get(d);
        return {
          day: d,
          km: round(m.km),
          co2Kg: round(m.co2Kg),
          movingHours: round(m.movingSec / 3600, 2),
          idleHours: round(m.idleSec / 3600, 2),
        };
      }),
    };
  });

  // --- fleet totals --------------------------------------------------------
  const fleetDay = (d) => sumMetrics(vehicleIds.map((id) => activity.get(id).get(d)));
  const fleetDaily = periodDays.map((d) => ({ day: d, ...fleetDay(d) }));
  const cur = sumMetrics(fleetDaily);
  const prev = sumMetrics(vehicleIds.map((id) => prevByVehicle.get(id)));

  // Per-vehicle metric maps for the current and previous periods.
  const curByVehicle = new Map(
    vehicleIds.map((id) => [id, sumMetrics(periodDays.map((d) => activity.get(id).get(d)))])
  );
  const isEv = (v) => v.fuelType === 'ev';
  const fuelSplit = (byVehicle, ev) =>
    vehicles.filter((v) => isEv(v) === ev).reduce((s, v) => s + byVehicle.get(v.id).fuel, 0);
  const idleFuelL = (byVehicle) =>
    vehicles
      .filter((v) => !isEv(v))
      .reduce(
        (s, v) => s + (byVehicle.get(v.id).idleSec / 3600) * (Number(v.idleRatePerHour) || 0),
        0
      );
  const activeVehicles = (byVehicle) =>
    vehicleIds.filter((id) => byVehicle.get(id).km > ACTIVE_DAY_MIN_KM).length;

  const curSev = SEVERITIES.reduce(
    (acc, k) => ({ ...acc, [k]: perVehicle.reduce((s, v) => s + v.alerts[k], 0) }),
    {}
  );
  const curEvents = curSev.high + curSev.medium + curSev.low;
  const prevEvents = prevFleetSev.high + prevFleetSev.medium + prevFleetSev.low;
  const curRisk = per100Km(riskPoints(curSev), cur.km);
  const prevRisk = per100Km(riskPoints(prevFleetSev), prev.km);

  // Each KPI says which direction is good, so the UI can colour the change
  // honestly (more distance is neutral; more CO2 is not).
  const kpi = (value, previous, better, dp = 1) => ({
    value: value === null ? null : round(value, dp),
    previous: previous === null || !comparisonComplete ? null : round(previous, dp),
    changePct:
      value === null || previous === null || !comparisonComplete
        ? null
        : pctChange(value, previous),
    better,
  });

  const kpis = {
    distanceKm: kpi(cur.km, prev.km, 'neutral', 0),
    co2Kg: kpi(cur.co2Kg, prev.co2Kg, 'down', 0),
    co2GPerKm: kpi(
      cur.km >= RATE_MIN_KM ? (cur.co2Kg / cur.km) * 1000 : null,
      prev.km >= RATE_MIN_KM ? (prev.co2Kg / prev.km) * 1000 : null,
      'down',
      0
    ),
    fuelL: kpi(fuelSplit(curByVehicle, false), fuelSplit(prevByVehicle, false), 'down', 0),
    energyKwh: kpi(fuelSplit(curByVehicle, true), fuelSplit(prevByVehicle, true), 'down', 0),
    utilisationPct: kpi(utilisation(cur), utilisation(prev), 'up', 1),
    idleHours: kpi(cur.idleSec / 3600, prev.idleSec / 3600, 'down', 1),
    idleFuelL: kpi(idleFuelL(curByVehicle), idleFuelL(prevByVehicle), 'down', 0),
    events: kpi(curEvents, prevEvents, 'down', 0),
    highSeverity: kpi(curSev.high, prevFleetSev.high, 'down', 0),
    riskPer100Km: kpi(curRisk, prevRisk, 'down', 2),
    activeVehicles: kpi(activeVehicles(curByVehicle), activeVehicles(prevByVehicle), 'up', 0),
  };

  // --- breakdowns ----------------------------------------------------------
  const byFuelType = FUEL_TYPES.map((ft) => {
    const vs = perVehicle.filter((v) => v.fuelType === ft);
    return {
      fuelType: ft,
      unit: ft === 'ev' ? 'kWh' : 'L',
      vehicles: vs.length,
      distanceKm: round(vs.reduce((s, v) => s + v.distanceKm, 0)),
      fuelUsed: round(vs.reduce((s, v) => s + v.fuelUsed, 0)),
      co2Kg: round(vs.reduce((s, v) => s + v.co2Kg, 0)),
    };
  }).filter((f) => f.vehicles > 0);

  const alertTypes = Object.entries(byType)
    .map(([type, sev]) => ({ type, ...sev, total: sev.high + sev.medium + sev.low + sev.info }))
    .sort((a, b) => riskPoints(b) - riskPoints(a) || b.total - a.total);

  const series = fleetDaily.map((d) => ({
    day: d.day,
    distanceKm: round(d.km),
    co2Kg: round(d.co2Kg),
    movingHours: round(d.movingSec / 3600, 2),
    idleHours: round(d.idleSec / 3600, 2),
    utilisationPct: utilisation(d) === null ? null : round(utilisation(d)),
    activeVehicles: vehicleIds.filter((id) => activity.get(id).get(d.day).km > ACTIVE_DAY_MIN_KM)
      .length,
    alerts: dailyAlerts.get(d.day),
  }));

  const report = {
    generatedAt: generatedAt.toISOString(),
    period: {
      ...period,
      previous: { ...period.previous },
      // 'elapsed': compared up to the same time of day; 'days': whole days.
      comparisonBasis: toElapsedTime ? 'elapsed' : 'days',
      comparisonComplete,
    },
    scope: { fuel, vehicles: vehicles.length },
    historyStartsOn,
    kpis,
    series,
    alertTypes,
    alertHeatmap: { weekdays: WEEKDAYS, cells: heat },
    byFuelType,
    perVehicle,
    methodology: {
      emissionFactorsKg: EMISSION_FACTORS_KG,
      severityWeights: SEVERITY_WEIGHT,
      activeDayMinKm: ACTIVE_DAY_MIN_KM,
      rateMinKm: RATE_MIN_KM,
    },
  };
  report.findings = buildFindings(report);
  return report;
}

// ---------------------------------------------------------------------------
// Findings — short, factual statements generated from the numbers. Each
// rule only fires when the data supports it; no rule invents a cause.
// ---------------------------------------------------------------------------

const humanType = (t) => t.replace(/_/g, ' ');
const pct = (n) => `${Math.round(n)}%`;
const fmt = (n) => Math.round(n).toLocaleString('en-AU');

function buildFindings(report) {
  const findings = [];
  const vs = report.perVehicle;
  const { kpis, period } = report;
  const totalCo2 = vs.reduce((s, v) => s + v.co2Kg, 0);
  const totalKm = vs.reduce((s, v) => s + v.distanceKm, 0);

  if (!vs.length || totalKm < 1) {
    findings.push({
      kind: 'info',
      title: 'No activity recorded',
      text: 'No vehicle movement was recorded in this period, so there is nothing to analyse yet.',
    });
    return findings;
  }

  // Emissions concentration: do a few vehicles account for most CO2?
  if (vs.length >= 4 && totalCo2 > 0) {
    const n = Math.max(1, Math.round(vs.length * 0.2));
    const top = [...vs].sort((a, b) => b.co2Kg - a.co2Kg).slice(0, n);
    const share = (top.reduce((s, v) => s + v.co2Kg, 0) / totalCo2) * 100;
    const fleetShare = (n / vs.length) * 100;
    if (share >= fleetShare * 1.4) {
      findings.push({
        kind: 'notice',
        title: 'Emissions are concentrated',
        text: `${top.map((v) => v.label).join(' and ')} produced ${pct(share)} of fleet CO2 from ${pct(fleetShare)} of vehicles. They are the first candidates for route review or electrification.`,
        vehicleIds: top.map((v) => v.id),
      });
    }
  }

  // Idling cost.
  const idleFuel = kpis.idleFuelL.value || 0;
  const iceFuel = kpis.fuelL.value || 0;
  if (idleFuel >= 1 && iceFuel > 0) {
    const worst = [...vs]
      .filter((v) => v.fuelType !== 'ev' && v.idleHours > 0)
      .sort((a, b) => b.idlePct - a.idlePct)[0];
    const idleCo2 = vs.reduce((s, v) => s + (v.fuelType !== 'ev' ? v.idleCo2Kg : 0), 0);
    findings.push({
      kind: idleFuel / iceFuel >= 0.08 ? 'notice' : 'info',
      title: 'Idling',
      text: `Engines idled for ${formatDuration(kpis.idleHours.value)}, burning about ${fmt(idleFuel)} L of fuel (${pct((idleFuel / iceFuel) * 100)} of all fuel, ~${fmt(idleCo2)} kg CO2).${worst ? ` Highest idle share: ${worst.label}, at ${pct(worst.idlePct)} of engine-on time.` : ''}`,
      vehicleIds: worst ? [worst.id] : [],
    });
  }

  // Driver risk outlier, normalised for distance.
  const fleetRisk = kpis.riskPer100Km.value;
  if (fleetRisk && vs.length >= 3) {
    const ranked = vs
      .filter((v) => v.riskPer100Km !== null && v.distanceKm >= 20)
      .sort((a, b) => b.riskPer100Km - a.riskPer100Km);
    const worst = ranked[0];
    if (worst && worst.riskPer100Km >= fleetRisk * 1.5) {
      const topTypes = Object.entries(worst.alertsByType)
        .filter(([t]) => !t.startsWith('geofence'))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([t, n]) => `${n} ${humanType(t)}`);
      findings.push({
        kind: 'notice',
        title: 'Driving-risk outlier',
        text: `${worst.label}${worst.driver ? ` (${worst.driver})` : ''} recorded ${round(worst.riskPer100Km / fleetRisk, 1)}× the fleet's weighted event rate per 100 km${topTypes.length ? `, led by ${topTypes.join(' and ')}` : ''}. Worth a coaching conversation.`,
        vehicleIds: [worst.id],
      });
    }
  }

  // Period-on-period change in safety events.
  const ev = kpis.events;
  if (
    ev.previous !== null &&
    ev.previous >= 5 &&
    ev.changePct !== null &&
    Math.abs(ev.changePct) >= 15
  ) {
    const up = ev.changePct > 0;
    findings.push({
      kind: up ? 'notice' : 'positive',
      title: up ? 'Safety events up' : 'Safety events down',
      text: `${fmt(ev.value)} safety events against ${fmt(ev.previous)} in the previous ${period.days}-day period (${up ? '+' : ''}${Math.round(ev.changePct)}%)${kpis.riskPer100Km.changePct !== null ? `; per 100 km the rate moved ${kpis.riskPer100Km.changePct > 0 ? '+' : ''}${Math.round(kpis.riskPer100Km.changePct)}%` : ''}.`,
    });
  }

  // When do events happen? Look for a three-hour window of the day that
  // holds a clearly disproportionate share of events (an even spread over
  // a 12-hour working day would put 25% in any three hours).
  const byHour = Array(24).fill(0);
  report.alertHeatmap.cells.forEach((row) => row.forEach((n, h) => (byHour[h] += n)));
  const totalHeat = byHour.reduce((s, n) => s + n, 0);
  if (totalHeat >= 20) {
    let best = { start: 0, n: -1 };
    for (let h = 0; h < 24; h++) {
      const n = byHour[h] + byHour[(h + 1) % 24] + byHour[(h + 2) % 24];
      if (n > best.n) best = { start: h, n };
    }
    const share = best.n / totalHeat;
    if (share >= 0.4) {
      const hh = (h) => `${String(h % 24).padStart(2, '0')}:00`;
      findings.push({
        kind: 'info',
        title: 'Peak event window',
        text: `${pct(share * 100)} of safety events happen between ${hh(best.start)} and ${hh(best.start + 3)} (${best.n} of ${totalHeat}). Supervision and coaching effort can target that window.`,
      });
    }
  }

  // Under-used assets.
  if (period.days >= 7) {
    const idle = vs.filter((v) => v.activeDays / period.days <= 0.3);
    if (idle.length) {
      findings.push({
        kind: 'notice',
        title: 'Under-used vehicles',
        text: `${idle.map((v) => `${v.label} (${v.activeDays} of ${period.days} days)`).join(', ')} ${idle.length === 1 ? 'was' : 'were'} rarely on the road. Consider redeployment, pooling or disposal review.`,
        vehicleIds: idle.map((v) => v.id),
      });
    }
  }

  return findings;
}

module.exports = {
  DEFAULT_TZ,
  MAX_PERIOD_DAYS,
  PRESETS,
  FUEL_TYPES,
  resolvePeriod,
  parseFuelFilter,
  reportTimeZone,
  isValidTimeZone,
  todayIn,
  addDays,
  dateRange,
  fetchReportInputs,
  dailyActivity,
  buildReport,
  buildFindings,
};
