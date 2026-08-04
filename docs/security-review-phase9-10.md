# Security review — telemetry ingestion prototype (Phase 9) and related changes

Internal document. Not published. Covers the code added/changed in this
pass: `lib/ingestion/` (adapter-types.js, csv-adapter.js, cumulative.js,
import-service.js), the `POST /api/telemetry/import/csv` route and
`persistImportedPositions` in `server.js`, and the pilot-readiness/README
documentation changes. Earlier phases' code (contact form, controlled-beta
gating, future signup flow) was reviewed in prior passes and is not
re-audited line-by-line here, though the new CSV-import route's interaction
with the existing auth/session/CSRF stack is covered.

No penetration testing, vulnerability certification, ISO/IRAP/Essential
Eight/SOC 2 assessment has been performed. This is a manual code review
against a defined checklist, nothing more.

| # | Issue reviewed | Finding | Severity | Status | Code change | Infra action | Founder action | Residual risk |
|---|---|---|---|---|---|---|---|---|
| 1 | Secrets in new code | No hardcoded keys/passwords/tokens found in `lib/ingestion/`, the new route, or new tests (`grep` swept for common patterns) | — | Fixed / N/A | None needed | None | None | None identified |
| 2 | Env-var handling | New code introduces no new env vars; reuses existing `DATABASE_URL`/`SESSION_SECRET` (pre-existing `process.exit` guards) | — | N/A | None | None | None | None |
| 3 | Auth on the new route | `POST /api/telemetry/import/csv` requires `sessionMiddleware` → `requireAuth` → `requireCsrf` → `requireActiveSubscription`, applied per-route since it's mounted before the global auth gate (same pattern as the Stripe webhook route) | — | Fixed in code | Implemented as described | None | None | Low — verified by `tests/telemetry-import-route.test.js` (401 without a session) |
| 4 | CSRF on the new route | `requireCsrf` explicitly included in the route's middleware chain | — | Fixed in code | Implemented | None | None | Low |
| 5 | Cookie configuration | Unchanged — reuses existing `sessionMiddleware` (`httpOnly`, `sameSite: 'lax'`, `secure: 'auto'`) | — | Not modified | None | None | Confirm `trust proxy` is set correctly behind Cloudflare/Render in production (pre-existing note in auth.js) | Low, pre-existing |
| 6 | SQL injection | `persistImportedPositions` builds its `INSERT` with parameterised placeholders (`$1..$n`), no string concatenation of row data into SQL | — | Fixed in code | N/A — reviewed, sound | None | None | None identified |
| 7 | MIME/header injection | Not applicable to this route (JSON/CSV, no email construction). Contact-form MIME injection was addressed in an earlier phase (`worker.js`) | — | N/A for this phase | N/A | None | None | None |
| 8 | Spreadsheet formula injection | `csv-adapter.js`'s `sanitiseFreeText` neutralises any free-text field starting with `=`, `+`, `-`, `@`, tab, or CR with a leading `'`; covered by `tests/csv-ingestion.test.js` | — | Fixed in code | Implemented | None | None | Low |
| 9 | Reflected/stored XSS | `future-signup/signup-form.html`'s error display uses `textContent`, not `innerHTML`; no other new client-side code reflects user input into the DOM | — | Fixed in code (reviewed, no issue) | N/A | None | None | None identified |
| 10 | Mass assignment | `/api/signup` (pre-existing, reviewed again here since the future-signup form now feeds it) destructures specific named fields from `req.body` rather than spreading the whole object into the DB call | — | Reviewed, no issue | N/A | None | None | None identified |
| 11 | Path traversal | `csv-adapter.js` never touches the filesystem — CSV content is a string already in memory (from the request body), not a file path; documented explicitly in the module's header comment | — | Fixed by design | N/A | None | None | None identified |
| 12 | File upload safety | No multipart file upload exists; CSV is accepted as a size-capped raw text body (`express.text({ limit: '2mb' })`) behind full auth — avoids the broader attack surface of a multipart parser entirely | — | Fixed in code | Implemented | None | None | Low |
| 13 | Unrestricted public upload | Route requires an authenticated admin session of an org with an active subscription; vehicle IDs are scoped to the importing org (`orgVehicleIds`), so one org cannot inject data against another org's vehicles | — | Fixed in code | Implemented | None | None | Low |
| 14 | Rate limiting | The new route falls under the existing `apiLimiter` (`app.use('/api/', apiLimiter)`, 120 req/min), mounted earlier in the file so it applies to every `/api/` route registered afterward, including this one | — | Confirmed | N/A — reviewed, applies as expected | None | Consider a lower, import-specific limit if abuse is observed in practice (not currently a known issue) | Low |
| 15 | CORS | No `Access-Control-*` headers or `cors()` middleware exist anywhere in either repo — default same-origin-only behaviour, unchanged by this phase | — | N/A | N/A | None | None | None |
| 16 | Sensitive-data logging | Error logs (`console.error`) log only `err.message`, never CSV content, coordinates, driver names, or full request bodies; the audit-log `detail` field records row counts and vehicle counts, not raw telemetry values | — | Fixed by design | Implemented | None | None | Low |
| 17 | Insecure redirects | `signup-form.html` redirects to `result.data.checkoutUrl`, which originates from the server's own Stripe Checkout session response (not user-controlled input reflected back), so this is not an open-redirect in the usual sense. The route producing it (`/api/signup`) itself is unreachable while `PUBLIC_SIGNUP_ENABLED=false` (current, default state) | Informational | Reviewed, no action needed at current state | N/A | None | None | Low — revisit if/when public signup is ever enabled |
| 18 | Missing security headers | The new route sits behind the existing global `helmet()` middleware (mounted earlier in `server.js`), so it inherits the same CSP/security headers as every other route | — | Confirmed | N/A — reviewed | None | None | None |
| 19 | Debug endpoints | No debug/test-only endpoints were added | — | N/A | N/A | None | None | None |
| 20 | Login error detail | Not touched by this phase's changes | — | Not assessable from this phase | N/A | N/A | N/A | Not assessable here — see prior-phase security review |
| 21 | Password-reset behaviour | No password-reset flow exists or was touched in this phase | — | Not applicable | N/A | N/A | N/A | Not applicable |
| 22 | Cross-import duplicate detection (data-integrity, not classic security) | Not implemented — documented as a known limitation in `README.md`'s "Telemetry ingestion" section with a specific implementation plan | Low–Medium (data integrity) | Requires further engineering work | Documented, not yet built | None | None | Medium until built — disclosed, not hidden |
| 23 | Live-simulation/import interaction | Writing imported rows with timestamps overlapping the live simulation's activity could produce an inconsistent "latest known position" on restart | Medium | Requires further engineering work | Documented with two candidate implementation approaches in README | None | Founder decision needed on which approach, and on whether the prototype should be restricted to historical-only imports until resolved | Medium — disclosed, mitigated by recommending historical-only use for now |

## Summary

- **Fixed in code (this phase):** items 1, 3, 4, 6, 8, 9 (reviewed clean), 11, 12, 13, 16.
- **Reviewed, no issue found (pre-existing code, re-checked because this phase touches it):** items 2, 5, 7, 10, 14, 15, 17, 18, 19.
- **Requires further engineering work, honestly disclosed rather than silently shipped:** items 22, 23 — see README's "Telemetry ingestion" → "Known limitations" for the detailed implementation plan for each.
- **Not assessable from this phase's changes:** items 20, 21 (untouched by this work).
- **No infrastructure or Cloudflare/hosting configuration actions identified** as required specifically by this phase's changes.
- **No legal/professional review items** identified specifically by this phase's changes (separate from the general legal register in `docs/founder-decisions-required.md`, which is unaffected by this phase).
