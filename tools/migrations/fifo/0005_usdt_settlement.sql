-- fifoservice_db: USDT settlement controls (BRD §11.C, §22, FR-008).
-- Rate is captured + locked with a source/timestamp at payout creation; the
-- computed USDT amount is stored. Network is validated against a whitelist and
-- the wallet must be an APPROVED beneficiary. tx_hash (already on fifo_orders)
-- is required to complete a USDT transfer.

ALTER TABLE fifo_orders ADD COLUMN IF NOT EXISTS usdt_network        text;
ALTER TABLE fifo_orders ADD COLUMN IF NOT EXISTS usdt_rate           numeric;   -- INR per 1 USDT
ALTER TABLE fifo_orders ADD COLUMN IF NOT EXISTS usdt_rate_source    text;
ALTER TABLE fifo_orders ADD COLUMN IF NOT EXISTS usdt_rate_locked_at timestamptz;
ALTER TABLE fifo_orders ADD COLUMN IF NOT EXISTS usdt_amount         numeric;   -- USDT major units
