-- merchantservice_db: ONBOARDING — the KYB identifiers of a banker, the result of each
-- onboarding gate, and the history of its stage.
--
-- 1. The identifiers an application carries. They were only ever uploaded as documents; as
--    columns they can be checked (lib/kyc-validators) and, later, verified against a registry.
--    Aadhaar is never stored: only the last four digits, as the UIDAI rules allow.
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS gstin                   text;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS business_pan            text;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS director_name           text;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS director_pan            text;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS director_aadhaar_last4  text;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS est_monthly_volume      numeric(18,2);

DO $$ BEGIN
  ALTER TABLE merchants ADD CONSTRAINT merchants_aadhaar_last4_chk
    CHECK (director_aadhaar_last4 IS NULL OR director_aadhaar_last4 ~ '^[0-9]{4}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. One row per gate run (lib/onboarding-gates). A log: a gate run again adds a row, so what
--    was known at each step stays on record.
--      PASS    the check was made and is clear
--      REVIEW  the check could not clear it; a person decides
--      FAIL    the check found a reason to stop
CREATE TABLE IF NOT EXISTS merchant_onboarding_gates (
  id           bigserial PRIMARY KEY,
  merchant_id  uuid NOT NULL,
  gate         text NOT NULL,       -- APPLICATION | WEBSITE | DOCUMENTS | SCREENING
  result       text NOT NULL CHECK (result IN ('PASS','REVIEW','FAIL')),
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  operator     text NOT NULL DEFAULT 'SYSTEM',
  overridden_by text,               -- the person who let a FAIL through, when one did
  checked_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS merchant_onboarding_gates_merchant_idx ON merchant_onboarding_gates (merchant_id, checked_at DESC);

-- 3. Every stage a banker has been in. Written by a trigger, so a stage changed outside the
--    onboarding stepper (the profile API, a script) is recorded too. Append-only, and with no
--    foreign key: the history outlives a banker that is removed.
CREATE TABLE IF NOT EXISTS merchant_status_history (
  id             bigserial PRIMARY KEY,
  merchant_id    uuid NOT NULL,
  merchant_code  text,
  from_stage     text,
  to_stage       text NOT NULL,
  changed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS merchant_status_history_merchant_idx ON merchant_status_history (merchant_id, changed_at);

CREATE OR REPLACE FUNCTION merchant_stage_log() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.stage IS NOT DISTINCT FROM OLD.stage THEN RETURN NULL; END IF;
  BEGIN
    INSERT INTO merchant_status_history (merchant_id, merchant_code, from_stage, to_stage)
    VALUES (NEW.id, NEW.merchant_code, CASE WHEN TG_OP = 'UPDATE' THEN OLD.stage END, NEW.stage);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'merchant_stage_log: merchant % not logged: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS merchant_stage_log_trg ON merchants;
CREATE TRIGGER merchant_stage_log_trg
  AFTER INSERT OR UPDATE ON merchants
  FOR EACH ROW EXECUTE FUNCTION merchant_stage_log();

CREATE OR REPLACE FUNCTION merchant_status_history_locked() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'merchant_status_history is append-only';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS merchant_status_history_locked_trg ON merchant_status_history;
CREATE TRIGGER merchant_status_history_locked_trg
  BEFORE UPDATE OR DELETE ON merchant_status_history
  FOR EACH ROW EXECUTE FUNCTION merchant_status_history_locked();

-- Bankers that exist already get one row: the stage they are in now.
INSERT INTO merchant_status_history (merchant_id, merchant_code, from_stage, to_stage, changed_at)
SELECT m.id, m.merchant_code, NULL, m.stage, m.updated_at
  FROM merchants m
 WHERE NOT EXISTS (SELECT 1 FROM merchant_status_history h WHERE h.merchant_id = m.id);
