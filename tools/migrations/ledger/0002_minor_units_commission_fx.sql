-- ledgerservice_db (Sprint 6): integer minor-unit accounting + commission
-- ledger + FX quotes + reserve release calendar (BRD §10 P6 + §12 P8).
--
-- BRD acceptance: "Total ledger debits must equal total credits for every
-- transaction group. Amounts are stored as amount_minor with currency exponent."
--
-- Additive: existing ledger_lines.amount keeps working for legacy rows; new
-- writes populate amount_minor (bigint) for the BRD-correct money invariant.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

ALTER TABLE ledger_lines ADD COLUMN IF NOT EXISTS amount_minor bigint;
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS total_debit_minor  bigint NOT NULL DEFAULT 0;
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS total_credit_minor bigint NOT NULL DEFAULT 0;
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS journal_type text;
  -- payment.success | reserve.release | dispute.open | dispute.won
  -- dispute.lost   | settlement.batch | refund | commission.payout
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS merchant_id text;

-- Commission ledger — every payment success that earns commission writes
-- an accrual row here; commission.payout journals later debit + clear.
CREATE TABLE IF NOT EXISTS commission_ledger (
  entry_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL DEFAULT 'tenant-default',
  merchant_id   text NOT NULL,
  provider_id   text,
  agent_id      text,
  txn_id        text NOT NULL,
  kind          text NOT NULL,         -- ACQUIRER | AGENT | PLATFORM
  rate_bps      integer NOT NULL DEFAULT 0,
  fixed_minor   bigint  NOT NULL DEFAULT 0,
  amount_minor  bigint  NOT NULL,
  currency      text    NOT NULL,
  journal_id    uuid REFERENCES journal_entries(id),
  status        text NOT NULL DEFAULT 'ACCRUED',   -- ACCRUED | PAID | REVERSED
  accrued_at    timestamptz NOT NULL DEFAULT now(),
  paid_at       timestamptz
);
CREATE INDEX IF NOT EXISTS commission_ledger_merchant_idx ON commission_ledger (merchant_id, accrued_at DESC);
CREATE INDEX IF NOT EXISTS commission_ledger_txn_idx ON commission_ledger (txn_id);

-- FX quotes (BRD §10: "FX quote capture").
CREATE TABLE IF NOT EXISTS fx_quotes (
  quote_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_currency text NOT NULL,
  target_currency text NOT NULL,
  rate_decimal    numeric(18,8) NOT NULL,
  spread_bps      integer NOT NULL DEFAULT 0,
  provider        text NOT NULL DEFAULT 'platform_oracle',
  quoted_at       timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT (now() + interval '5 minutes')
);
CREATE INDEX IF NOT EXISTS fx_quotes_pair_idx ON fx_quotes (source_currency, target_currency, quoted_at DESC);

-- Seed: a handful of synthetic quotes so the demo runs without a feed.
INSERT INTO fx_quotes (source_currency, target_currency, rate_decimal, spread_bps, provider) VALUES
  ('INR','USD', 0.01200, 30, 'platform_oracle'),
  ('USD','INR', 83.20000, 30, 'platform_oracle'),
  ('INR','EUR', 0.01100, 30, 'platform_oracle'),
  ('USDT','INR', 83.10000, 20, 'platform_oracle'),
  ('INR','USDT', 0.01203, 20, 'platform_oracle')
ON CONFLICT DO NOTHING;

-- Risk-tier reserve rules (BRD §12 P8 acceptance).
CREATE TABLE IF NOT EXISTS reserve_rules (
  rule_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  risk_tier            text NOT NULL,            -- LOW | MEDIUM | HIGH
  category             text,                     -- MCC bucket, NULL = any
  hold_bps             integer NOT NULL,         -- e.g. 500 = 5%
  release_after_days   integer NOT NULL DEFAULT 7,
  enabled              boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now()
);
INSERT INTO reserve_rules (risk_tier, hold_bps, release_after_days) VALUES
  ('LOW',    100,  3),
  ('MEDIUM', 500,  7),
  ('HIGH',  1000, 14)
ON CONFLICT DO NOTHING;

-- Reserve release calendar — generated when a hold is recorded.
-- Each row is an upcoming or executed release.
CREATE TABLE IF NOT EXISTS reserve_release_calendar (
  release_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id    text NOT NULL,
  reserve_hold_id uuid,
  amount_minor   bigint NOT NULL,
  currency       text NOT NULL,
  scheduled_at   timestamptz NOT NULL,
  status         text NOT NULL DEFAULT 'SCHEDULED',  -- SCHEDULED | RELEASED | EXTENDED | OVERRIDDEN | FORFEITED
  dispute_id     uuid,
  released_at    timestamptz,
  release_journal_id uuid,
  override_request_id uuid,
  notes          text
);
CREATE INDEX IF NOT EXISTS reserve_release_calendar_due_idx ON reserve_release_calendar (status, scheduled_at);
CREATE INDEX IF NOT EXISTS reserve_release_calendar_merchant_idx ON reserve_release_calendar (merchant_id, scheduled_at DESC);

ALTER TABLE reserve_ledger ADD COLUMN IF NOT EXISTS release_journal_id uuid;
ALTER TABLE reserve_ledger ADD COLUMN IF NOT EXISTS calendar_id uuid;
