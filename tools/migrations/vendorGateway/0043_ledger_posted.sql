-- vendorgatewayservice_db: which paid pay-ins are on the ledger (Settlement Engine, lib/ledger-sync).
-- ledger-sync posts each live, paid pay-in once (idempotency key payin:<id>) and stamps it here, so
-- a run only reads what is new. A crash between the post and the stamp is harmless: the next run
-- posts again and the ledger answers with the same journal.
ALTER TABLE vendor_payin_orders ADD COLUMN IF NOT EXISTS ledger_posted_at timestamptz;
CREATE INDEX IF NOT EXISTS vendor_payin_orders_ledger_todo_idx
  ON vendor_payin_orders (created_at)
  WHERE ledger_posted_at IS NULL AND livemode AND status IN ('SUCCESS','SUCCEEDED');
