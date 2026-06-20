-- settlementservice_db: settlement batches (BRD §10 P6).
-- This service DB had NO migration at all — the table lib/settlement.createBatch()
-- writes to never existed on the live stack, so settlement was non-functional.
-- Canonical schema below; lib/settlement.ts (writer) and api/settlement/batches
-- (reader) are aligned to these column names.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS settlement_batches (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      text NOT NULL DEFAULT 'tenant-default',
  merchant_id    text NOT NULL,
  batch_date     date NOT NULL,                 -- settlement cycle date
  period_start   timestamptz,
  period_end     timestamptz,
  currency       text NOT NULL DEFAULT 'INR',
  txn_count      integer NOT NULL DEFAULT 0,
  gross_amount   bigint  NOT NULL DEFAULT 0,    -- minor units, gross payin volume
  fee_amount     bigint  NOT NULL DEFAULT 0,    -- minor units, platform MDR
  reserve_amount bigint  NOT NULL DEFAULT 0,    -- minor units, reserve held
  net_amount     bigint  NOT NULL DEFAULT 0,    -- minor units, net payable to merchant
  status         text NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('PENDING','SETTLED','EMPTY','PROCESSING','PAID','COMPLETED','FAILED')),
  utr            text,                          -- bank UTR once disbursed
  payout_ref     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  UNIQUE (tenant_id, merchant_id, batch_date, currency)
);

CREATE INDEX IF NOT EXISTS settlement_batches_merchant_idx ON settlement_batches (merchant_id, batch_date DESC);
CREATE INDEX IF NOT EXISTS settlement_batches_status_idx   ON settlement_batches (status, batch_date DESC);
