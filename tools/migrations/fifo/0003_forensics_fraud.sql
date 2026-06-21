-- fifoservice_db: fraud alerts (BRD §23/§24, AC-008) + forensic evidence pack
-- registry (BRD §25/§30, FR-010). The pack itself is assembled on demand from
-- existing tables; this registry just records each generation + its report hash
-- so the evidence is itself tamper-evident.

CREATE TABLE IF NOT EXISTS fifo_fraud_alerts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL DEFAULT 'tenant-default',
  order_id      uuid,
  order_ref     text,
  merchant_id   text,
  alert_type    text NOT NULL,        -- DUPLICATE_UTR | VELOCITY | WALLET_CHANGE | OPERATOR_RISK | HIGH_VALUE
  severity      text NOT NULL DEFAULT 'MEDIUM' CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  detail        text,
  payload       jsonb,
  status        text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','REVIEWING','CLEARED','CONFIRMED')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fifo_fraud_alerts_order_idx ON fifo_fraud_alerts (order_id, created_at);
CREATE INDEX IF NOT EXISTS fifo_fraud_alerts_type_idx  ON fifo_fraud_alerts (alert_type, status, created_at DESC);

CREATE TABLE IF NOT EXISTS fifo_evidence_packs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL DEFAULT 'tenant-default',
  order_id      uuid NOT NULL,
  order_ref     text,
  report_hash   text NOT NULL,        -- SHA-256 over the canonical pack JSON
  section_count integer,
  generated_by  text,
  generated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fifo_evidence_packs_order_idx ON fifo_evidence_packs (order_id, generated_at DESC);
