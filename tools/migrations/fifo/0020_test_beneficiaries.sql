-- fifoservice_db: test beneficiaries for the payout sandbox (lib/payout-providers/sandbox).
--
-- A beneficiary registered with a TEST key is approved at once and can only ever receive test
-- payouts; one registered with a live key (or by staff) waits for Katana's approval as before.
-- The two are separate, like test and live orders: the same beneficiary_ref may exist once in
-- each mode.
--
-- Re-runnable. Apply after 0019, before the code that reads `livemode`.

BEGIN;

ALTER TABLE fifo_beneficiaries ADD COLUMN IF NOT EXISTS livemode boolean NOT NULL DEFAULT true;

CREATE UNIQUE INDEX IF NOT EXISTS fifo_beneficiaries_merchant_ref_mode_uk
  ON fifo_beneficiaries (merchant_id, merchant_ref, livemode) WHERE merchant_ref IS NOT NULL;
DROP INDEX IF EXISTS fifo_beneficiaries_merchant_ref_uk;

COMMIT;
