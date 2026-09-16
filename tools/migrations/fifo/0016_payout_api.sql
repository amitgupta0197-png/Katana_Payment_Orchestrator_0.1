-- fifoservice_db: merchant-facing payout API (Key + Salt signed).
--
-- Re-runnable: every statement is IF [NOT] EXISTS. Apply after 0015.

-- The merchant's own reference for a beneficiary registered over the API. Unique per
-- merchant, so re-sending a registration returns the first one instead of a duplicate.
ALTER TABLE fifo_beneficiaries ADD COLUMN IF NOT EXISTS merchant_ref text;
CREATE UNIQUE INDEX IF NOT EXISTS fifo_beneficiaries_merchant_ref_uk
  ON fifo_beneficiaries (merchant_id, merchant_ref) WHERE merchant_ref IS NOT NULL;

-- The last payout status a signed callback was queued for. A payout gets at most one
-- callback per status (SUCCESS, then REVERSED if the bank returns it).
ALTER TABLE fifo_orders ADD COLUMN IF NOT EXISTS callback_status text;
