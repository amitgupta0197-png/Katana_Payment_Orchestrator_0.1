-- providerservice_db: DT Settlement Buffer ledger (final reserve model per product
-- decision 2026-07-16, superseding release-on-refill rotation).
--
-- The 40% "rolling reserve" is a pure SETTLEMENT BUFFER with one invariant:
--   Outstanding Buffer = Total DT Purchased (40% side) − Traffic Settled
-- A refill ADDS its 40% to the outstanding buffer — it never releases the old one.
-- Only completed settlement reconciliation reduces the buffer (FIFO across lots).
-- No risk/chargeback engine — deterministic accounting only.

CREATE TABLE IF NOT EXISTS settlement_buffer_ledger (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  banker_id              text NOT NULL,
  opening_buffer         numeric(18,2) NOT NULL,
  buffer_added           numeric(18,2) NOT NULL DEFAULT 0,   -- 40% of a new purchase/refill lot
  settlement_released    numeric(18,2) NOT NULL DEFAULT 0,   -- verified settlement reconciliation
  closing_buffer         numeric(18,2) NOT NULL,
  reference_purchase_id  uuid REFERENCES dt_purchases(id),
  reference_settlement   text,                               -- settlement ref / UTR
  note                   text,
  created_by             text,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS settlement_buffer_banker_idx
  ON settlement_buffer_ledger (banker_id, created_at DESC);
