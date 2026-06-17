-- auditservice_db: WORM (write-once / append-only) audit log.
-- BRD §15 + §17: hash-chained, tamper-evident, retained for disputes.
--
-- Chain rule: each row's `hash` = sha256(prev_hash || canonical(row)).
-- UPDATE and DELETE are denied at the table level via a rule, so even a
-- compromised app user cannot rewrite history.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS worm_audit_log (
  log_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL DEFAULT 'tenant-default',
  actor_id        text,
  actor_email     text,
  action          text NOT NULL,            -- e.g. provider.kyc.approve, merchant.advance
  resource_type   text NOT NULL,
  resource_id     text NOT NULL,
  before_value    jsonb,
  after_value     jsonb,
  notes           text,
  prev_hash       text NOT NULL DEFAULT '',
  hash            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS worm_audit_log_resource_idx ON worm_audit_log (resource_type, resource_id, created_at DESC);
CREATE INDEX IF NOT EXISTS worm_audit_log_actor_idx    ON worm_audit_log (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS worm_audit_log_action_idx   ON worm_audit_log (action, created_at DESC);
CREATE INDEX IF NOT EXISTS worm_audit_log_time_idx     ON worm_audit_log (created_at DESC);

-- Append-only enforcement. CREATE OR REPLACE keeps this idempotent.
CREATE OR REPLACE RULE worm_audit_log_no_update AS
  ON UPDATE TO worm_audit_log DO INSTEAD NOTHING;
CREATE OR REPLACE RULE worm_audit_log_no_delete AS
  ON DELETE TO worm_audit_log DO INSTEAD NOTHING;

-- Convenience: chain head for fast "what's the latest hash" lookup.
CREATE TABLE IF NOT EXISTS worm_audit_chain_head (
  tenant_id   text PRIMARY KEY,
  last_hash   text NOT NULL,
  last_log_id uuid NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
