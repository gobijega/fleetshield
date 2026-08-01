-- Fleet Shield / Vehicle Telematics Solution — initial schema
-- Requires the TimescaleDB extension (pre-installed on Timescale Cloud;
-- available via the timescale/timescaledb-ha image for local/self-hosted use).

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Static fleet configuration -------------------------------------------------

CREATE TABLE IF NOT EXISTS vehicles (
  id                    TEXT PRIMARY KEY,
  label                 TEXT NOT NULL,
  driver                TEXT,
  route                 TEXT,
  speed_limit           INT,
  base_speed            INT,
  fuel_type             TEXT NOT NULL CHECK (fuel_type IN ('diesel', 'petrol', 'ev')),
  consumption_per_100   NUMERIC NOT NULL,
  idle_rate_per_hour    NUMERIC NOT NULL,
  starting_odometer_km  NUMERIC NOT NULL DEFAULT 0,
  rego_expiry_date      DATE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS geofences (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  radius_m    INT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'custom',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Time-series telemetry (hypertable) -----------------------------------------
-- One row per vehicle per tick. Cumulative columns (odometer/fuel/co2/moving
-- /idling/trip_count) let the app restore in-memory running totals on boot
-- by reading each vehicle's latest row, so a restart doesn't lose history.

CREATE TABLE IF NOT EXISTS positions (
  ts                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  vehicle_id          TEXT NOT NULL REFERENCES vehicles(id),
  lat                 DOUBLE PRECISION NOT NULL,
  lng                 DOUBLE PRECISION NOT NULL,
  speed_kmh           NUMERIC,
  heading_deg         NUMERIC,
  status              TEXT,
  odometer_km         NUMERIC,
  fuel_used_total     NUMERIC,
  co2_kg_total        NUMERIC,
  moving_sec_total    NUMERIC,
  idling_sec_total    NUMERIC,
  trip_count          INT
);

SELECT create_hypertable('positions', 'ts', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_positions_vehicle_ts ON positions (vehicle_id, ts DESC);

-- Alerts / driver-behaviour + compliance events ------------------------------

CREATE TABLE IF NOT EXISTS alerts (
  id            TEXT PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  vehicle_id    TEXT REFERENCES vehicles(id),
  vehicle_label TEXT,
  type          TEXT NOT NULL,
  severity      TEXT NOT NULL,
  message       TEXT,
  geofence_id   TEXT,
  lat           DOUBLE PRECISION,
  lng           DOUBLE PRECISION
);
CREATE INDEX IF NOT EXISTS idx_alerts_vehicle_ts ON alerts (vehicle_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts (ts DESC);

-- Optional: keep raw position history from growing unbounded on small/free-tier
-- databases. Safe to skip/adjust for a real deployment with more storage.
-- SELECT add_retention_policy('positions', INTERVAL '30 days');
