# Vehicle Telematics Solution — MVP

A working demo of the software layer behind a fleet telematics platform: live vehicle
tracking, driver-behaviour alerts, geofencing/compliance, and fleet reporting. Vehicle
GPS data is simulated (10 vehicles moving on routes around Melbourne, VIC) so the whole
stack runs standalone with no hardware or device integration required — the ingestion
layer is the one piece that would be swapped for a real device/API feed in production.

## What it demonstrates

- **Live map** — vehicle positions update in real time over WebSocket, colour-coded by
  status (moving / idling), with per-vehicle detail popups.
- **Driver behaviour & alerts** — harsh braking, harsh acceleration, speeding, and
  excessive idling events are detected and streamed live, with a filterable alerts log.
- **Geofencing & compliance** — depot and restricted zones with entry/exit alerts;
  add or remove zones from the UI.
- **Fleet reporting** — summary KPIs (distance, average speed, idle vehicles, alert
  counts), charts, and a per-vehicle breakdown.

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
| GET | `/api/reports/summary` | Fleet KPIs, alert counts, per-vehicle stats |

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
