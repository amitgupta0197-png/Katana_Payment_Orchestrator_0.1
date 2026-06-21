-- fifoservice_db: audit hash-chain (SEC-006), proof scan status (SEC-007),
-- merchant LOB/MCC allow-list (§27). SLA tracking reuses existing timestamps +
-- fifo_fraud_alerts; no new table needed for it.

-- Per-order tamper-evident hash chain on the event timeline.
ALTER TABLE fifo_order_events ADD COLUMN IF NOT EXISTS prev_hash  text;
ALTER TABLE fifo_order_events ADD COLUMN IF NOT EXISTS entry_hash text;

-- Proof file scan result (SEC-007).
ALTER TABLE fifo_order_proofs ADD COLUMN IF NOT EXISTS scan_status text NOT NULL DEFAULT 'PENDING';

-- Merchant approved line-of-business / MCC (§27 — purpose must match approved LOB).
CREATE TABLE IF NOT EXISTS fifo_merchant_lob (
  merchant_id      text PRIMARY KEY,
  allowed_purposes text[] NOT NULL DEFAULT '{}',
  mcc              text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
