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

-- Insert a placeholder 'default' organization row *before* the ALTER TABLE
-- statements below — those add org_id columns with DEFAULT 'default' AND a
-- foreign-key reference to organizations(id), and on a database that
-- already has real vehicles/geofences/alerts/positions rows (i.e. this
-- exact production deployment), Postgres validates that foreign key
-- immediately against every existing row. Without this insert, that
-- validation fails because 'default' doesn't exist in organizations yet
-- (it otherwise wouldn't exist until server.js's upsertDefaultOrg() runs at
-- boot, which is too late for a migration that runs before the app
-- starts). The placeholder admin_username/password_hash here are
-- immediately overwritten by upsertDefaultOrg() on first boot using the
-- real ADMIN_USERNAME/ADMIN_PASSWORD_HASH env vars — this row only needs
-- to satisfy NOT NULL/UNIQUE constraints for the brief window until then.
INSERT INTO organizations (id, name, contact_email, admin_username, admin_password_hash, subscription_status)
VALUES ('default', 'Fleet Shield (default)', 'hello@jegasec.com', 'default_org_pending_setup', 'pending', 'active')
ON CONFLICT (id) DO NOTHING;

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
