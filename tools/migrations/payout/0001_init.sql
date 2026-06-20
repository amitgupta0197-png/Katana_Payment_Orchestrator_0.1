-- payoutservice_db: merchant settlement disbursements. This service DB had no
-- migration — settlement batches marked themselves SETTLED with no actual payout.
-- A payout is the operational record of moving net_amount to the merchant's bank
-- (rail + UTR); the ledger cash-out is already posted by lib/settlement.createBatch.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS payouts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           text NOT NULL DEFAULT 'tenant-default',
  merchant_id         text NOT NULL,
  settlement_batch_id uuid,
  amount_minor        bigint NOT NULL,
  currency            text NOT NULL DEFAULT 'INR',
  status              text NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','PROCESSING','PAID','FAILED')),
  rail                text,                 -- IMPS | NEFT | RTGS
  utr                 text,                 -- bank reference once disbursed
  beneficiary         text,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  processed_at        timestamptz
);

CREATE INDEX IF NOT EXISTS payouts_merchant_idx ON payouts (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payouts_status_idx   ON payouts (status, created_at DESC);
CREATE INDEX IF NOT EXISTS payouts_batch_idx    ON payouts (settlement_batch_id);
