-- reconciliationservice_db (Sprint 7): break ageing + match-method tagging
-- (BRD §11 P7: "Each break has reason, owner, ageing bucket, expected action
-- and resolution audit").

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

ALTER TABLE recon_breaks ADD COLUMN IF NOT EXISTS ageing_bucket text;
  -- 0-24h | 1-3d | 3-7d | 7d+
ALTER TABLE recon_breaks ADD COLUMN IF NOT EXISTS expected_action text;
ALTER TABLE recon_breaks ADD COLUMN IF NOT EXISTS sla_breached_at timestamptz;
ALTER TABLE recon_breaks ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE recon_breaks ADD COLUMN IF NOT EXISTS resolved_by text;

ALTER TABLE recon_matches ADD COLUMN IF NOT EXISTS match_level integer NOT NULL DEFAULT 1;
  -- 1 = exact ref ; 2 = amount+date+merchant ; 3 = fuzzy within tolerance

CREATE INDEX IF NOT EXISTS recon_breaks_ageing_idx ON recon_breaks (ageing_bucket, status, opened_at);
CREATE INDEX IF NOT EXISTS recon_breaks_assignee_open_idx ON recon_breaks (assignee) WHERE status IN ('OPEN','INVESTIGATING');
