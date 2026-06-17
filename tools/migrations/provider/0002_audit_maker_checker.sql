-- providerservice_db: extend provider_audit_logs with hash + maker-checker queue.
-- BRD §4 (P0): "every action creates an audit event" and "Provider cannot
-- approve own KYC" — sensitive decisions require a second pair of eyes.
--
-- provider_audit_logs already exists (schema reconstructed by older migration);
-- this migration is additive — adds a tamper-evident hash column and the
-- maker_checker_requests queue.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Tamper-evident hash column (optional — empty for legacy rows).
ALTER TABLE provider_audit_logs ADD COLUMN IF NOT EXISTS hash text;

-- Maker-checker queue.
CREATE TABLE IF NOT EXISTS maker_checker_requests (
  request_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      text NOT NULL DEFAULT 'tenant-default',
  resource_type  text NOT NULL,
    -- provider | merchant | sub_mid
  resource_id    text NOT NULL,
  action         text NOT NULL,
    -- provider.kyc.approve | provider.kyc.reject | provider.status.terminate
    -- merchant.advance.live | submid.settlement.enable
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  maker_id       text NOT NULL,
  maker_email    text,
  status         text NOT NULL DEFAULT 'PENDING',
    -- PENDING | APPROVED | REJECTED | EXPIRED
  checker_id     text,
  checker_email  text,
  decision_notes text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  decided_at     timestamptz
);
CREATE INDEX IF NOT EXISTS maker_checker_status_idx   ON maker_checker_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS maker_checker_resource_idx ON maker_checker_requests (resource_type, resource_id, created_at DESC);
