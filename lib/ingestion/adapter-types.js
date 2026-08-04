/**
 * Vendor-neutral telemetry ingestion — shared types and limits.
 *
 * Fleet Shield's live dashboard is driven by an in-process simulation
 * (server.js's tickOrg loop). This module is the first step toward
 * accepting telemetry from a *real* external source instead: it defines a
 * single, vendor-neutral shape ("NormalizedObservation") that any adapter
 * (CSV today; a vendor API/webhook adapter later) must produce, so the rest
 * of the ingestion pipeline (validation, cumulative-total computation,
 * storage) never has to know which vendor or file format the data came
 * from.
 *
 * Status: internal engineering scaffolding. No vendor integration has been
 * built, tested against a real device/API, or certified. Nothing in this
 * module should be described publicly as a "validated integration" — see
 * jegasec-site/src/lib/integrations.ts, which deliberately lists no
 * integrations as validated.
 *
 * Implementation status of each planned ingestion method (see Fleet Shield
 * README / docs/founder-decisions-required.md for the public-facing
 * version of this table):
 *   - Secure CSV import          -> PROTOTYPE (this module + csv-adapter.js)
 *   - Manual approved upload     -> PROTOTYPE (same code path, admin-only route)
 *   - REST API connector         -> PLANNED (not implemented)
 *   - Scheduled file import      -> PLANNED (not implemented)
 *   - Custom / vendor connector  -> PLANNED (not implemented)
 */

'use strict';

// ---------------------------------------------------------------------------
// Canonical observation shape
// ---------------------------------------------------------------------------
//
// Every adapter normalizes its source data into an array of these objects.
// Fields map onto (a subset of) the `positions` table plus provenance/QA
// fields that never get persisted but are needed for validation, audit, and
// error reporting.
//
// NormalizedObservation — canonical internal telemetry record. Every
// adapter (CSV today; a future REST/webhook adapter) normalizes its source
// data into this same shape, so downstream validation-report and
// cumulative-total logic never needs to know which format the data
// originally arrived in.
//
//   sourceSystem       string        — vendor-neutral tag for where this came
//                                       from, e.g. "csv-upload". Never a
//                                       vendor/customer name unless a real,
//                                       authorised connection exists.
//   sourceRecordId       string|null — an identifier for this specific
//                                       record within its source (e.g.
//                                       "csv-row-42"), distinct from
//                                       rawSourceRef below — used for
//                                       idempotency/dedup tracing, not
//                                       intended as free text.
//   integrationType     string        — one of INTEGRATION_TYPES below. Only
//                                       'csv' has an implementation today.
//   orgId                 string|null — the importing organisation's ID.
//                                       Stamped by the adapter from the
//                                       caller-supplied context; never
//                                       trusted from source-data content.
//   vehicleId            string       — must match an existing vehicles.id
//                                       for the importing org; imports never
//                                       create vehicles implicitly.
//   timestampIso          string      — ISO 8601 UTC timestamp of the
//                                       reading itself (when the vehicle was
//                                       actually at this state).
//   ingestedAtIso          string     — ISO 8601 UTC timestamp of when this
//                                       record was processed by the
//                                       adapter — distinct from
//                                       timestampIso, since a batch import
//                                       can ingest historical readings long
//                                       after they occurred.
//   lat, lng                number
//   speedKmh                 number|null
//   headingDeg                number|null — compass heading in degrees, if
//                                       the source provides it. The CSV
//                                       adapter does not currently populate
//                                       this (not derivable from sparse
//                                       imported points without a
//                                       redesign — see cumulative.js).
//   ignitionOn              boolean|null — derived "moving vs idling vs off"
//                                       signal; null if the source doesn't
//                                       provide it (falls back to a
//                                       speed-based inference: speed > 0 =>
//                                       moving).
//   odometerKm               number|null — cumulative odometer reading if the
//                                       source provides one (preferred over
//                                       GPS-distance estimation when present
//                                       and monotonically increasing).
//   fuelLevelPercent           number|null — point-in-time fuel/energy level,
//                                       if the source provides it. Distinct
//                                       from the fuel *used* totals computed
//                                       by cumulative.js. Not populated by
//                                       the CSV adapter today — the
//                                       documented CSV schema doesn't carry
//                                       a fuel-level column.
//   driverId                  string|null — only populated where the
//                                       importing org is authorised to
//                                       supply driver-level data (see
//                                       docs/pilot-readiness/telemetry-data-requirements.md).
//   eventType                  string     — the kind of record this is.
//                                       The CSV adapter always sets this to
//                                       'position_update', since the
//                                       documented CSV schema carries
//                                       routine position readings, not
//                                       discrete driver-behaviour events
//                                       (harsh braking, geofence breach,
//                                       etc.) — those remain live-simulation
//                                       only until a source that actually
//                                       reports discrete events exists.
//   rawSourceRef               string|null — free-text pointer back to the
//                                       source row/record (e.g. a
//                                       source-system's own reference ID),
//                                       sanitised against spreadsheet-formula
//                                       injection before storage or
//                                       re-export.
//   validationStatus           'valid' | 'invalid'
//   importErrors              string[] — human-readable validation failures;
//                                       empty when validationStatus is
//                                       'valid'.

const INTEGRATION_TYPES = Object.freeze(['csv', 'api', 'webhook']);

const IMPLEMENTATION_STATUS = Object.freeze({
  csv: 'prototype',
  api: 'planned',
  webhook: 'planned',
});

// ---------------------------------------------------------------------------
// Shared limits (defence-in-depth against oversized/abusive uploads)
// ---------------------------------------------------------------------------

const LIMITS = Object.freeze({
  MAX_FILE_BYTES: 2 * 1024 * 1024, // 2 MB
  MAX_ROWS: 5000,
  MAX_FIELD_LENGTH: 500,
  MAX_VEHICLES_PER_IMPORT: 200,
});

/**
 * The interface every ingestion adapter must satisfy. This isn't enforced by
 * the language (no TypeScript in this codebase) — it's documented here as
 * the contract, and lib/ingestion/csv-adapter.js is the first concrete
 * implementation of it.
 *
 * An adapter module must export:
 *   parse(rawInput, context) -> {
 *     records: NormalizedObservation[],
 *     fileErrors: string[],   // whole-file problems (too big, wrong shape)
 *   }
 *
 * `context` carries org-scoped information the adapter needs to validate
 * against (currently: the set of vehicle IDs registered to the importing
 * org), never credentials or cross-org data.
 */

function createEmptyObservation(overrides) {
  return Object.assign(
    {
      sourceSystem: null,
      sourceRecordId: null,
      integrationType: null,
      orgId: null,
      vehicleId: null,
      timestampIso: null,
      ingestedAtIso: null,
      lat: null,
      lng: null,
      speedKmh: null,
      headingDeg: null,
      ignitionOn: null,
      odometerKm: null,
      fuelLevelPercent: null,
      driverId: null,
      eventType: null,
      rawSourceRef: null,
      validationStatus: 'invalid',
      importErrors: [],
    },
    overrides || {}
  );
}

module.exports = {
  INTEGRATION_TYPES,
  IMPLEMENTATION_STATUS,
  LIMITS,
  createEmptyObservation,
};
