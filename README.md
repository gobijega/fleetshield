# Vehicle Telematics Solution — MVP

A working demo of the software layer behind a fleet telematics platform: live vehicle
tracking, driver-behaviour alerts, geofencing/compliance, and fleet reporting. Vehicle
GPS data is simulated (10 vehicles moving on routes around Melbourne, VIC) so the whole
stack runs standalone with no hardware or device integration required — the ingestion
layer is the one piece that would be swapped for a real device/API feed in production.

## What it demonstrates

Mapped against Goulburn-Murray Water's stated purpose for this tender:

- **Fleet safety & compliance** — driver-behaviour alerts (harsh braking, harsh
  acceleration, speeding, excessive idling), a per-vehicle safety score derived from
  alert history, plus simulated vehicle registration and service-due tracking with
  overdue/due-soon flags.
- **Visibility of fleet utilisation & location** — live map with real-time WebSocket
  position updates, and a utilisation metric (% time moving vs idling) per vehicle and
  fleet-wide.
- **Understanding of driver behaviour** — live, filterable alerts log covering harsh
  events, speeding, and idling, attributed to driver and vehicle.
- **Operational efficiency** — fleet reporting dashboard: distance travelled, average
  speed, idle vehicles, trip counts, and utilisation.
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
  feed via a signed session cookie. See `README`'s "Running it locally" for setup.

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
boot the server seeds the 10-vehicle fleet and 3 geofences into the database; on every
subsequent boot it restores where the fleet
left off instead of starting from zero.

No Docker available? You can still run the server against any reachable Postgres —
just point `DATABASE_URL` at it (see `.env.example`) and run `npm run migrate` once.

## Deploying it for real

See **[DEPLOY.md](./DEPLOY.md)** for the full walkthrough: a managed TimescaleDB
instance (Timescale Cloud) plus a persistent, WebSocket-capable host (Render).

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
| GET | `/api/reports/summary` | Fleet KPIs, alert counts, per-vehicle stats (incl. emissions & utilisation) |
| GET | `/api/reports/emissions` | Fleet + per-vehicle CO2-e, fuel/energy use, breakdown by fuel type |
| GET | `/api/compliance` | Per-vehicle safety score, rego expiry status, service-due status |
| GET | `/api/health` | Server + database connectivity check |

WebSocket stream at `ws://localhost:3000/ws` emits `init`, `positions`, and `alert`
messages.

## Extending toward production

- Swap the simulator in `tick()` for a real ingestion endpoint (device webhook, MQTT
  broker, or OEM API) feeding the same vehicle state shape.
- Add authentication, multi-tenant fleet scoping, and role-based access.
- Add polygon geofences (currently circular), historical route playback on the map, and
  maintenance/fuel-cost reporting to match the tender's full scope.
- Add PostGIS if/when geospatial queries (route matching, polygon containment) outgrow
  simple radius checks.
