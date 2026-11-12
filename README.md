# Fleet Shield — Hardware-Agnostic Fleet Telematics Middleware

Fleet Shield is a **hardware-agnostic middleware platform**, not a hardware product. It
sits between whatever GPS/telematics hardware a fleet already has fitted — OBD-II
dongles, Teltonika, Queclink, Digital Matter, or any device/API that can push a position
feed — and turns that raw data into the safety, compliance, utilisation, and emissions
picture that utilities, contractors, and government entities are accountable for.
The pitch to these organisations is deliberately not "rip out your existing hardware and
buy ours": if a fleet already has trackers installed, Fleet Shield ingests that feed
directly; if it doesn't, any compatible off-the-shelf device works. Either way, the
value is the software layer, not a proprietary box.

This repo is a working demo of that software layer: live vehicle tracking,
driver-behaviour alerts, geofencing/compliance, and fleet reporting. Vehicle GPS data is
currently simulated (10 vehicles moving on routes around Melbourne, VIC) so the whole
stack runs standalone with no hardware integration required yet — the ingestion layer is
the one piece that gets pointed at a real device/API feed in production, per the
"Extending toward production" section below.

## Who it's for

Water and energy utilities, infrastructure contractors, and government entities that operate
vehicle fleets and are accountable for how those fleets are used — typically already
running some mix of telematics hardware across depots, and needing a single software
layer over the top for compliance reporting, safety, and emissions, rather than another
hardware contract.

## What it demonstrates

Mapped against Goulburn-Murray Water's stated purpose for this tender (representative of
the broader utility/contractor/government use case):

- **Fleet safety & compliance** — driver-behaviour alerts (harsh braking, harsh
  acceleration, speeding, excessive idling), a per-vehicle safety score derived from
  alert history, plus simulated vehicle registration and service-due tracking with
  overdue/due-soon flags.
- **Visibility of fleet utilisation & location** — live map with real-time WebSocket
  position updates, and a utilisation metric (% time moving vs idling) per vehicle and
  fleet-wide.
- **Understanding of driver behaviour** — live, filterable alerts log covering harsh
  events, speeding, and idling, attributed to driver and vehicle.
- **Operational efficiency** — fleet reporting for any period (today, 7/14/30/90 days or
  a custom range), each figure compared with the period before: distance, utilisation,
  idling and the fuel it burns, active days per vehicle, and a sortable per-vehicle
  table with a drill-down. Rule-based findings point to emissions concentration, idling,
  driving-risk outliers and under-used vehicles. Exports to CSV and prints to a clean
  A4 report (or PDF).
- **Driving risk** — safety events weighted by severity and normalised per 100 km, with
  a daily severity trend, a breakdown by event type, and a weekday-by-hour heatmap.
- **Emissions performance & reporting** — per-vehicle fuel/energy consumption and CO2-e
  emissions (diesel, petrol, and EV fleet mix, using standard combustion and grid
  emission factors), rolled up to fleet totals and broken down by fuel type.
- **Geofencing** — depot and restricted zones with entry/exit alerts; add or remove
  zones from the UI.

## Architecture

- **Backend** (`server.js`): Node.js + Express + `ws`. A simulation engine moves each
  vehicle along a route every 2 seconds, generates behaviour/geofence events, and
  exposes a REST API plus a WebSocket stream.
- **Database** (`db/`, Postgres + TimescaleDB): fleet configuration, geofences, alert
  history, and every position tick are persisted. Cumulative per-vehicle counters
  (odometer, fuel/CO2 used, moving/idling time) are restored from the database on boot,
  so a restart or redeploy doesn't lose fleet history — only the in-memory `state`
  object is a hot cache for the simulation tick and live WebSocket push.
- **Frontend** (`protected/`): plain HTML/CSS/JS, no build step. Leaflet for the map,
  Chart.js for reporting charts, connected to the backend via WebSocket + `fetch`.
  Branded as **Fleet Shield** (JEGASEC's fleet-security product) — black/matrix-green
  theme, IBM Plex Mono, matching the main jegasec.com site.
- **Auth** (`auth.js`, `public/login.html`): a single admin account (env-configured,
  bcrypt-hashed password) gates the dashboard, the REST API, and the live WebSocket
  feed via a signed session cookie, with an optional TOTP second factor. See `README`'s
  "Running it locally" for setup, and "Security" below for the full posture.

This mirrors how a production system would be laid out — a device/telemetry ingestion
service, a durable data layer, an API + real-time layer, and a dashboard — just with the
device feed replaced by a simulator.

## Running it locally

Requires Node.js 18+ and Docker (for a local TimescaleDB instance).

```
cd telematics-mvp
docker compose up -d       # starts Postgres + TimescaleDB on localhost:5432
cp .env.example .env       # local DB connection, no SSL
npm install
npm run hash-password -- "your-password"   # copy the output into .env as ADMIN_PASSWORD_HASH
npm run migrate            # creates tables + hypertable
npm start
```

Before the server will boot, `.env` also needs `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`
(from the command above), and `SESSION_SECRET` (any random string — e.g.
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) filled in;
these gate the whole dashboard behind a login page. See `.env.example`.

Then open **http://localhost:3000** — it'll redirect to the login page first. On first
boot the server seeds the 10-vehicle fleet and 3 geofences into the database, and also
backfills ~30 days of realistic simulated operating history (distance, fuel/CO2,
utilisation, and a spread of alerts) per vehicle, written as one row per working day, so
the **Reports tab has real day-by-day numbers — and a full comparison period for the
default 14-day view — immediately** instead of starting at zero and building up over hours of live
ticking. On every subsequent boot the fleet restores where it left off instead of
re-seeding.

No Docker available? You can still run the server against any reachable Postgres —
just point `DATABASE_URL` at it (see `.env.example`) and run `npm run migrate` once.

### Topping up an already-running deployment

The automatic backfill above only fires once, on a brand-new/empty database. If a
deployment (e.g. the live Fly.io/Tiger Cloud instance) has been running a short while and
Reports still looks sparse, add more simulated history on demand:

```
npm run backfill                 # adds ~14 more simulated days
npm run backfill -- --days=21    # adds ~21 more simulated days
```

This reads each vehicle's current totals and adds a synthetic increment on top, so it's
safe to run against real accumulated data — it never overwrites anything. **Restart the
server afterwards** so it picks up the new totals (it only re-reads cumulative state
from the database on boot).

## Security

Fleet Shield is aimed at utilities, contractors, and government fleets, so the security
posture is deliberately more than "add a login page." What's actually implemented:

- **Authentication**: bcrypt-hashed password, brute-force rate limiting (10 attempts /
  15 min, shared across the password and MFA steps), signed session cookies
  (`httpOnly`, `SameSite=Lax`, `secure` in production).
- **Optional TOTP multi-factor auth**: run `npm run setup-mfa` to generate a secret and
  scannable QR code, then set `ADMIN_TOTP_SECRET` to turn on a mandatory second login
  step. Off by default so existing password-only deployments don't break; turning it on
  is a one-time, one-variable change. See "Enabling MFA" below.
- **CSRF protection**: a double-submit cookie (`fs.csrf`) issued on successful login;
  every state-changing API request must echo it back as an `X-CSRF-Token` header or it's
  rejected (403). Read requests are unaffected.
- **Security headers** (via `helmet`): a locked-down Content-Security-Policy
  (`script-src 'self'` — no third-party script origins at all, since both Leaflet and
  Chart.js are vendored locally rather than loaded from a CDN), plus HSTS,
  X-Content-Type-Options, and `frame-ancestors 'none'` to block clickjacking.
- **Audit log**: every login, failed login, MFA failure, and logout, plus every
  geofence create/delete, is written to an `audit_log` table (who, when, from what IP,
  success/failure) — durably, before the response is sent, not fire-and-forget.
  Queryable via `GET /api/audit?limit=`.
- **Input validation**: geofence coordinates/radius/type are bounds-checked server-side
  (not just trusted from the form), independent of whatever the frontend enforces.
- **Rate limiting**: a general 120 req/min per-IP ceiling on the whole API, on top of
  the stricter login/MFA-specific limiter.
- **Password policy**: `npm run hash-password` refuses passwords under 12 characters.
- **Dependencies**: `npm audit` is clean (0 vulnerabilities) as of the last review.

### Enabling MFA

```
npm run setup-mfa
```

This prints a secret and a QR code — scan it into Google Authenticator, Authy, 1Password,
etc. Then set `ADMIN_TOTP_SECRET` to the printed secret (locally: add it to `.env`; on
Fly.io: `fly secrets set NAME=value`, which restarts the machine). From the
next login onward, the password step is followed by a 6-digit code prompt. Losing access
to the authenticator app means removing `ADMIN_TOTP_SECRET` to fall back to
password-only, then re-running the setup script to re-enrol.

### Known accepted risk

`npm audit` is currently clean, but worth noting for the record: this app deliberately
pins `cookie@^0.7.x` rather than the newest `cookie@2.x` — the 2.x line renamed the
`parse`/`serialize` exports (breaking API change) and an earlier upgrade attempt to it
crashed the WebSocket auth handler in production. 0.7.x already includes the fix for the
one CVE that applied to the 0.6.x line (CVE-2024-47764), and in any case that CVE
requires an attacker-controlled cookie *name*, which this app never does — cookie names
are hardcoded constants (`fs.sid`, `fs.csrf`), never derived from user input.

### Not yet done

One admin account per organization (no per-org multi-user roles yet — an organisation with
several staff who need dashboard access still shares one login), no formal penetration
test, no IRAP/government security certification.

## Billing

**Public self-service signup is currently disabled (controlled beta).** `/signup.html`
is a controlled-beta landing page (Request a demonstration / Apply for pilot access),
not a signup form. This is controlled by the `PUBLIC_SIGNUP_ENABLED` environment
variable, which defaults to disabled — see "Controlled-beta gate" below.

The complete self-service signup implementation still exists and is fully functional,
it's just not publicly reachable while the flag is off:

- `GET /signup-form.html` — the actual signup form (`future-signup/signup-form.html`,
  outside `public/` so static file serving can never expose it directly). The route
  handler checks `PUBLIC_SIGNUP_ENABLED` on every request and returns `404` while
  disabled, `200` with the form when enabled.
- `POST /api/signup` — creates the organisation + admin account, then Stripe's hosted
  Checkout collects payment (Fleet Shield never sees or stores card details). Always
  `403`s while `PUBLIC_SIGNUP_ENABLED` is off, regardless of whether the form route was
  somehow reached.

The subscription is AUD $17.50 per vehicle per month, billed via a quantity-based Stripe
Price: the billed quantity is kept in sync automatically every time a vehicle is added
or removed via the "Fleet & Billing" tab, so the bill always matches the live fleet size
(Stripe prorates the difference automatically — see `lib/billing.js`). GST treatment,
refund policy and cancellation terms are unresolved founder decisions — see
`docs/founder-decisions-required.md` — and are shown as explicit placeholders on the
signup form and in the Subscription and Billing Terms draft rather than invented.

### Controlled-beta gate

`PUBLIC_SIGNUP_ENABLED` is read with strict equality (`=== 'true'`) — only the literal
string `true` enables it; unset, blank, `false`, `0`, or any other value keeps signup
disabled. The server logs a loud `WARNING:` line at startup if it's ever on, so this is
never a silent state. Existing customer login is completely unaffected either way.

Before setting `PUBLIC_SIGNUP_ENABLED=true` on a real deployment: resolve the pricing/
refund/cancellation decisions in `docs/founder-decisions-required.md`, get the four
legal drafts (`/terms.html`, `/privacy.html`, `/billing-terms.html`,
`/acceptable-use.html`) reviewed, and update the signup form's placeholder text
accordingly.

Requires four environment variables (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`STRIPE_PRICE_ID`, `APP_BASE_URL` — see `.env.example`). Leave them unset to disable
signup/billing entirely; the existing single-admin ("default" org) deployment works
identically either way. A webhook endpoint (`POST /api/webhooks/stripe`) listens for
`checkout.session.completed`, `customer.subscription.updated`/`deleted`, and
`invoice.paid`/`payment_failed` to activate, update, or suspend an org's access —
`subscription_status` of `incomplete` or `canceled` blocks dashboard/API access;
`past_due` is allowed through as a grace period while Stripe's automatic retries run.

Multi-tenancy: every table (`vehicles`, `positions`, `alerts`, `geofences`, `audit_log`)
is scoped by `org_id`, and the in-memory simulation state, the WebSocket feed, and every
REST route are all scoped to the logged-in session's org — one customer can never see or
modify another's fleet data.

## Deploying it for real

See **[DEPLOY.md](./DEPLOY.md)** for the full walkthrough: a managed TimescaleDB
instance (Timescale Cloud) plus a persistent, WebSocket-capable host (Fly.io, Sydney).

## REST API

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/vehicles` | Current position/status of every vehicle (live cache) |
| GET | `/api/vehicles/:id/trips?hours=&limit=` | Historical positions for a vehicle, from Postgres |
| GET | `/api/alerts?limit=&vehicleId=` | Historical alert log, from Postgres |
| GET | `/api/reports/daily/:vehicleId` | Daily distance/CO2/avg-speed rollup, from Postgres |
| GET | `/api/geofences` | Configured geofence zones |
| POST | `/api/geofences` | Add a zone: `{ name, lat, lng, radiusM, type }` |
| DELETE | `/api/geofences/:id` | Remove a zone |
| GET | `/api/reports/fleet` | Period report for the Reports tab: `?preset=today\|7d\|14d\|30d\|90d` or `?from=&to=` (local dates), optional `&fuel=diesel\|petrol\|ev`. KPIs vs the previous period, daily series, alert breakdowns, per-vehicle table and findings. Days are local to `REPORT_TIMEZONE` (default `Australia/Melbourne`). See `lib/reports.js` |
| GET | `/api/reports/summary` | Lifetime fleet KPIs, alert counts, per-vehicle stats (incl. emissions & utilisation) |
| GET | `/api/reports/emissions` | Fleet + per-vehicle CO2-e, fuel/energy use, breakdown by fuel type |
| GET | `/api/compliance` | Per-vehicle safety score, rego expiry status, service-due status |
| GET | `/api/audit?limit=` | Security audit trail: login/MFA/logout events, geofence/vehicle changes |
| GET | `/api/health` | Server + database connectivity check |
| GET | `/api/me` | Current org's name, subscription status, vehicle count |
| POST | `/api/vehicles/checkout` | Start a $17.50 AUD one-time Stripe Checkout for adding a vehicle: `{ label, driver?, fuelType }`, returns `{ checkoutUrl }`. The vehicle is created by the Stripe webhook once payment is confirmed — not by this call. |
| POST | `/api/vehicles` | Add a vehicle directly, no payment prompt: `{ label, driver?, fuelType }`. Only usable when billing is disabled on this deployment (returns 400 otherwise) — see `/api/vehicles/checkout`. |
| DELETE | `/api/vehicles/:id` | Remove a vehicle — syncs Stripe subscription quantity down (prorated credit) |
| POST | `/api/signup` (public, `403` unless `PUBLIC_SIGNUP_ENABLED=true`) | Create an organization + admin account: `{ orgName, contactName?, contactEmail, username, password, confirmPassword, fleetSizeEstimate?, agreedToTerms, authorisedToActForOrg }` — `agreedToTerms` and `authorisedToActForOrg` must both be exactly `true`. Returns a Stripe Checkout URL |
| POST | `/api/webhooks/stripe` (public) | Stripe webhook receiver — signature-verified, not for direct use |
| POST | `/api/telemetry/import/csv` | **Prototype.** Secure CSV telemetry import — see "Telemetry ingestion" below. Body: raw CSV text, `Content-Type: text/csv`, max 2MB. Requires an authenticated admin session with an active subscription, plus `X-CSRF-Token`. |

State-changing requests (`POST`/`DELETE`) require an `X-CSRF-Token` header matching the
`fs.csrf` cookie issued at login — see "Security" below.

WebSocket stream at `ws://localhost:3000/ws` emits `init`, `positions`, and `alert`
messages.

## Telemetry ingestion

The live dashboard is driven by an in-process simulation (`tickOrg()` in `server.js`),
not real vehicle hardware — see "What it demonstrates" above. `lib/ingestion/` is the
first step toward accepting telemetry from a real external source instead: a
vendor-neutral adapter framework plus one concrete adapter.

**Status of each planned ingestion method** (also tracked in
`jegasec-site/src/lib/integrations.ts`, which drives the public-facing wording on
`/fleet-shield` — no method here is marked "implemented" or shown to customers as a
validated integration):

| Method | Status | Notes |
|---|---|---|
| Secure CSV import | **Prototype** | `lib/ingestion/csv-adapter.js` + `cumulative.js` + `import-service.js`; wired up at `POST /api/telemetry/import/csv`. Exercised only against the fictional fixture in `tests/fixtures/telemetry-sample.csv`. |
| Approved manual upload | Planned | No separate manual-upload UI exists; would reuse the CSV prototype's validation once a real upload surface is built. |
| REST API connector | Planned | Not started. |
| Scheduled file import | Planned | Not started — would need a scheduler plus the CSV adapter above. |
| Custom connector | Planned | Not started; scoped per engagement once a real integration is contracted. |

**What the CSV prototype actually does**, end to end: an authenticated admin of an org
with an active subscription POSTs raw CSV text (documented schema below) to
`/api/telemetry/import/csv`. `csv-adapter.js` parses it with a hand-rolled RFC4180-style
tokenizer (no third-party CSV library — kept in-house so every parsing/security
guarantee is auditable in one file) and validates every row: required columns present,
vehicle ID belongs to the importing org, timestamp is a plausible ISO 8601 value,
coordinates in range, no duplicate vehicle+timestamp rows within the file, free-text
fields defended against spreadsheet "formula injection" (a leading `=`/`+`/`-`/`@` gets
a neutralising prefix) and stripped of embedded CR/LF. Valid rows are grouped per
vehicle, and `cumulative.js` derives the same running totals the live simulation
computes (`fuel_used_total`, `co2_kg_total`, `moving_sec_total`, `idling_sec_total`,
`trip_count`) using the vehicle's real fuel-consumption/emission-factor data, continuing
from that vehicle's current latest position rather than resetting history. The resulting
rows are written to `positions` via a single atomic `INSERT` (all rows or none), and the
import is recorded in the audit log (`telemetry_csv_import`).

**Documented CSV schema:**

```
vehicle_id,timestamp,lat,lng,speed_kmh,ignition,odometer_km,driver_id,source_ref
VIC-01,2026-06-01T08:00:00Z,-37.8136,144.9631,0,on,62000,J. Ahmed,ref-1
```

`vehicle_id`, `timestamp`, `lat`, `lng` are required; the rest are optional. Limits: 2MB
file size, 5000 data rows, 200 distinct vehicles per import, 500 characters per field.
Full validation rules are in `lib/ingestion/csv-adapter.js`.

**Known limitations — documented rather than silently patched over**, per the
"produce an implementation plan rather than an unsafe patch" principle:

1. **No cross-import duplicate detection against already-stored history.**
   `csv-adapter.js` only catches duplicate vehicle+timestamp rows *within the same
   uploaded file*; it does not check the `positions` table for readings that were
   already imported previously. Repeated imports covering overlapping time ranges will
   currently insert duplicate rows. **Implementation plan:** before writing, query
   `SELECT ts FROM positions WHERE vehicle_id = $1 AND ts = ANY($2)` for each vehicle's
   batch of timestamps and drop any that already exist, inside the same transaction as
   the insert.
2. **Interaction with the live simulation loop is not yet arbitrated.** `tickOrg()`
   restores a vehicle's cumulative totals from its single latest `positions` row on
   server restart (`restoreLatestPosition`/`initVehiclesForOrg`). An import that writes
   a row with a timestamp later than the live simulation's most recent tick — or that
   runs concurrently with it — could produce an inconsistent "latest" row. This
   prototype is safe for backfilling **historical** data (timestamps before a vehicle's
   live simulation history began) or for orgs not currently running the live simulation
   for the imported vehicles; it is not yet safe for concurrent, ongoing import against
   an actively-simulated fleet. **Implementation plan:** either (a) reject import rows
   with a timestamp newer than the vehicle's current latest row, or (b) replace the
   in-memory simulation's per-tick DB write with a shared "latest state" table read on
   every write rather than only on boot, so both paths converge on the same source of
   truth. Neither has been built; this needs a founder/engineering decision before this
   prototype is used against a live fleet, not just a backfill.
3. **No file-upload UI.** The route only accepts CSV as a raw request body — there is no
   admin dashboard page to select and upload a file yet. Wiring one up is
   straightforward (a `<input type="file">` reading `.text()` and `fetch()`-ing it to
   the existing route) but has not been built, since the priority for this pass was the
   validation/security pathway, not the admin UX.

None of this is presented publicly as a working integration — see
`jegasec-site/src/lib/integrations.ts`'s `INTEGRATIONS` array, which stays empty, and
the "internal engineering prototype" label shown next to "Secure file import" on
`/fleet-shield`.

## Extending toward production

- Swap the simulator in `tick()` for a real ingestion layer — device webhook, MQTT
  broker, or OEM API — feeding the same vehicle state shape, or build out the CSV
  prototype above into a production ingestion path (see its documented limitations).
  Because the pipeline is hardware-agnostic by design, this should support multiple
  concurrent hardware vendors/protocols per fleet (an organisation rarely has one uniform
  hardware base across every depot), not just one.
- Multi-tenant fleet scoping and self-service billing are now in place (see "Billing"
  above) — the remaining gap is per-org role-based access (multiple staff per customer
  with different permission levels), not tenant isolation itself.
- Add polygon geofences (currently circular), historical route playback on the map, and
  maintenance/fuel-cost reporting to match the tender's full scope.
- Add PostGIS if/when geospatial queries (route matching, polygon containment) outgrow
  simple radius checks.

**Note on hardware:** an earlier line of exploration looked at a custom-manufactured
Fleet Shield tracker (Nordic nRF9151-based) as a proprietary hardware product. That's
parked, not active roadmap — it doesn't fit the middleware positioning above. Fleet
Shield's value is the ingestion/correlation/reporting software working across whatever
hardware a customer already has or chooses, not a hardware SKU JEGASEC has to
manufacture and support.
