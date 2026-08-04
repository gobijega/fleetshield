/**
 * Import validation report — measurable technical evidence for the CSV
 * ingestion prototype.
 *
 * Turns the raw per-row validation output from csv-adapter.js into a
 * compact, structured metrics object: the kind of evidence that could
 * later support a pilot case study, without publishing any customer data
 * itself. Every field here is derived directly from the records that were
 * actually parsed for a given import — nothing is estimated or invented.
 */

'use strict';

/**
 * @param {object[]} records - the full NormalizedObservation[] array
 *   returned by csv-adapter.js's parse() (both valid and invalid rows).
 * @param {number} startedAtMs - Date.now() captured before parsing began.
 * @param {number} finishedAtMs - Date.now() captured after the import
 *   (including any DB write) completed.
 * @returns {{
 *   recordsSubmitted: number,
 *   recordsAccepted: number,
 *   recordsRejected: number,
 *   duplicateRecords: number,
 *   unknownVehicles: number,
 *   invalidCoordinates: number,
 *   invalidTimestamps: number,
 *   otherRejections: number,
 *   processingDurationMs: number,
 *   latestIngestedTimestampIso: string|null,
 *   dataCompletenessPercent: number,
 * }}
 */
function buildValidationReport(records, startedAtMs, finishedAtMs) {
  const recordsSubmitted = records.length;
  let recordsAccepted = 0;
  let duplicateRecords = 0;
  let unknownVehicles = 0;
  let invalidCoordinates = 0;
  let invalidTimestamps = 0;
  let otherRejections = 0;
  let latestIngestedTimestampIso = null;

  for (const r of records) {
    if (r.validationStatus === 'valid') {
      recordsAccepted += 1;
      if (r.timestampIso && (!latestIngestedTimestampIso || r.timestampIso > latestIngestedTimestampIso)) {
        latestIngestedTimestampIso = r.timestampIso;
      }
      continue;
    }
    // Categorise by the first matching error type. A row can trip more
    // than one validation rule; it's counted once, under the first
    // category matched, so the category counts don't double-count a
    // single rejected row across multiple buckets.
    const errors = r.importErrors || [];
    if (errors.some((e) => /^Duplicate row/.test(e))) {
      duplicateRecords += 1;
    } else if (errors.some((e) => /^Unknown vehicle identifier/.test(e))) {
      unknownVehicles += 1;
    } else if (errors.some((e) => /^(lat|lng):/.test(e))) {
      invalidCoordinates += 1;
    } else if (errors.some((e) => /^timestamp:/.test(e))) {
      invalidTimestamps += 1;
    } else {
      otherRejections += 1;
    }
  }

  const recordsRejected = recordsSubmitted - recordsAccepted;
  const dataCompletenessPercent = recordsSubmitted > 0
    ? Math.round((recordsAccepted / recordsSubmitted) * 1000) / 10
    : 0;

  return {
    recordsSubmitted,
    recordsAccepted,
    recordsRejected,
    duplicateRecords,
    unknownVehicles,
    invalidCoordinates,
    invalidTimestamps,
    otherRejections,
    processingDurationMs: Math.max(0, finishedAtMs - startedAtMs),
    latestIngestedTimestampIso,
    dataCompletenessPercent,
  };
}

module.exports = { buildValidationReport };
