# Telemetry ingestion architecture — technical documentation

Internal document. Not published in full on the public site (a short,
non-sensitive summary appears on jegasec.com/fleet-shield's "Integration
readiness" section instead — see the note at the end of this document).
Covers the CSV ingestion prototype built in `lib/ingestion/`.

## Architecture overview

Three-stage pipeline, each stage a separate, independently-testable module:

```
raw CSV text
     │
     ▼
lib/ingestion/csv-adapter.js      parse + validate + normalise
     │  → NormalizedObservation[] (adapter-types.js canonical shape)
     ▼
lib/ingestion/cumulative.js       compute running totals per vehicle
     │  → rows shaped for the positions table
     ▼
lib/ingestion/import-service.js   orchestrate: group by vehicle, fetch
     │                            starting state, write, build report
     ▼
server.js POST /api/telemetry/import/csv   auth, audit, HTTP boundary
```

## Data flow

1. An authenticated admin (of an org with an active subscription) submits
   raw CSV text to `POST /api/telemetry/import/csv`.
2. `csv-adapter.js` tokenizes the CSV (hand-rolled parser, no third-party
   dependency), validates every row against the documented schema (see
   `docs/pilot-readiness/telemetry-data-requirements.md`), and produces a
   `NormalizedObservation` per row — valid or invalid, with errors attached.
3. `import-service.js` splits valid observations by vehicle, and for each
   vehicle fetches its current latest known state (`getLatestPosition`,
   backed by `restoreLatestPosition` in server.js) so cumulative totals
   continue rather than reset.
4. `cumulative.js` walks each vehicle's observations in timestamp order,
   deriving `fuel_used_total`, `co2_kg_total`, `moving_sec_total`,
   `idling_sec_total`, and `trip_count` using the vehicle's real
   fuel-consumption/emission-factor data (the same constants the live
   simulation uses — `lib/fleet-data.js`).
5. `import-service.js` writes all computed rows in a single `INSERT`
   statement (atomic — all rows or none) via `persistImportedPositions`.
6. A `validationReport` (see below) and a full per-row error list are
   returned to the caller and written to the audit log.

## Validation process

Enforced in `csv-adapter.js`, exercised by `tests/csv-ingestion.test.js`:
required-column presence, per-field length limits, vehicle-ID ownership
(must belong to the importing org), timestamp plausibility (parseable,
not before 2015, not >24h in the future), coordinate range, in-file
duplicate detection (same vehicle + timestamp), malformed-row detection
(wrong field count), and spreadsheet-formula-injection neutralisation on
free-text fields.

## Normalisation

Every row — valid or invalid — is normalised into the same
`NormalizedObservation` shape (`adapter-types.js`) regardless of source
format, so a future non-CSV adapter (REST API, webhook) could reuse the
same downstream validation-report and cumulative-total logic without
rewriting them.

## Audit trail

Every import attempt (accepted or rejected) is written to the existing
`audit_log` table via `audit('telemetry_csv_import', ...)`, including org,
username, IP, success/failure, a human-readable summary, and a compact
`[metrics: ...]` suffix carrying the structured validation-report numbers
(see below) — queryable via the existing `GET /api/audit` endpoint. This is
the "internal validation dashboard" for this prototype: rather than
building and maintaining a separate UI, each import's metrics are
individually reviewable through the audit log that already exists for
every other security-relevant event in the product.

## Validation report (measurable technical evidence)

`lib/ingestion/validation-report.js` computes, from the actual parsed
records of a given import: `recordsSubmitted`, `recordsAccepted`,
`recordsRejected`, `duplicateRecords`, `unknownVehicles`,
`invalidCoordinates`, `invalidTimestamps`, `otherRejections`,
`processingDurationMs`, `latestIngestedTimestampIso`, and
`dataCompletenessPercent`. Returned in the API response body
(`result.validationReport`) and logged to the audit trail. Covered by
`tests/csv-ingestion.test.js`. This is the reusable report referenced in
`docs/pilot-readiness/pilot-closeout-template.md` and
`docs/pilot-readiness/pilot-success-metrics.md` — a real pilot's ingestion
metrics would come directly from this structure, not be estimated after
the fact.

## Error handling

Row-level errors never abort the whole import (partial-import behaviour —
valid rows are written even when other rows in the same file are
rejected). File-level errors (oversized, empty, unparseable, missing
required columns, too many distinct vehicles) abort before any database
write is attempted — nothing is written. A database write failure
propagates as a thrown error rather than being silently swallowed (see
`persistImportedPositions`, which — unlike the live simulation's
fire-and-forget `persistPositions` — is awaited and does not catch its own
errors).

## Security assumptions

- The importing admin's session is trusted to represent their own org only
  — vehicle ownership is checked server-side per row, not assumed from
  client input.
- CSV content is never written to disk and never evaluated/executed —
  parsing is pure string processing.
- Free-text fields are defended against spreadsheet formula injection on
  the assumption that CSV data (or data re-exported from it) may later be
  opened in spreadsheet software by an administrator.
- The route sits behind the same session, CSRF, active-subscription, and
  global rate-limiting middleware as every other authenticated API route —
  see `docs/security-review-phase9-10.md`.

## Known limitations

See `README.md`'s "Telemetry ingestion" section for the full detail,
summarised here:

1. No duplicate detection against telemetry already stored in Postgres —
   only within-file duplicates are caught.
2. Import timestamps overlapping the live simulation's activity for the
   same vehicle can produce an inconsistent "latest known position" on
   restart — safe for historical backfill or non-simulated fleets only,
   until resolved.
3. No upload UI — the route accepts raw CSV text in the request body, not
   a file picker.
4. Vendor-specific field mapping beyond the documented generic schema is
   not automatic and would need to be built per integration.

## What may be said publicly

The public `/fleet-shield` page may describe, in general terms, that a
secure CSV import mechanism exists as an internal engineering prototype
with validation, error reporting, and audit logging — this is already
reflected in the "Integration readiness" section's status label. It must
not describe specific validation thresholds, internal metric field names,
audit-log structure, or this document's architecture diagram, and must not
claim the prototype has ingested real customer data (it has not).
