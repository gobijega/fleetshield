/**
 * Secure CSV ingestion adapter — PROTOTYPE.
 *
 * Turns a CSV document (already read into memory as a string, with a
 * caller-enforced byte-size cap — see server.js's import route) into an
 * array of NormalizedObservation records (see adapter-types.js), plus a
 * per-row validation report.
 *
 * This is a prototype, not a certified integration: it has been exercised
 * only against the fictional test fixture in tests/fixtures/, using the
 * existing fictional vehicle IDs already seeded in this codebase (see
 * lib/fleet-data.js SEED_VEHICLES). It has not ingested data from a real
 * vehicle, device, or fleet operator, and must not be described publicly as
 * a validated integration (see jegasec-site/src/lib/integrations.ts).
 *
 * Security properties this module is responsible for:
 *   - never executes/evaluates cell content (plain string parsing only);
 *   - defends against spreadsheet "CSV injection" by neutralising any
 *     free-text field that starts with a formula-trigger character
 *     (=, +, -, @, tab, CR) before it is stored or could be re-exported and
 *     opened in spreadsheet software;
 *   - strips CR/LF from every field so no cell can inject extra rows/log
 *     lines;
 *   - enforces file-size, row-count, and per-field length limits;
 *   - rejects (does not silently coerce) malformed rows, duplicate rows,
 *     and rows referencing a vehicle the importing org doesn't own;
 *   - never touches the filesystem — input is a string already in memory,
 *     so there is no path-traversal surface in this module.
 */

'use strict';

const { LIMITS } = require('./adapter-types');

const REQUIRED_COLUMNS = ['vehicle_id', 'timestamp', 'lat', 'lng'];
const OPTIONAL_COLUMNS = ['speed_kmh', 'ignition', 'odometer_km', 'driver_id', 'source_ref'];
const KNOWN_COLUMNS = new Set([...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS]);

// Documented CSV schema (also reproduced in docs/pilot-readiness/telemetry-data-requirements.md):
//
//   vehicle_id   required  must match an existing Fleet Shield vehicle ID for the org
//   timestamp    required  ISO 8601, e.g. 2026-06-01T08:15:00Z
//   lat          required  decimal degrees, -90..90
//   lng          required  decimal degrees, -180..180
//   speed_kmh    optional  non-negative number, 0..300
//   ignition     optional  true/false/on/off/1/0/yes/no
//   odometer_km  optional  non-negative number, monotonically increasing per vehicle
//   driver_id    optional  free text, <=500 chars
//   source_ref   optional  free text, <=500 chars (e.g. a source-system row ID)

const TIMESTAMP_MIN = Date.parse('2015-01-01T00:00:00Z');
// Reject timestamps further than this into the future relative to import
// time — a generous skew that tolerates clock drift without accepting
// obviously-wrong data (e.g. a spreadsheet date-parsing error landing on a
// year 3000+ value).
const TIMESTAMP_MAX_SKEW_MS = 24 * 60 * 60 * 1000;

const FORMULA_TRIGGER_CHARS = new Set(['=', '+', '-', '@', '\t', '\r']);

function sanitiseFreeText(value) {
  if (value === null || value === undefined) return null;
  let v = String(value).replace(/[\r\n]+/g, ' ').trim();
  if (v.length === 0) return null;
  if (FORMULA_TRIGGER_CHARS.has(v[0])) {
    // Defence-in-depth against CSV/"formula" injection if this value is
    // ever re-exported and opened in spreadsheet software — neutralise
    // rather than reject, since these are legitimate characters in some
    // free-text values (e.g. a source ref like "-1042").
    v = `'${v}`;
  }
  return v;
}

/**
 * Minimal, dependency-free RFC4180-style CSV tokenizer. Hand-rolled
 * deliberately (rather than pulling in a third-party parsing library) so
 * the full set of parsing rules is auditable in one place and there is no
 * risk of an upstream parser silently supporting a dangerous feature (e.g.
 * formula evaluation, external entity expansion) this codebase doesn't
 * need. Supports quoted fields, escaped quotes ("" -> "), and CRLF/LF line
 * endings. Never executes anything — output is plain strings.
 */
function tokenizeCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (c === '\r') {
      i += 1;
      continue; // normalised away; \n (bare or following \r) ends the row
    }
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }

  // Final field/row if the file doesn't end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Drop wholly-empty trailing rows (common with a trailing blank line).
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function validateHeader(headerRow) {
  const errors = [];
  const normalised = headerRow.map((h) => String(h || '').trim().toLowerCase());
  const seen = new Set();
  for (const col of normalised) {
    if (seen.has(col)) errors.push(`Duplicate column header: "${col}"`);
    seen.add(col);
    if (col && !KNOWN_COLUMNS.has(col)) {
      errors.push(`Unknown column header: "${col}" (will be ignored)`);
    }
  }
  for (const required of REQUIRED_COLUMNS) {
    if (!normalised.includes(required)) errors.push(`Missing required column: "${required}"`);
  }
  return { normalised, errors };
}

function parseNumber(raw, { min, max }) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { value: null, error: null };
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) return { value: null, error: 'not a number' };
  if (min !== undefined && n < min) return { value: null, error: `below minimum (${min})` };
  if (max !== undefined && n > max) return { value: null, error: `above maximum (${max})` };
  return { value: n, error: null };
}

function parseIgnition(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { value: null, error: null };
  const v = String(raw).trim().toLowerCase();
  if (['true', 'on', '1', 'yes'].includes(v)) return { value: true, error: null };
  if (['false', 'off', '0', 'no'].includes(v)) return { value: false, error: null };
  return { value: null, error: `unrecognised ignition value "${raw}"` };
}

function parseTimestamp(raw) {
  if (!raw || String(raw).trim() === '') return { value: null, error: 'timestamp is required' };
  const ms = Date.parse(String(raw).trim());
  if (Number.isNaN(ms)) return { value: null, error: `unparseable timestamp "${raw}" (expected ISO 8601)` };
  if (ms < TIMESTAMP_MIN) return { value: null, error: 'timestamp is implausibly old (before 2015)' };
  if (ms > Date.now() + TIMESTAMP_MAX_SKEW_MS) return { value: null, error: 'timestamp is in the future' };
  return { value: new Date(ms).toISOString(), error: null };
}

/**
 * Parses and validates CSV text into NormalizedObservation records.
 *
 * @param {{ text: string, sourceSystem?: string }} rawInput
 * @param {{ orgVehicleIds: Set<string> }} context — vehicle IDs the
 *   importing org actually owns; rows referencing any other ID are
 *   rejected so one org can never inject telemetry against another org's
 *   (or a nonexistent) vehicle.
 * @returns {{ records: object[], fileErrors: string[], summary: object }}
 */
function parse(rawInput, context) {
  const text = rawInput && typeof rawInput.text === 'string' ? rawInput.text : '';
  const sourceSystem = (rawInput && rawInput.sourceSystem) || 'csv-upload';
  const orgVehicleIds = (context && context.orgVehicleIds) || new Set();

  const fileErrors = [];

  if (Buffer.byteLength(text, 'utf8') > LIMITS.MAX_FILE_BYTES) {
    fileErrors.push(`File exceeds the maximum allowed size of ${LIMITS.MAX_FILE_BYTES} bytes.`);
    return { records: [], fileErrors, summary: { totalRows: 0, validRows: 0, invalidRows: 0 } };
  }
  if (text.trim().length === 0) {
    fileErrors.push('File is empty.');
    return { records: [], fileErrors, summary: { totalRows: 0, validRows: 0, invalidRows: 0 } };
  }

  let rows;
  try {
    rows = tokenizeCsv(text);
  } catch (err) {
    fileErrors.push(`File could not be parsed as CSV: ${err.message}`);
    return { records: [], fileErrors, summary: { totalRows: 0, validRows: 0, invalidRows: 0 } };
  }

  if (rows.length === 0) {
    fileErrors.push('File contains no rows.');
    return { records: [], fileErrors, summary: { totalRows: 0, validRows: 0, invalidRows: 0 } };
  }

  const headerRow = rows[0];
  const dataRows = rows.slice(1);

  if (dataRows.length > LIMITS.MAX_ROWS) {
    fileErrors.push(`File has ${dataRows.length} data rows, exceeding the limit of ${LIMITS.MAX_ROWS}.`);
    return { records: [], fileErrors, summary: { totalRows: dataRows.length, validRows: 0, invalidRows: 0 } };
  }

  const { normalised: columns, errors: headerErrors } = validateHeader(headerRow);
  const missingRequired = headerErrors.some((e) => e.startsWith('Missing required column'));
  if (missingRequired) {
    fileErrors.push(...headerErrors);
    return { records: [], fileErrors, summary: { totalRows: dataRows.length, validRows: 0, invalidRows: 0 } };
  }
  // Non-fatal header issues (unknown/duplicate columns) are surfaced but
  // don't block the import.
  fileErrors.push(...headerErrors);

  const colIndex = {};
  columns.forEach((c, idx) => {
    if (KNOWN_COLUMNS.has(c) && !(c in colIndex)) colIndex[c] = idx;
  });

  const seenKeys = new Set();
  const records = [];

  dataRows.forEach((cells, i) => {
    const rowNum = i + 2; // 1-indexed, +1 for header row
    const errors = [];

    if (cells.length !== headerRow.length) {
      errors.push(`Row has ${cells.length} fields, expected ${headerRow.length} (malformed delimiters or quoting).`);
    }
    const get = (col) => (col in colIndex ? cells[colIndex[col]] : undefined);

    for (const col of KNOWN_COLUMNS) {
      const v = get(col);
      if (v !== undefined && String(v).length > LIMITS.MAX_FIELD_LENGTH) {
        errors.push(`Field "${col}" exceeds ${LIMITS.MAX_FIELD_LENGTH} characters.`);
      }
    }

    const vehicleIdRaw = (get('vehicle_id') || '').toString().trim();
    if (!vehicleIdRaw) {
      errors.push('vehicle_id is required.');
    } else if (!orgVehicleIds.has(vehicleIdRaw)) {
      errors.push(`Unknown vehicle identifier "${vehicleIdRaw}" (not registered to this organisation).`);
    }

    const ts = parseTimestamp(get('timestamp'));
    if (ts.error) errors.push(`timestamp: ${ts.error}`);

    const lat = parseNumber(get('lat'), { min: -90, max: 90 });
    if (lat.error || get('lat') === undefined || String(get('lat') || '').trim() === '') {
      errors.push(`lat: ${lat.error || 'lat is required'}`);
    }
    const lng = parseNumber(get('lng'), { min: -180, max: 180 });
    if (lng.error || get('lng') === undefined || String(get('lng') || '').trim() === '') {
      errors.push(`lng: ${lng.error || 'lng is required'}`);
    }

    const speed = parseNumber(get('speed_kmh'), { min: 0, max: 300 });
    if (speed.error) errors.push(`speed_kmh: ${speed.error}`);

    const odometer = parseNumber(get('odometer_km'), { min: 0 });
    if (odometer.error) errors.push(`odometer_km: ${odometer.error}`);

    const ignition = parseIgnition(get('ignition'));
    if (ignition.error) errors.push(`ignition: ${ignition.error}`);

    const driverId = sanitiseFreeText(get('driver_id'));
    const sourceRef = sanitiseFreeText(get('source_ref')) || `csv row ${rowNum}`;

    let duplicateKey = null;
    if (vehicleIdRaw && ts.value) {
      duplicateKey = `${vehicleIdRaw}|${ts.value}`;
      if (seenKeys.has(duplicateKey)) {
        errors.push(`Duplicate row: vehicle "${vehicleIdRaw}" already has a reading at ${ts.value} earlier in this file.`);
      }
    }

    const record = {
      sourceSystem,
      integrationType: 'csv',
      vehicleId: vehicleIdRaw || null,
      timestampIso: ts.value,
      lat: lat.value,
      lng: lng.value,
      speedKmh: speed.value,
      ignitionOn: ignition.value !== null ? ignition.value : (speed.value !== null ? speed.value > 0 : null),
      odometerKm: odometer.value,
      driverId,
      rawSourceRef: sourceRef,
      validationStatus: errors.length === 0 ? 'valid' : 'invalid',
      importErrors: errors,
    };

    if (record.validationStatus === 'valid' && duplicateKey) seenKeys.add(duplicateKey);
    records.push(record);
  });

  const validRows = records.filter((r) => r.validationStatus === 'valid').length;
  return {
    records,
    fileErrors,
    summary: { totalRows: dataRows.length, validRows, invalidRows: dataRows.length - validRows },
  };
}

module.exports = {
  REQUIRED_COLUMNS,
  OPTIONAL_COLUMNS,
  parse,
  // exported for unit testing only
  _internal: { tokenizeCsv, sanitiseFreeText, parseTimestamp, parseNumber, parseIgnition },
};
