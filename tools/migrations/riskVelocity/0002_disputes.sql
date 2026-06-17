-- riskvelocityservice_db (Sprint 6): formal dispute lifecycle (BRD §10 P6).
-- The existing chargebacks table tracks chargeback events; this layer adds
-- the BRD state machine + evidence trail required for representment.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS disputes (
  dispute_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      text NOT NULL DEFAULT 'tenant-default',
  txn_id         text NOT NULL,
  order_id       uuid,
  merchant_id    text NOT NULL,
  reason_code    text NOT NULL,
    -- 10.4 fraud | 12.5 incorrect_amount | 13.1 service_not_received | etc.
  amount_minor   bigint NOT NULL,
  currency       text NOT NULL,
  status         text NOT NULL DEFAULT 'DISPUTE_OPEN',
    -- DISPUTE_OPEN | REPRESENTMENT | ACCEPTED | WON | LOST | EXPIRED
  deadline_at    timestamptz,
  hold_journal_id     uuid,
  resolution_journal_id uuid,
  opened_at      timestamptz NOT NULL DEFAULT now(),
  opened_by      text,
  resolved_at    timestamptz,
  resolved_by    text,
  resolution_notes text
);
CREATE INDEX IF NOT EXISTS disputes_status_idx ON disputes (status, opened_at DESC);
CREATE INDEX IF NOT EXISTS disputes_merchant_idx ON disputes (merchant_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS disputes_txn_idx ON disputes (txn_id);

CREATE TABLE IF NOT EXISTS dispute_evidence (
  evidence_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id     uuid NOT NULL REFERENCES disputes(dispute_id) ON DELETE CASCADE,
  evidence_type  text NOT NULL,
    -- receipt | shipping_proof | customer_correspondence | ip_log | id_match
  file_url       text,
  notes          text,
  submitted_by   text,
  submitted_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dispute_evidence_dispute_idx ON dispute_evidence (dispute_id);
