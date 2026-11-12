/**
 * Tamper-evident evidence export.
 *
 * A vehicle's position history for a period is exported as CSV where every
 * row carries the SHA-256 of (previous row's hash + this row's canonical
 * content). Changing, inserting or deleting any row breaks every hash after
 * it. The final hash ("chain head") is also written to the organisation's
 * audit log at export time, so a file can later be checked against what
 * Fleet Shield actually exported — see scripts/verify-evidence.js.
 *
 * Scope, stated plainly: this proves the file hasn't been altered since it
 * was exported. It does not prove the underlying telemetry was accurate —
 * that is what the assurance checks (lib/assurance.js) are for.
 */
const crypto = require('crypto');

const GENESIS = '0'.repeat(64);
const COLUMNS = ['ts', 'lat', 'lng', 'speed_kmh', 'heading_deg', 'status', 'odometer_km'];

function canonicalRow(r) {
  // Fixed column order and number formatting so the same data always
  // produces the same bytes, whichever machine re-computes it.
  return [
    new Date(r.ts).toISOString(),
    Number(r.lat).toFixed(6),
    Number(r.lng).toFixed(6),
    r.speed_kmh == null ? '' : Number(r.speed_kmh).toFixed(1),
    r.heading_deg == null ? '' : Number(r.heading_deg).toFixed(1),
    r.status || '',
    r.odometer_km == null ? '' : Number(r.odometer_km).toFixed(3),
  ].join(',');
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** rows → [{ line, hash }] chained from GENESIS. */
function chainRows(rows) {
  let prev = GENESIS;
  return rows.map((r) => {
    const line = canonicalRow(r);
    const hash = sha256(prev + '\n' + line);
    prev = hash;
    return { line, hash };
  });
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Build the export file. `meta` is written as leading '#' comment lines
 * (ignored by the chain) so the file is self-describing.
 */
function buildEvidenceCsv(rows, meta) {
  const chained = chainRows(rows);
  const head = chained.length ? chained[chained.length - 1].hash : GENESIS;
  const lines = [
    '# Fleet Shield evidence export (tamper-evident position history)',
    ...Object.entries({ ...meta, rows: rows.length, chain_head_sha256: head, genesis: GENESIS }).map(
      ([k, v]) => `# ${k}: ${csvEscape(v)}`
    ),
    '# Each row_sha256 = SHA-256(previous row_sha256 + "\\n" + the row\'s first 7 fields). Verify with scripts/verify-evidence.js.',
    [...COLUMNS, 'row_sha256'].join(','),
    ...chained.map((c) => `${c.line},${c.hash}`),
  ];
  return { csv: lines.join('\n') + '\n', head, rows: rows.length };
}

/**
 * Re-compute the chain from a CSV produced by buildEvidenceCsv.
 * Returns { ok, rows, head, firstBadRow } — firstBadRow is 1-based.
 */
function verifyEvidenceCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  const header = lines.shift();
  if (header !== [...COLUMNS, 'row_sha256'].join(',')) {
    return { ok: false, rows: 0, head: null, firstBadRow: 0, error: 'unexpected header' };
  }
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    const idx = lines[i].lastIndexOf(',');
    const line = lines[i].slice(0, idx);
    const claimed = lines[i].slice(idx + 1);
    const actual = sha256(prev + '\n' + line);
    if (actual !== claimed) return { ok: false, rows: lines.length, head: null, firstBadRow: i + 1 };
    prev = actual;
  }
  const declared = /# chain_head_sha256: ([0-9a-f]{64})/.exec(text);
  if (declared && declared[1] !== prev) {
    return { ok: false, rows: lines.length, head: prev, firstBadRow: lines.length, error: 'chain head does not match header' };
  }
  return { ok: true, rows: lines.length, head: prev, firstBadRow: null };
}

module.exports = { GENESIS, COLUMNS, canonicalRow, chainRows, buildEvidenceCsv, verifyEvidenceCsv, sha256 };
