-- fifoservice_db: settlement batches (BRD §19/§22), compliance case management
-- (§23). Recon adjustments reuse fifo_approvals (RECON_ADJUSTMENT) + the existing
-- fifo_recon_items.resolved flag, so they need no new table.

-- Settlement batch: nets a merchant's completed-but-unsettled pay-ins per §22.
CREATE TABLE IF NOT EXISTS fifo_settlement_batches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        text NOT NULL DEFAULT 'tenant-default',
  batch_ref        text NOT NULL UNIQUE,
  merchant_id      text NOT NULL,
  currency         text NOT NULL DEFAULT 'INR',
  order_count      integer NOT NULL DEFAULT 0,
  gross_minor      bigint NOT NULL DEFAULT 0,
  mdr_minor        bigint NOT NULL DEFAULT 0,
  reserve_minor    bigint NOT NULL DEFAULT 0,
  gst_minor        bigint NOT NULL DEFAULT 0,
  chargeback_hold_minor bigint NOT NULL DEFAULT 0,
  adjustment_minor bigint NOT NULL DEFAULT 0,   -- +/- approved manual adjustment
  net_minor        bigint NOT NULL DEFAULT 0,   -- disbursed to merchant
  status           text NOT NULL DEFAULT 'SETTLED'
                   CHECK (status IN ('PENDING_APPROVAL','SETTLED','REJECTED')),
  journal_id       text,
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  settled_at       timestamptz
);
CREATE INDEX IF NOT EXISTS fifo_settlement_batches_merchant_idx ON fifo_settlement_batches (merchant_id, created_at DESC);

ALTER TABLE fifo_orders ADD COLUMN IF NOT EXISTS settlement_batch_id uuid;

-- Compliance cases (§23 case management).
CREATE TABLE IF NOT EXISTS fifo_cases (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    text NOT NULL DEFAULT 'tenant-default',
  case_ref     text NOT NULL UNIQUE,
  subject      text NOT NULL,
  merchant_id  text,
  order_ref    text,
  severity     text NOT NULL DEFAULT 'MEDIUM' CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status       text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','INVESTIGATING','CLOSED')),
  opened_by    text,
  assigned_to  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz
);
CREATE INDEX IF NOT EXISTS fifo_cases_status_idx ON fifo_cases (status, created_at DESC);

CREATE TABLE IF NOT EXISTS fifo_case_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid NOT NULL REFERENCES fifo_cases(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'NOTE',   -- NOTE | EVIDENCE | ACTION
  body        text,
  evidence_ref text,                          -- order_ref / proof sha / evidence pack hash
  author      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fifo_case_notes_case_idx ON fifo_case_notes (case_id, created_at);
