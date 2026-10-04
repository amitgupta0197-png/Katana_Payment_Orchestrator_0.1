-- merchantservice_db: the chain a banker's MIDs come from. Bank → TSP → Banker.
--
-- A BANK issues MIDs. A TSP (technology service provider: the payment aggregator, gateway or
-- acquiring-bank arm the bank issues them through) carries them to bankers. A banker records
-- which TSP it is on and which bank issued its MIDs, and each MID it was issued (flow, value,
-- dates, limits) is entered by one person and approved by another (lib/maker-checker).
--
-- Staff only. A TSP is a payment gateway's company: its name never reaches a merchant
-- (CLAUDE.md, "never name a payment gateway to a merchant").
--
-- Additive: new tables, nullable columns on merchants, one stage added to its check. Nothing
-- that routes money reads these tables; the MID switch (vendorGateway payin_mids) still decides
-- which processor account takes an order.

-- 1. Bank master.
CREATE TABLE IF NOT EXISTS banks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                text NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_]{1,19}$'),  -- e.g. HDFC (IFSC prefix)
  name                text NOT NULL,
  bank_type           text NOT NULL CHECK (bank_type IN ('PUBLIC','PRIVATE','COOPERATIVE','FOREIGN','SMALL_FINANCE','PAYMENTS')),
  settlement_account  text,           -- sealed (lib/sealed-text); never searched in SQL
  neft_enabled        boolean NOT NULL DEFAULT true,
  imps_enabled        boolean NOT NULL DEFAULT true,
  upi_enabled         boolean NOT NULL DEFAULT true,
  contact_email       text,
  status              text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_by          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- 2. TSP master. Its onboarding: APPLICATION → KYB_PENDING → SCREENING → BANK_VERIFY → CONFIG
--    → LIVE (lib/tsp.ts). Going live, suspending and reactivating need a second person.
CREATE TABLE IF NOT EXISTS tsps (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                     text NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_]{1,19}$'),
  name                     text NOT NULL,
  legal_name               text,
  tsp_type                 text NOT NULL CHECK (tsp_type IN ('PAYMENT_AGGREGATOR','PAYMENT_GATEWAY','ACQUIRING_BANK_ARM')),
  gateway_code             text,      -- the pay-in / payout connector it runs, when Katana has one (lib/pg-catalog)
  rbi_licence_no           text,
  pci_dss_cert_no          text,
  primary_contact_name     text,
  primary_contact_email    text,
  primary_contact_phone    text,
  compliance_officer_name  text,
  compliance_officer_email text,
  allowed_flows            text[] NOT NULL DEFAULT '{}',   -- INTENT | P2P | PAYOUT
  max_mids_per_banker      integer CHECK (max_mids_per_banker IS NULL OR max_mids_per_banker > 0),
  max_bankers              integer CHECK (max_bankers IS NULL OR max_bankers > 0),
  stage                    text NOT NULL DEFAULT 'APPLICATION'
                           CHECK (stage IN ('APPLICATION','KYB_PENDING','SCREENING','BANK_VERIFY','CONFIG','LIVE','SUSPENDED','REJECTED')),
  screening_result         text CHECK (screening_result IN ('CLEAR','REVIEW','HIT')),
  screened_by              text,
  screened_at              timestamptz,
  notes                    text,
  created_by               text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tsps_allowed_flows_chk CHECK (allowed_flows <@ ARRAY['INTENT','P2P','PAYOUT']::text[])
);

-- 3. Which banks a TSP issues MIDs for. CONFIRMED = the bank confirmed the TSP's authority.
CREATE TABLE IF NOT EXISTS tsp_banks (
  tsp_id        uuid NOT NULL REFERENCES tsps(id),
  bank_id       uuid NOT NULL REFERENCES banks(id),
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CONFIRMED','ENDED')),
  reference     text,           -- the bank's letter / agreement reference
  confirmed_by  text,
  confirmed_at  timestamptz,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tsp_id, bank_id)
);

-- 4. A TSP's KYB documents. Same storage and hardening as merchant_kyb_documents.
CREATE TABLE IF NOT EXISTS tsp_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tsp_id        uuid NOT NULL REFERENCES tsps(id),
  doc_type      text NOT NULL,   -- INCORPORATION | RBI_LICENCE | PCI_DSS | BOARD_RESOLUTION | BANK_AUTHORISATION | OTHER
  filename      text,
  content_type  text NOT NULL,
  size_bytes    bigint NOT NULL,
  sha256        text NOT NULL,
  storage_ref   text NOT NULL,
  review       text NOT NULL DEFAULT 'PENDING' CHECK (review IN ('PENDING','APPROVED','REJECTED')),
  reviewed_by   text,
  reviewed_at   timestamptz,
  review_note   text,
  uploaded_by   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tsp_documents_tsp_idx ON tsp_documents (tsp_id, created_at DESC);

-- 5. Every stage a TSP has been in. Trigger-written and append-only, like merchant_status_history.
CREATE TABLE IF NOT EXISTS tsp_stage_history (
  id          bigserial PRIMARY KEY,
  tsp_id      uuid NOT NULL,
  from_stage  text,
  to_stage    text NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tsp_stage_history_tsp_idx ON tsp_stage_history (tsp_id, changed_at);

CREATE OR REPLACE FUNCTION tsp_stage_log() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.stage IS NOT DISTINCT FROM OLD.stage THEN RETURN NULL; END IF;
  INSERT INTO tsp_stage_history (tsp_id, from_stage, to_stage)
  VALUES (NEW.id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.stage END, NEW.stage);
  RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS tsp_stage_log_trg ON tsps;
CREATE TRIGGER tsp_stage_log_trg AFTER INSERT OR UPDATE ON tsps FOR EACH ROW EXECUTE FUNCTION tsp_stage_log();

-- 6. The banker's place in the chain, and the new onboarding step.
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS parent_tsp_id     uuid REFERENCES tsps(id);
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS issuing_bank_id   uuid REFERENCES banks(id);
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS step_mid_issuance boolean NOT NULL DEFAULT false;

-- MID_ISSUANCE sits between BANK_VERIFY and CONFIG. Only widens the check.
ALTER TABLE merchants DROP CONSTRAINT IF EXISTS merchants_stage_check;
ALTER TABLE merchants ADD CONSTRAINT merchants_stage_check
  CHECK (stage IN ('APPLICATION','DOCS_PENDING','SCREENING','BANK_VERIFY','MID_ISSUANCE','CONFIG','IN_REVIEW','APPROVED','LIVE','SUSPENDED','TERMINATED','REJECTED'));

-- Bankers already past bank verification went on without this step: it is marked done for
-- them, so the stepper does not ask them back to a stage they have left. Their MIDs can still
-- be recorded at any time; nothing about them changes.
UPDATE merchants SET step_mid_issuance = true
 WHERE step_mid_issuance = false
   AND stage IN ('CONFIG','IN_REVIEW','APPROVED','LIVE','SUSPENDED','TERMINATED');

-- 7. MIDs a bank issued to a banker. Entered PENDING_APPROVAL by one person, made ACTIVE by
--    another through Maker-Checker (`mid.issue`); ACTIVE → INACTIVE the same way (`mid.deactivate`).
CREATE TABLE IF NOT EXISTS issued_mids (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id     uuid NOT NULL REFERENCES merchants(id),
  tsp_id          uuid NOT NULL REFERENCES tsps(id),
  bank_id         uuid NOT NULL REFERENCES banks(id),
  flow            text NOT NULL CHECK (flow IN ('INTENT','P2P','PAYOUT')),
  mid_value       text NOT NULL,
  issued_on       date,
  expires_on      date,
  daily_limit     numeric(18,2) CHECK (daily_limit IS NULL OR daily_limit > 0),
  monthly_limit   numeric(18,2) CHECK (monthly_limit IS NULL OR monthly_limit > 0),
  currency        text NOT NULL DEFAULT 'INR',
  status          text NOT NULL DEFAULT 'PENDING_APPROVAL'
                  CHECK (status IN ('PENDING_APPROVAL','ACTIVE','INACTIVE','REJECTED')),
  request_id      uuid,          -- the open maker_checker_requests row (providerservice_db)
  requested_by    text NOT NULL,
  decided_by      text,
  decided_at      timestamptz,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT issued_mids_dates_chk CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on >= issued_on)
);
CREATE INDEX IF NOT EXISTS issued_mids_merchant_idx ON issued_mids (merchant_id, created_at DESC);
-- One TSP never has the same MID live twice.
CREATE UNIQUE INDEX IF NOT EXISTS issued_mids_tsp_value_uk
  ON issued_mids (tsp_id, mid_value) WHERE status IN ('PENDING_APPROVAL','ACTIVE');

-- Every status a MID has had. Trigger-written, append-only.
CREATE TABLE IF NOT EXISTS issued_mid_events (
  id           bigserial PRIMARY KEY,
  mid_id       uuid NOT NULL,
  merchant_id  uuid NOT NULL,
  from_status  text,
  to_status    text NOT NULL,
  actor        text,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS issued_mid_events_mid_idx ON issued_mid_events (mid_id, at);

CREATE OR REPLACE FUNCTION issued_mid_log() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NULL; END IF;
  INSERT INTO issued_mid_events (mid_id, merchant_id, from_status, to_status, actor)
  VALUES (NEW.id, NEW.merchant_id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status,
          CASE WHEN TG_OP = 'UPDATE' THEN NEW.decided_by ELSE NEW.requested_by END);
  RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS issued_mid_log_trg ON issued_mids;
CREATE TRIGGER issued_mid_log_trg AFTER INSERT OR UPDATE ON issued_mids FOR EACH ROW EXECUTE FUNCTION issued_mid_log();

CREATE OR REPLACE FUNCTION chain_history_locked() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS tsp_stage_history_locked_trg ON tsp_stage_history;
CREATE TRIGGER tsp_stage_history_locked_trg BEFORE UPDATE OR DELETE ON tsp_stage_history
  FOR EACH ROW EXECUTE FUNCTION chain_history_locked();
DROP TRIGGER IF EXISTS issued_mid_events_locked_trg ON issued_mid_events;
CREATE TRIGGER issued_mid_events_locked_trg BEFORE UPDATE OR DELETE ON issued_mid_events
  FOR EACH ROW EXECUTE FUNCTION chain_history_locked();
