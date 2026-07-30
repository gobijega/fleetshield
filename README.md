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
  vehicle along a route every 2 seconds, generates behaviour/geofence events, keeps
  in-memory trip history, and exposes a REST API plus a WebSocket stream.
- **Frontend** (`public/`): plain HTML/CSS/JS, no build step. Leaflet for the map,
  Chart.js for reporting charts, connected to the backend via WebSocket + `fetch`.

This mirrors how a production system would be laid out — a device/telemetry ingestion
service, an API + real-time layer, and a dashboard — just with the device feed replaced
by a simulator.

## Running it

Requires Node.js 18+.

```
cd telematics-mvp
npm install
npm start
```

Then open **http://localhost:3000**. The server takes a few seconds to boot before the
first vehicle positions arrive.

## REST API

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/vehicles` | Current position/status of every vehicle |
| GET | `/api/vehicles/:id/trips` | Recent trip points for a vehicle |
| GET | `/api/alerts?limit=` | Recent alerts, most recent first |
| GET | `/api/geofences` | Configured geofence zones |
| POST | `/api/geofences` | Add a zone: `{ name, lat, lng, radiusM, type }` |
| DELETE | `/api/geofences/:id` | Remove a zone |
| GET | `/api/reports/summary` | Fleet KPIs, alert counts, per-vehicle stats (incl. emissions & utilisation) |
| GET | `/api/reports/emissions` | Fleet + per-vehicle CO2-e, fuel/energy use, breakdown by fuel type |
| GET | `/api/compliance` | Per-vehicle safety score, rego expiry status, service-due status |

WebSocket stream at `ws://localhost:3000/ws` emits `init`, `positions`, and `alert`
messages.

## Extending toward production

- Swap the simulator in `tick()` for a real ingestion endpoint (device webhook, MQTT
  broker, or OEM API) feeding the same vehicle state shape.
- Replace in-memory storage (`state.vehicles` / `state.trips` / `state.alerts`) with a
  database (PostgreSQL + PostGIS for geospatial queries, or a time-series store for
  trip data).
- Add authentication, multi-tenant fleet scoping, and role-based access.
- Add polygon geofences (currently circular), historical route playback, and
  maintenance/fuel-cost reporting to match the tender's full scope.
