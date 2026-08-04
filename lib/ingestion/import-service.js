/**
 * CSV import orchestration — PROTOTYPE.
 *
 * Wires together csv-adapter.js (parse + validate) and cumulative.js
 * (running-total computation) into a single org-scoped import operation,
 * without doing any I/O itself — the caller (server.js's
 * POST /api/telemetry/import/csv route) injects the DB reads/writes, so
 * this module can be unit-tested with in-memory fakes and no live
 * Postgres instance.
 *
 * Rejection/rollback behaviour:
 *   - if the file itself is invalid (too large, unparseable, missing
 *     required columns), nothing is imported and no database write is
 *     attempted;
 *   - individual invalid rows (bad vehicle ID, bad timestamp, etc.) are
 *     excluded from the import and reported back, but do not block valid
 *     rows in the same file from importing;
 *   - the actual database write is a single INSERT statement covering all
 *     valid rows (see writePositions/persistPositions in server.js), so it
 *     is atomic at the statement level: either every valid row is written
 *     or, if the statement fails, none are.
 *
 * Known limitation (not implemented): this module does not check imported
 * rows against telemetry already stored in Postgres for duplicates — only
 * duplicates within the same uploaded file are caught (see
 * csv-adapter.js). Cross-import duplicate detection is listed as planned
 * work in docs/founder-decisions-required.md-adjacent engineering notes
 * below and should be added before this prototype is used for repeated,
 * ongoing imports against the same vehicles.
 */

'use strict';

const csvAdapter = require('./csv-adapter');
const { computeCumulativeSeries } = require('./cumulative');
const { LIMITS } = require('./adapter-types');
const { buildValidationReport } = require('./validation-report');

/**
 * @param {object} params
 * @param {string} params.csvText - raw CSV file content.
 * @param {string} params.orgId
 * @param {object[]} params.vehicles - vehicles registered to this org, each
 *   { id, fuelType, consumptionPer100, idleRatePerHour }.
 * @param {(vehicleId: string) => Promise<object|null>} params.getLatestPosition
 *   - returns the vehicle's latest known position/totals row (DB shape,
 *   snake_case) or null if the vehicle has no history yet.
 * @param {(orgId: string, rows: object[]) => Promise<void>} params.writePositions
 *   - persists the computed rows; expected to perform this as a single
 *   atomic write (see server.js's persistPositions).
 * @param {string} [params.sourceSystem]
 * @returns {Promise<{
 *   accepted: boolean,
 *   fileErrors: string[],
 *   summary: { totalRows: number, validRows: number, invalidRows: number, vehiclesImported: number },
 *   invalidRows: { row: number, vehicleId: string|null, errors: string[] }[],
 *   warnings: string[],
 * }>}
 */
async function runCsvImport({ csvText, orgId, vehicles, getLatestPosition, writePositions, sourceSystem }) {
  const startedAtMs = Date.now();
  const orgVehicleIds = new Set((vehicles || []).map((v) => v.id));
  const vehicleById = new Map((vehicles || []).map((v) => [v.id, v]));

  const { records, fileErrors, summary } = csvAdapter.parse(
    { text: csvText, sourceSystem: sourceSystem || 'csv-upload' },
    { orgVehicleIds, orgId }
  );

  const fatal = fileErrors.some((e) => /^(File exceeds|File is empty|File contains no rows|File could not be parsed|Missing required column)/.test(e));
  if (fatal || records.length === 0) {
    return {
      accepted: false,
      fileErrors,
      summary: { ...summary, vehiclesImported: 0 },
      invalidRows: [],
      warnings: [],
      validationReport: buildValidationReport(records, startedAtMs, Date.now()),
    };
  }

  const validByVehicle = new Map();
  const invalidRows = [];
  records.forEach((r, i) => {
    if (r.validationStatus === 'valid') {
      if (!validByVehicle.has(r.vehicleId)) validByVehicle.set(r.vehicleId, []);
      validByVehicle.get(r.vehicleId).push(r);
    } else {
      invalidRows.push({ row: i + 2, vehicleId: r.vehicleId, errors: r.importErrors });
    }
  });

  if (validByVehicle.size > LIMITS.MAX_VEHICLES_PER_IMPORT) {
    return {
      accepted: false,
      fileErrors: [`File references ${validByVehicle.size} distinct vehicles, exceeding the limit of ${LIMITS.MAX_VEHICLES_PER_IMPORT} per import.`],
      summary: { ...summary, vehiclesImported: 0 },
      invalidRows,
      warnings: [],
      validationReport: buildValidationReport(records, startedAtMs, Date.now()),
    };
  }

  const allWarnings = [];
  const allRows = [];

  for (const [vehicleId, obsList] of validByVehicle.entries()) {
    const vehicle = vehicleById.get(vehicleId);
    if (!vehicle) continue; // defensive; csv-adapter already rejects unknown vehicle IDs
    const latest = await getLatestPosition(vehicleId);
    const startingTotals = latest
      ? {
          tsIso: latest.ts instanceof Date ? latest.ts.toISOString() : latest.ts,
          lat: latest.lat !== null ? Number(latest.lat) : null,
          lng: latest.lng !== null ? Number(latest.lng) : null,
          odometerKm: latest.odometer_km,
          fuelUsedTotal: latest.fuel_used_total,
          co2KgTotal: latest.co2_kg_total,
          movingSec: latest.moving_sec_total,
          idlingSec: latest.idling_sec_total,
          tripCount: latest.trip_count,
          lastStatus: latest.status,
        }
      : null;

    const { rows, warnings } = computeCumulativeSeries(vehicle, obsList, startingTotals);
    allWarnings.push(...warnings);
    allRows.push(...rows);
  }

  if (allRows.length > 0) {
    await writePositions(orgId, allRows);
  }

  const finishedAtMs = Date.now();
  return {
    accepted: true,
    fileErrors,
    summary: { ...summary, vehiclesImported: validByVehicle.size },
    invalidRows,
    warnings: allWarnings,
    validationReport: buildValidationReport(records, startedAtMs, finishedAtMs),
  };
}

module.exports = { runCsvImport };
