-- checkoutservice_db: BASE table for payment attempts (reconstructed).
--
-- The original CREATE for checkout_attempts was lost in the 2026 wipe; only
-- the additive migration 0001_payment_state_machine.sql survived, and it does
-- `ALTER TABLE checkout_attempts ADD COLUMN ...` against a table that no longer
-- exists. This file re-creates the ORIGINAL base table so 0001 can apply.
--
-- Columns here are derived from the queries that read/write checkout_attempts:
--   * apps/admin-dashboard/src/app/api/checkout/route.ts        (INSERT)
--   * apps/admin-dashboard/src/app/api/checkout/[id]/route.ts   (SELECT)
--   * apps/admin-dashboard/src/lib/slo.ts                       (SELECT)
--
-- The columns that 0001 adds via ADD COLUMN IF NOT EXISTS
--   (attempt_no, next_state, auth_status, challenge_result,
--    exemption_reason, response_time_ms, raw_response)
-- are intentionally NOT created here — 0001 owns them.
--
-- Runs before 0001. Idempotent (CREATE TABLE IF NOT EXISTS).

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- checkout_orders is assumed to pre-exist in this DB (it survived the wipe and
-- the index below references it). It is NOT created here.

CREATE TABLE IF NOT EXISTS checkout_attempts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid NOT NULL REFERENCES checkout_orders(id) ON DELETE CASCADE,
  rail_provider  text NOT NULL,
  rail_method    text NOT NULL,
  status         text NOT NULL,
  rail_ref       text,
  error_code     text,
  error_message  text,
  started_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz
);

CREATE INDEX IF NOT EXISTS checkout_attempts_order_idx ON checkout_attempts (order_id, started_at);
