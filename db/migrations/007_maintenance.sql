-- Maintenance: preventive-maintenance schedules (by distance and/or time,
-- measured against the telematics odometer), work orders with checklists,
-- costs and an activity log, and pre-start vehicle inspections. All rows are
-- org-scoped like the rest of the schema.

CREATE TABLE IF NOT EXISTS maintenance_schedules (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES organizations(id),
  vehicle_id     TEXT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  interval_km    INTEGER,
  interval_days  INTEGER,
  last_done_km   DOUBLE PRECISION,
  last_done_at   TIMESTAMPTZ,
  checklist      JSONB NOT NULL DEFAULT '[]'::jsonb,
  active         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (interval_km IS NOT NULL OR interval_days IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_mschedules_org_vehicle ON maintenance_schedules (org_id, vehicle_id);

CREATE SEQUENCE IF NOT EXISTS work_order_number_seq;

CREATE TABLE IF NOT EXISTS work_orders (
  id               TEXT PRIMARY KEY,
  number           BIGINT NOT NULL DEFAULT nextval('work_order_number_seq'),
  org_id           TEXT NOT NULL REFERENCES organizations(id),
  vehicle_id       TEXT REFERENCES vehicles(id) ON DELETE SET NULL,
  vehicle_label    TEXT,
  title            TEXT NOT NULL,
  description      TEXT,
  type             TEXT NOT NULL DEFAULT 'corrective',
  priority         TEXT NOT NULL DEFAULT 'medium',
  status           TEXT NOT NULL DEFAULT 'open',
  assignee         TEXT,
  due_date         DATE,
  schedule_id      TEXT REFERENCES maintenance_schedules(id) ON DELETE SET NULL,
  inspection_id    TEXT,
  alert_id         TEXT,
  out_of_service   BOOLEAN NOT NULL DEFAULT false,
  checklist        JSONB NOT NULL DEFAULT '[]'::jsonb,
  costs            JSONB NOT NULL DEFAULT '[]'::jsonb,
  completion_odometer_km DOUBLE PRECISION,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ,
  completed_by     TEXT,
  CHECK (type IN ('preventive', 'corrective', 'inspection', 'other')),
  CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  CHECK (status IN ('open', 'in_progress', 'on_hold', 'done', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS idx_work_orders_org_status ON work_orders (org_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_work_orders_org_vehicle ON work_orders (org_id, vehicle_id, created_at DESC);

CREATE TABLE IF NOT EXISTS work_order_events (
  id             BIGSERIAL PRIMARY KEY,
  work_order_id  TEXT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  org_id         TEXT NOT NULL,
  ts             TIMESTAMPTZ NOT NULL DEFAULT now(),
  username       TEXT,
  kind           TEXT NOT NULL,   -- created | status | comment | update
  detail         TEXT
);
CREATE INDEX IF NOT EXISTS idx_wo_events_wo ON work_order_events (work_order_id, ts);

CREATE TABLE IF NOT EXISTS inspections (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES organizations(id),
  vehicle_id     TEXT REFERENCES vehicles(id) ON DELETE SET NULL,
  vehicle_label  TEXT,
  ts             TIMESTAMPTZ NOT NULL DEFAULT now(),
  inspector      TEXT NOT NULL,
  odometer_km    DOUBLE PRECISION,
  results        JSONB NOT NULL,
  passed         BOOLEAN NOT NULL,
  notes          TEXT,
  created_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_inspections_org_ts ON inspections (org_id, ts DESC);
