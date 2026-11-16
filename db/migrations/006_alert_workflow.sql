-- Alert triage workflow: each alert can be acknowledged and resolved, with
-- who did it, when, how it was resolved and a note. Status changes are also
-- written to audit_log (alert_acknowledged / alert_resolved / alert_reopened).

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS status          TEXT NOT NULL DEFAULT 'open';
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS acknowledged_by TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS resolved_at     TIMESTAMPTZ;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS resolved_by     TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS resolution      TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS note            TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alerts_status_check') THEN
    ALTER TABLE alerts ADD CONSTRAINT alerts_status_check
      CHECK (status IN ('open', 'acknowledged', 'resolved'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_alerts_org_status_ts ON alerts (org_id, status, ts DESC);
