-- DT purchases are paid in USDT (flow clarification 2026-07-31): the merchant raises
-- the DT purchase, pays in USDT, and the BANKER approves that the USDT was accepted.
-- That approval is what activates the lot.
--
-- Records what the banker actually accepted, not what was expected — an under- or
-- over-payment is visible rather than silently assumed to match the INR advance.
--
-- Additive and idempotent. All columns nullable: existing lots were confirmed before
-- USDT capture existed, and a NULL means "no USDT detail recorded", never zero.

ALTER TABLE dt_purchases
  -- Which chain the USDT arrived on. Same three networks as provider_usdt_rates,
  -- constrained so a typo cannot create a fourth network that no rate card covers.
  ADD COLUMN IF NOT EXISTS usdt_network   text,
  -- USDT actually received by the banker (after any network fee).
  ADD COLUMN IF NOT EXISTS usdt_amount    numeric(18,6),
  -- INR per USDT applied at acceptance, snapshotted from provider_usdt_rates so a
  -- later rate change never re-values a lot that is already active.
  ADD COLUMN IF NOT EXISTS usdt_rate      numeric(18,4),
  -- INR equivalent of what was accepted = usdt_amount x usdt_rate. Stored rather than
  -- derived so reconciliation compares against the figure that was actually agreed.
  ADD COLUMN IF NOT EXISTS usdt_inr_value numeric(18,2),
  ADD COLUMN IF NOT EXISTS usdt_tx_hash   text,
  ADD COLUMN IF NOT EXISTS usdt_wallet    text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'dt_purchases_usdt_network_chk'
  ) THEN
    ALTER TABLE dt_purchases
      ADD CONSTRAINT dt_purchases_usdt_network_chk
      CHECK (usdt_network IS NULL OR usdt_network IN ('TRC20','ERC20','BEP20'));
  END IF;
END $$;

-- Same fields on refills: a refill is funded the same way.
ALTER TABLE dt_refill_requests
  ADD COLUMN IF NOT EXISTS usdt_network   text,
  ADD COLUMN IF NOT EXISTS usdt_amount    numeric(18,6),
  ADD COLUMN IF NOT EXISTS usdt_rate      numeric(18,4),
  ADD COLUMN IF NOT EXISTS usdt_inr_value numeric(18,2),
  ADD COLUMN IF NOT EXISTS usdt_tx_hash   text,
  ADD COLUMN IF NOT EXISTS usdt_wallet    text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'dt_refill_requests_usdt_network_chk'
  ) THEN
    ALTER TABLE dt_refill_requests
      ADD CONSTRAINT dt_refill_requests_usdt_network_chk
      CHECK (usdt_network IS NULL OR usdt_network IN ('TRC20','ERC20','BEP20'));
  END IF;
END $$;

-- A tx hash is the natural lookup key when reconciling an on-chain transfer against
-- a lot, and the support question is always "which lot was this hash?".
CREATE INDEX IF NOT EXISTS dt_purchases_usdt_tx_idx ON dt_purchases (usdt_tx_hash);
CREATE INDEX IF NOT EXISTS dt_refill_requests_usdt_tx_idx ON dt_refill_requests (usdt_tx_hash);
