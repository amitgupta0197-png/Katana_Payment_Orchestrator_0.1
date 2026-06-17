-- checkoutservice_db: payment attempts + state transitions (BRD §7 P3).
-- Additive — extends existing checkout_attempts with auth/exemption/timing
-- columns and adds an order_state_transitions log. The state machine is
-- enforced in the app (lib/payment-states.ts), so legacy INITIATED rows keep
-- working alongside the BRD states.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Minor-unit amount column (BRD §10 P6 prep). Nullable for now — new writes
-- populate it; old rows can be backfilled in Sprint 6.
ALTER TABLE checkout_orders ADD COLUMN IF NOT EXISTS amount_minor bigint;

-- Extend existing checkout_attempts with the fields BRD §7 requires
-- (auth status, challenge result, exemption reason, attempt no, response_time).
ALTER TABLE checkout_attempts ADD COLUMN IF NOT EXISTS attempt_no        integer;
ALTER TABLE checkout_attempts ADD COLUMN IF NOT EXISTS next_state        text;
ALTER TABLE checkout_attempts ADD COLUMN IF NOT EXISTS auth_status       text;
  -- FRICTIONLESS | CHALLENGE_REQUIRED | AUTHENTICATED | EXEMPTED | NOT_REQUIRED
ALTER TABLE checkout_attempts ADD COLUMN IF NOT EXISTS challenge_result  text;
  -- PASSED | FAILED | ABANDONED
ALTER TABLE checkout_attempts ADD COLUMN IF NOT EXISTS exemption_reason  text;
ALTER TABLE checkout_attempts ADD COLUMN IF NOT EXISTS response_time_ms  integer;
ALTER TABLE checkout_attempts ADD COLUMN IF NOT EXISTS raw_response      jsonb;

CREATE INDEX IF NOT EXISTS checkout_attempts_order_attempt_idx ON checkout_attempts (order_id, attempt_no);

-- Full state-transition log for forensic replay (BRD acceptance:
-- "route can be replayed for audit").
CREATE TABLE IF NOT EXISTS order_state_transitions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES checkout_orders(id) ON DELETE CASCADE,
  from_status  text,
  to_status    text NOT NULL,
  actor_kind   text NOT NULL,   -- system | callback | admin | customer
  actor_id     text,
  reason       text,
  payload      jsonb,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_state_transitions_order_idx ON order_state_transitions (order_id, occurred_at);
