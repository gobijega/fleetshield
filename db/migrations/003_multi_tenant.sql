-- Multi-tenant accounts + subscription billing
--
-- Each customer (council/utility/gov entity) that signs up gets its own
-- organization row, its own admin login, and its own isolated fleet data.
-- The pre-existing single-admin deployment (driven by ADMIN_USERNAME /
-- ADMIN_PASSWORD_HASH env vars) is preserved as a "default" organization so
-- the current live login and its existing vehicles/alerts/geofences keep
-- working unchanged after this migration runs.

CREATE TABLE IF NOT EXISTS organizations (
  id                      TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  contact_name            TEXT,
  contact_email           TEXT NOT NULL,
  admin_username          TEXT NOT NULL UNIQUE,
  admin_password_hash     TEXT NOT NULL,
  admin_totp_secret       TEXT,
  stripe_customer_id      TEXT,
  stripe_subscription_id  TEXT,
  stripe_sub_item_id      TEXT,
  subscription_status     TEXT NOT NULL DEFAULT 'incomplete'
                            CHECK (subscription_status IN
                              ('incomplete', 'trialing', 'active', 'past_due', 'canceled')),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the legacy single-admin deployment as a real organization row so
-- ADMIN_USERNAME/ADMIN_PASSWORD_HASH keep authenticating exactly as before.
-- server.js does this at boot (needs the live env var values, not available
-- to a static SQL migration), guarded by "ON CONFLICT DO NOTHING" there.

ALTER TABLE vehicles   ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'default' REFERENCES organizations(id);
ALTER TABLE geofences  ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'default' REFERENCES organizations(id);
ALTER TABLE alerts     ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'default' REFERENCES organizations(id);
ALTER TABLE audit_log  ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES organizations(id);

-- positions is a hypertable — denormalize org_id onto it directly (rather
-- than joining to vehicles on every tenant-scoped query) since it's the
-- highest-volume table by far.
ALTER TABLE positions  ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'default' REFERENCES organizations(id);

CREATE INDEX IF NOT EXISTS idx_vehicles_org    ON vehicles (org_id);
CREATE INDEX IF NOT EXISTS idx_geofences_org   ON geofences (org_id);
CREATE INDEX IF NOT EXISTS idx_alerts_org_ts   ON alerts (org_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_positions_org   ON positions (org_id, ts DESC);
