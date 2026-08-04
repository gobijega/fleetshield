# Security review — credibility/conversion pass

Internal document. Not published. Covers the changes made in this pass:
canonical telemetry record fields (orgId/sourceRecordId/ingestedAtIso/
eventType/headingDeg/fuelLevelPercent added to adapter-types.js and
csv-adapter.js), lib/ingestion/validation-report.js, audit-detail metrics
enrichment in server.js, removal of the orphaned public/signup.js, cache-
control policy changes in jegasec-site's public/_headers, and copy-only
edits across fleet-shield.astro/index.astro/products.astro/advisory.astro.
This is additional to, not a replacement for,
`docs/security-review-phase9-10.md` from the prior pass.

| # | Issue reviewed | Finding | Severity | Status | Residual risk |
|---|---|---|---|---|---|
| 1 | orgId provenance in canonical records | `orgId` stamped onto each `NormalizedObservation` comes from `import-service.js`'s server-side `orgId` parameter (ultimately `req.orgId`, set by `requireAuth` from the session) — never read from CSV content itself | — | Reviewed, no issue | None |
| 2 | Audit-log detail string injection | The new `[metrics: ...]` suffix appended to the audit detail interpolates only numeric fields from `validationReport` (counts, durations, a percentage) — no free-text or user-controlled values are added to this string beyond what was already there | — | Reviewed, no issue | None |
| 3 | `sourceRecordId` derivation | Computed server-side as `` `csv-row-${rowNum}` `` — a controlled integer, not derived from row content — so it cannot be used to inject anything into downstream storage or logs | — | Fixed by design | None |
| 4 | Orphaned `public/signup.js` removal | This file was unreferenced by any served page but was still directly fetchable (`GET /signup.js`), showing pre-controlled-beta "Continue to payment" copy inconsistent with the current controlled-beta model. Removed. | Low (information/consistency, not a technical vulnerability) | Fixed | None — confirmed absent via `tests/no-prohibited-claims.test.js` |
| 5 | New `Cache-Control` policy | HTML gets `public, max-age=0, must-revalidate` (safe — no sensitive data on jegasec.com's fully public marketing site); `/_astro/*` gets a one-year immutable cache (safe — filenames are content-hashed by Astro's build, so a content change always produces a new URL, never a stale served file at the same URL) | — | Fixed | None |
| 6 | Advisory page package links (`&package=...` query params) | Static, hardcoded `href` values in Astro source — not constructed from user input, so no injection surface | — | Reviewed, no issue | None |
| 7 | New prohibited-claims tests reading `dist/`/`public/` from disk | Read-only `fs.readdirSync`/`readFileSync` against known, hardcoded directories relative to `__dirname` — no path input from outside the test file itself | — | Reviewed, no issue | None |
| 8 | Copy-only edits (fleet-shield.astro, index.astro, products.astro, advisory.astro) | Static text changes only; no new dynamic rendering, no new user input paths | — | Reviewed, no issue | None |

## Summary

No new vulnerabilities identified in this pass's changes. One risk-reduction
fix (orphaned stale asset removal). No infrastructure or founder action
required as a result of this specific pass's changes (see
`docs/founder-decisions-required.md` for the unrelated, still-open
legal/commercial items, and `docs/security-review-phase9-10.md` items 22–23
for the still-open engineering items from the prior pass).
