-- fifoservice_db: provider-executed payouts (PayU Payouts first).
--
-- Until now every payout was paid by an operator by hand and closed with a UTR. A payout
-- with provider='PAYU' skips the operator queue: Katana sends it to the merchant's own PayU
-- Payouts account and PayU reports the result.
--
--   QUEUED -> SUBMITTED   the transfer request was sent to the provider
--   SUBMITTED -> COMPLETED | FAILED   the provider's answer, confirmed by a status lookup
--   COMPLETED -> REVERSED   the bank returned the money after paying it
--
-- Re-runnable: every statement is IF [NOT] EXISTS.

ALTER TABLE fifo_orders ADD COLUMN IF NOT EXISTS provider            text;         -- NULL = operator-paid; 'PAYU'
ALTER TABLE fifo_orders ADD COLUMN IF NOT EXISTS payout_rail         text
  CHECK (payout_rail IN ('IMPS','NEFT','RTGS','UPI'));
ALTER TABLE fifo_orders ADD COLUMN IF NOT EXISTS provider_ref        text;         -- PayU payuRefId / payuTransactionRefNo
ALTER TABLE fifo_orders ADD COLUMN IF NOT EXISTS provider_status     text;         -- PayU's last txnStatus, verbatim
ALTER TABLE fifo_orders ADD COLUMN IF NOT EXISTS provider_checked_at timestamptz;  -- last status lookup (sweep throttle)
ALTER TABLE fifo_orders ADD COLUMN IF NOT EXISTS submitted_at        timestamptz;
ALTER TABLE fifo_orders ADD COLUMN IF NOT EXISTS failure_reason      text;
-- The merchant's own reference for the payout. Unique per merchant, so a retried request
-- returns the first payout instead of paying twice.
ALTER TABLE fifo_orders ADD COLUMN IF NOT EXISTS merchant_txn_id     text;
-- Existing orders are real money, so they default to live. A PayU payout takes its value
-- from the PayU environment (UAT = test).
ALTER TABLE fifo_orders ADD COLUMN IF NOT EXISTS livemode            boolean NOT NULL DEFAULT true;

CREATE UNIQUE INDEX IF NOT EXISTS fifo_orders_merchant_txn_uk
  ON fifo_orders (merchant_id, merchant_txn_id) WHERE merchant_txn_id IS NOT NULL;
-- The PayU webhook finds the order by merchantReferenceId, which is our txn_ref.
CREATE INDEX IF NOT EXISTS fifo_orders_txn_ref_idx ON fifo_orders (txn_ref);
CREATE INDEX IF NOT EXISTS fifo_orders_provider_inflight_idx
  ON fifo_orders (submitted_at) WHERE provider IS NOT NULL AND status = 'SUBMITTED';

ALTER TABLE fifo_orders DROP CONSTRAINT IF EXISTS fifo_orders_status_check;
ALTER TABLE fifo_orders ADD CONSTRAINT fifo_orders_status_check
  CHECK (status IN ('CREATED','VALIDATED','QUEUED','ASSIGNED','ACCEPTED','PROCESSING',
                    'PROOF_UPLOADED','COMPLETED','SETTLED','REJECTED','FAILED','HOLD','DISPUTE',
                    'REFUND','CANCELLED','SUBMITTED','REVERSED'));
