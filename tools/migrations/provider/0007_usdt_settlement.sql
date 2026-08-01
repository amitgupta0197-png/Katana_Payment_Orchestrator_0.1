-- USDT settlement (Slice 3): daily rate management, USDT request fields on
-- settlements, the USDT_TRANSFERRED status, and human-readable request refs.

-- 1) Daily USDT settlement rates, declared by Katana admin per network. The newest
--    ACTIVE row (effective_from <= now < expiry) per network is the applicable rate;
--    the rate is LOCKED onto the settlement at request creation.
CREATE TABLE IF NOT EXISTS provider_usdt_rates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  network         text NOT NULL CHECK (network IN ('TRC20','ERC20','BEP20')),
  market_rate     numeric,                    -- reference market rate (info)
  buy_rate        numeric,
  sell_rate       numeric,
  settlement_rate numeric NOT NULL CHECK (settlement_rate > 0),   -- INR per USDT used for settlement
  katana_spread   numeric NOT NULL DEFAULT 0, -- info: spread baked into settlement_rate
  downline_spread numeric NOT NULL DEFAULT 0,
  network_fee     numeric NOT NULL DEFAULT 0, -- flat USDT fee deducted from quantity
  effective_from  timestamptz NOT NULL DEFAULT now(),
  expiry_at       timestamptz,                -- NULL = until superseded
  created_by      text,
  approved_by     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pur_net ON provider_usdt_rates (network, effective_from DESC);

-- 2) USDT + reference fields on settlements.
ALTER TABLE provider_branch_settlements
  ADD COLUMN IF NOT EXISTS settle_mode    text NOT NULL DEFAULT 'BANK' CHECK (settle_mode IN ('BANK','USDT')),
  ADD COLUMN IF NOT EXISTS usdt_network   text,
  ADD COLUMN IF NOT EXISTS wallet_address text,
  ADD COLUMN IF NOT EXISTS usdt_rate      numeric,     -- INR/USDT locked at request creation
  ADD COLUMN IF NOT EXISTS usdt_quantity  numeric,     -- final quantity after network fee
  ADD COLUMN IF NOT EXISTS usdt_fee       numeric,     -- network fee (USDT)
  ADD COLUMN IF NOT EXISTS tx_hash        text,        -- blockchain transaction hash
  ADD COLUMN IF NOT EXISTS request_ref    text;        -- human ref: KTN-SET-000245

-- 3) USDT_TRANSFERRED status (downline/Katana moved the coins; hash attached).
DO $$
BEGIN
  ALTER TABLE provider_branch_settlements DROP CONSTRAINT IF EXISTS provider_branch_settlements_status_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
ALTER TABLE provider_branch_settlements
  ADD CONSTRAINT provider_branch_settlements_status_check
  CHECK (status IN (
    'DRAFT','REQUESTED','ACCEPTED','PROCESSING','PAID','PARTIALLY_PAID','UTR_SUBMITTED',
    'USDT_TRANSFERRED','VERIFIED','RECONCILED','REJECTED','ON_HOLD','FAILED','REVERSED',
    'CORRECTION_REQUIRED','ESCALATED','COMPLIANCE_REVIEW','INSUFFICIENT_BALANCE','REVIEW','CANCELLED'
  ));

-- 4) Human-readable request refs: sequential KTN-SET-000001… Backfill existing rows in
--    created_at order, then future rows take the next value at insert time.
CREATE SEQUENCE IF NOT EXISTS settlement_ref_seq;
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM provider_branch_settlements WHERE request_ref IS NULL ORDER BY created_at
  LOOP
    UPDATE provider_branch_settlements
       SET request_ref = 'KTN-SET-' || lpad(nextval('settlement_ref_seq')::text, 6, '0')
     WHERE id = r.id;
  END LOOP;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pbs_ref ON provider_branch_settlements (request_ref);
