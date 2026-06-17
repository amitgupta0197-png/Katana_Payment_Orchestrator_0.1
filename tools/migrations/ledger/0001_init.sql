-- ledgerservice_db: rolling-reserve ledger (PRODUCT_VISION §3.8).
-- Schema reconstructed from the BFF query in
-- apps/admin-dashboard/src/app/api/reserves/route.ts.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS reserve_ledger (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        text NOT NULL DEFAULT 'tenant-default',
  merchant_id      text NOT NULL,
  source_order_id  text,
  hold_amount      numeric(18,6) NOT NULL DEFAULT 0,
  hold_percent_bps integer NOT NULL DEFAULT 0,
  held_at          timestamptz NOT NULL DEFAULT now(),
  release_date     timestamptz NOT NULL,
  release_status   text NOT NULL DEFAULT 'HELD',
    -- HELD | RELEASING | RELEASED | FORFEITED
  released_amount  numeric(18,6) NOT NULL DEFAULT 0,
  currency         text NOT NULL DEFAULT 'INR',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reserve_ledger_merchant_idx  ON reserve_ledger (tenant_id, merchant_id);
CREATE INDEX IF NOT EXISTS reserve_ledger_release_idx   ON reserve_ledger (release_date);
CREATE INDEX IF NOT EXISTS reserve_ledger_status_idx    ON reserve_ledger (release_status);
