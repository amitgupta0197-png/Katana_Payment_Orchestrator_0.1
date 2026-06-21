-- fifoservice_db: reconciliation runs + mismatch buckets (BRD §21, AC-007).
-- A run compares completed FIFO orders against the ledger (and an optional
-- gateway/bank/USDT report) and classifies each into a bucket. Manual fixes go
-- through the existing fifo_approvals maker-checker (action_type RECON_ADJUSTMENT).

CREATE TABLE IF NOT EXISTS fifo_recon_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL DEFAULT 'tenant-default',
  source        text NOT NULL DEFAULT 'LEDGER',   -- LEDGER | GATEWAY | BANK | USDT
  total_items   integer NOT NULL DEFAULT 0,
  matched       integer NOT NULL DEFAULT 0,
  mismatched    integer NOT NULL DEFAULT 0,
  summary       jsonb,                             -- bucket -> count
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fifo_recon_runs_idx ON fifo_recon_runs (created_at DESC);

CREATE TABLE IF NOT EXISTS fifo_recon_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid NOT NULL REFERENCES fifo_recon_runs(id) ON DELETE CASCADE,
  order_ref       text,
  txn_ref         text,
  utr             text,
  direction       text,
  expected_minor  bigint,
  reported_minor  bigint,
  bucket          text NOT NULL,   -- MATCHED | AMOUNT_MISMATCH | DUPLICATE_UTR | MISSING_CALLBACK | DELAYED_SETTLEMENT | FAILED_PAYOUT_DEBIT | UNMATCHED
  detail          text,
  resolved        boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fifo_recon_items_run_idx ON fifo_recon_items (run_id, bucket);
