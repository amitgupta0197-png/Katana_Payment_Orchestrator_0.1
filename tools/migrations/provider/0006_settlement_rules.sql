-- Katana settlement rule engine (Slice 2): versioned multi-layer commission rules and
-- the per-settlement charge snapshot.
--
-- RESOLUTION: the most SPECIFIC active rule wins —
--   (provider_id, merchant_key) > (provider_id, NULL) > (NULL, NULL global default).
-- VERSIONING: rules are never edited in place. Creating a new rule for the same scope
-- end-dates the previous one (effective_to = now()) and bumps version. Historical
-- settlements keep the rule snapshot they were raised with (charges jsonb + rule_id +
-- rule_version on the settlement row), so pricing changes never rewrite history.

CREATE TABLE IF NOT EXISTS provider_settlement_rules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id    uuid,                       -- NULL = every provider (global default)
  merchant_key   text,                       -- NULL = every branch of the provider
  -- charge layers, in basis points of the gross (100 bps = 1%)
  upline_bps     int     NOT NULL DEFAULT 0 CHECK (upline_bps   >= 0 AND upline_bps   <= 10000),
  katana_bps     int     NOT NULL DEFAULT 0 CHECK (katana_bps   >= 0 AND katana_bps   <= 10000),
  downline_bps   int     NOT NULL DEFAULT 0 CHECK (downline_bps >= 0 AND downline_bps <= 10000),
  fixed_fee      numeric NOT NULL DEFAULT 0 CHECK (fixed_fee >= 0),
  gst_bps        int     NOT NULL DEFAULT 0 CHECK (gst_bps >= 0 AND gst_bps <= 10000),  -- GST on the charges
  min_charge     numeric,                    -- clamp: total percentage+fixed charge floor
  max_charge     numeric,                    -- clamp: ceiling
  currency       text    NOT NULL DEFAULT 'INR',
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to   timestamptz,                -- NULL = open-ended
  version        int     NOT NULL DEFAULT 1,
  reason         text,                       -- why this pricing change (BRD-mandated)
  created_by     text,
  approved_by    text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_psr_scope ON provider_settlement_rules (provider_id, merchant_key, effective_from DESC);

-- Charge snapshot on each settlement: gross requested, the full deduction breakdown,
-- and the net the downline actually pays. `amount` (legacy) stays = gross for
-- back-compat with the outstanding calculation.
ALTER TABLE provider_branch_settlements
  ADD COLUMN IF NOT EXISTS gross_amount numeric,
  ADD COLUMN IF NOT EXISTS net_amount   numeric,
  ADD COLUMN IF NOT EXISTS charges      jsonb,
  ADD COLUMN IF NOT EXISTS rule_id      uuid,
  ADD COLUMN IF NOT EXISTS rule_version int;
