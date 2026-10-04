-- settlementservice_db: the Settlement Engine, phase 1 (lib/settlement-engine, -store).
-- Additive and re-runnable. Amounts are paise (bigint). A banker is its merchant_code; its
-- merchant is a providers row (provider_id).
--
--   settlement_configs            versioned, two-person: DRAFT → PENDING_APPROVAL → ACTIVE (one per
--                                 banker) → SUPERSEDED; REJECTED. The checker is never the maker.
--   settlement_controls           pause a banker's settlement (operator override).
--   settlement_instructions       one settlement: amounts, the config version it ran under, state.
--   settlement_instruction_events every state change, written by a trigger; append-only.
--   settlement_reserve_holds      rolling reserve withheld by an instruction, and its release.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS settlement_configs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  banker_code  text NOT NULL,
  provider_id  uuid,
  version      int  NOT NULL,
  state        text NOT NULL CHECK (state IN ('DRAFT','PENDING_APPROVAL','ACTIVE','SUPERSEDED','REJECTED')),
  body         jsonb NOT NULL,
  maker        text NOT NULL,
  maker_note   text,
  checker      text,
  checker_note text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  effective_from timestamptz,
  UNIQUE (banker_code, version),
  CHECK (checker IS NULL OR checker <> maker)
);
CREATE UNIQUE INDEX IF NOT EXISTS settlement_configs_one_active ON settlement_configs (banker_code) WHERE state = 'ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS settlement_configs_one_pending ON settlement_configs (banker_code) WHERE state = 'PENDING_APPROVAL';

CREATE TABLE IF NOT EXISTS settlement_controls (
  banker_code text PRIMARY KEY,
  paused      boolean NOT NULL DEFAULT false,
  reason      text,
  set_by      text,
  set_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settlement_instructions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  banker_code     text NOT NULL,
  provider_id     uuid,
  kind            text NOT NULL CHECK (kind IN ('SCHEDULED','ON_DEMAND','MANUAL')),
  cycle_key       text,
  cutoff_at       timestamptz,
  config_id       uuid REFERENCES settlement_configs(id),
  config_version  int,
  currency        text NOT NULL DEFAULT 'INR',
  gross_minor     bigint NOT NULL CHECK (gross_minor > 0),
  reserve_minor   bigint NOT NULL DEFAULT 0,
  upline_minor    bigint NOT NULL DEFAULT 0,
  katana_minor    bigint NOT NULL DEFAULT 0,
  downline_minor  bigint NOT NULL DEFAULT 0,
  fixed_minor     bigint NOT NULL DEFAULT 0,
  gst_minor       bigint NOT NULL DEFAULT 0,
  tds_minor       bigint NOT NULL DEFAULT 0,
  net_minor       bigint NOT NULL CHECK (net_minor > 0),
  rule_id         uuid,
  rule_version    int,
  beneficiary_id  uuid,
  transfer_mode   text,
  state           text NOT NULL DEFAULT 'PENDING'
                  CHECK (state IN ('PENDING','INITIATED','IN_TRANSIT','SETTLED','FAILED','REVERSED','HELD','CANCELLED')),
  held_from       text,
  branch_settlement_id uuid,          -- providerservice_db.provider_branch_settlements.id
  utr             text,
  reason          text,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (gross_minor - reserve_minor - (upline_minor + katana_minor + downline_minor + fixed_minor) - gst_minor + tds_minor = net_minor)
);
CREATE INDEX IF NOT EXISTS settlement_instructions_banker_idx ON settlement_instructions (banker_code, created_at DESC);
CREATE INDEX IF NOT EXISTS settlement_instructions_state_idx ON settlement_instructions (state) WHERE state NOT IN ('SETTLED','FAILED','REVERSED','CANCELLED');
CREATE INDEX IF NOT EXISTS settlement_instructions_branch_idx ON settlement_instructions (branch_settlement_id);

CREATE TABLE IF NOT EXISTS settlement_instruction_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instruction_id uuid NOT NULL REFERENCES settlement_instructions(id),
  from_state     text,
  to_state       text NOT NULL,
  actor          text,
  reason         text,
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS settlement_instruction_events_idx ON settlement_instruction_events (instruction_id, id);

-- The event log is written by this trigger only, from the instruction row itself: the actor and
-- reason are the row's `updated_by` session values (set by the store with SET LOCAL).
CREATE OR REPLACE FUNCTION settlement_instruction_event() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.state IS DISTINCT FROM OLD.state THEN
    INSERT INTO settlement_instruction_events (instruction_id, from_state, to_state, actor, reason)
    VALUES (NEW.id, CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.state END, NEW.state,
            COALESCE(NULLIF(current_setting('settlement.actor', true), ''), NEW.created_by),
            NULLIF(current_setting('settlement.reason', true), ''));
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS settlement_instruction_event_trg ON settlement_instructions;
CREATE TRIGGER settlement_instruction_event_trg AFTER INSERT OR UPDATE OF state ON settlement_instructions
  FOR EACH ROW EXECUTE FUNCTION settlement_instruction_event();

CREATE OR REPLACE FUNCTION settlement_events_locked() RETURNS trigger AS $$
BEGIN
  IF current_setting('settlement.maintenance', true) = 'on' THEN RETURN COALESCE(NEW, OLD); END IF;
  RAISE EXCEPTION 'settlement_instruction_events is append-only' USING ERRCODE = 'check_violation';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS settlement_events_locked_trg ON settlement_instruction_events;
CREATE TRIGGER settlement_events_locked_trg BEFORE UPDATE OR DELETE ON settlement_instruction_events
  FOR EACH ROW EXECUTE FUNCTION settlement_events_locked();

CREATE TABLE IF NOT EXISTS settlement_reserve_holds (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instruction_id uuid NOT NULL UNIQUE REFERENCES settlement_instructions(id),
  banker_code    text NOT NULL,
  amount_minor   bigint NOT NULL CHECK (amount_minor > 0),
  release_at     timestamptz NOT NULL,
  state          text NOT NULL DEFAULT 'HELD' CHECK (state IN ('HELD','RELEASED','CANCELLED')),
  released_at    timestamptz
);
CREATE INDEX IF NOT EXISTS settlement_reserve_holds_due_idx ON settlement_reserve_holds (release_at) WHERE state = 'HELD';
