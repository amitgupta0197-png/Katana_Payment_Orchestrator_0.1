-- Settlement state machine + immutable status timeline (Upline↔Downline control).
--
-- Extends the provider↔branch settlement (0004) from a 6-status flow into the full
-- BRD bank-settlement lifecycle, adds an append-only per-transition timeline, and the
-- mandatory-data columns the richer statuses require. Backward compatible: the existing
-- REQUESTED / UTR_SUBMITTED / VERIFIED / REJECTED / REVIEW / CANCELLED rows stay valid.
--
-- Bank flow (happy path):
--   REQUESTED → ACCEPTED → PROCESSING → PAID → VERIFIED (upline confirm) → RECONCILED
-- Legacy shortcut REQUESTED → UTR_SUBMITTED → VERIFIED is preserved.
-- Exceptions: REJECTED, ON_HOLD, FAILED, PARTIALLY_PAID, REVERSED, CORRECTION_REQUIRED,
--             ESCALATED, COMPLIANCE_REVIEW, INSUFFICIENT_BALANCE, REVIEW, CANCELLED, DRAFT.

-- 1) Widen the status CHECK to the full lifecycle. Drop the old constraint by its
--    generated name if present, then add the superset (idempotent-safe).
DO $$
BEGIN
  ALTER TABLE provider_branch_settlements DROP CONSTRAINT IF EXISTS provider_branch_settlements_status_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE provider_branch_settlements
  ADD CONSTRAINT provider_branch_settlements_status_check
  CHECK (status IN (
    'DRAFT','REQUESTED','ACCEPTED','PROCESSING','PAID','PARTIALLY_PAID','UTR_SUBMITTED',
    'VERIFIED','RECONCILED','REJECTED','ON_HOLD','FAILED','REVERSED','CORRECTION_REQUIRED',
    'ESCALATED','COMPLIANCE_REVIEW','INSUFFICIENT_BALANCE','REVIEW','CANCELLED'
  ));

-- 2) Mandatory-data + lifecycle columns for the richer statuses. `details` holds the
--    per-transition payload (payment_mode, source_bank, failure_reason, …); the most
--    queried fields are also first-class columns.
ALTER TABLE provider_branch_settlements
  ADD COLUMN IF NOT EXISTS paid_amount    numeric,
  ADD COLUMN IF NOT EXISTS payment_mode   text,
  ADD COLUMN IF NOT EXISTS payment_date   date,
  ADD COLUMN IF NOT EXISTS receipt_uri    text,
  ADD COLUMN IF NOT EXISTS source_bank    text,
  ADD COLUMN IF NOT EXISTS failure_reason text,
  ADD COLUMN IF NOT EXISTS details        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS accepted_by    text,
  ADD COLUMN IF NOT EXISTS accepted_at    timestamptz,
  ADD COLUMN IF NOT EXISTS paid_at        timestamptz,
  ADD COLUMN IF NOT EXISTS confirmed_by   text,
  ADD COLUMN IF NOT EXISTS confirmed_at   timestamptz,
  ADD COLUMN IF NOT EXISTS reconciled_by  text,
  ADD COLUMN IF NOT EXISTS reconciled_at  timestamptz;

-- 3) Immutable status timeline — one append-only row per transition. This is the audit
--    source of truth for "who moved it from X to Y, when, why, with what evidence".
CREATE TABLE IF NOT EXISTS provider_settlement_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id uuid NOT NULL REFERENCES provider_branch_settlements(id) ON DELETE CASCADE,
  provider_id   uuid NOT NULL,
  action        text NOT NULL,           -- canonical action key (ACCEPT, MARK_PAID, CONFIRM, …)
  from_status   text,
  to_status     text NOT NULL,
  actor         text,                    -- actor email
  actor_role    text,                    -- UPLINE | DOWNLINE | ADMIN
  remarks       text,
  details       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pse_settlement ON provider_settlement_events (settlement_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pse_provider   ON provider_settlement_events (provider_id, created_at DESC);
