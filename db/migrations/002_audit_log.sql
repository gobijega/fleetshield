-- Security audit trail: login/MFA/logout events and admin data changes
-- (geofence create/delete). Small, append-only, no hypertable needed —
-- volume is orders of magnitude lower than the positions table.

CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type  TEXT NOT NULL,     -- login_success | login_failed | mfa_failed | logout | geofence_created | geofence_deleted
  username    TEXT,
  ip          TEXT,
  success     BOOLEAN NOT NULL DEFAULT true,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log (ts DESC);
