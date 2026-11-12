#!/usr/bin/env node
/**
 * Verify a Fleet Shield evidence export has not been altered.
 *
 *   node scripts/verify-evidence.js export.csv [expected-chain-head]
 *
 * Re-computes every row hash. If an expected chain head is given (from the
 * organisation's audit log entry for the export), it must match too.
 * Exit code 0 = intact, 1 = altered or unreadable.
 */
const fs = require('fs');
const { verifyEvidenceCsv } = require('../lib/evidence');

const [file, expectedHead] = process.argv.slice(2);
if (!file) {
  console.error('Usage: node scripts/verify-evidence.js <export.csv> [expected-chain-head]');
  process.exit(1);
}
const result = verifyEvidenceCsv(fs.readFileSync(file, 'utf8'));
if (!result.ok) {
  console.error(`ALTERED: chain breaks at data row ${result.firstBadRow}${result.error ? ` (${result.error})` : ''}.`);
  process.exit(1);
}
if (expectedHead && expectedHead.toLowerCase() !== result.head) {
  console.error(`ALTERED: rows are self-consistent but the chain head ${result.head} does not match the audit log (${expectedHead}).`);
  process.exit(1);
}
console.log(`INTACT: ${result.rows} rows, chain head ${result.head}${expectedHead ? ' (matches audit log)' : ''}.`);
