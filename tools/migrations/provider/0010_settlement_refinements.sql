-- Settlement refinements (final BRD slice):
--   §14 downline capacity declaration, §8 lock/unlock + reassign support,
--   §4 priority / requested date / internal ref, §5 INVALID_BENEFICIARY status.

-- 1) Downline (branch) capacity declaration — one row per branch, self-declared.
CREATE TABLE IF NOT EXISTS provider_branch_capacity (
  merchant_key      text PRIMARY KEY,
  bank_available    boolean NOT NULL DEFAULT true,
  usdt_available    boolean NOT NULL DEFAULT false,
  usdt_quantity     numeric,                -- declared available USDT
  usdt_network      text,                   -- network the quantity is on
  daily_capacity    numeric,                -- ₹ the branch can settle per day
  unavailable_until timestamptz,            -- temporary unavailability window
  note              text,
  updated_by        text,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- 2) Settlement extras: admin lock, §4 request fields.
ALTER TABLE provider_branch_settlements
  ADD COLUMN IF NOT EXISTS locked         boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS priority       text NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH')),
  ADD COLUMN IF NOT EXISTS requested_date date,          -- upline's preferred settlement date
  ADD COLUMN IF NOT EXISTS internal_ref   text;          -- upline's own reference number

-- 3) INVALID_BENEFICIARY status (BRD §5 exception list).
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
    'CORRECTION_REQUIRED','ESCALATED','COMPLIANCE_REVIEW','INSUFFICIENT_BALANCE',
    'INVALID_BENEFICIARY','REVIEW','CANCELLED'
  ));
