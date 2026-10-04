-- merchantservice_db: Master Data Management (lib/mdm.ts rules, lib/mdm-store.ts storage).
--
-- Each master type (BANK, TSP, BANKER, MERCHANT, CHANNEL) has a template: its field schema.
-- The core fields are the real table columns and are locked (lib/mdm.ts CORE); staff may add
-- optional custom fields, whose values are kept in each master table's `extra jsonb` column:
-- banks, tsps, merchants here; providers in provider 0022; rails in routingEngine 0005.
-- The templates and the change log for every type live here.
--
-- A template change is a new version, approved by a second person (Maker-Checker
-- `mdm.template_update`). Every template change and every custom value change is written to
-- mdm_change_log (append-only, trigger-locked) and to the WORM audit log.
--
-- Additive and idempotent: new tables, `extra` columns defaulting to '{}'. Nothing that routes
-- money reads them.

ALTER TABLE banks     ADD COLUMN IF NOT EXISTS extra jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tsps      ADD COLUMN IF NOT EXISTS extra jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS extra jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS mdm_templates (
  type             text PRIMARY KEY CHECK (type IN ('BANK','TSP','BANKER','MERCHANT','CHANNEL')),
  current_version  integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mdm_template_versions (
  type         text NOT NULL REFERENCES mdm_templates(type),
  version      integer NOT NULL CHECK (version >= 1),
  fields       jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'array'),
  created_by   text NOT NULL,
  approved_by  text,
  request_id   uuid,            -- the maker_checker_requests row (providerservice_db) that approved it
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (type, version)
);

-- Every template change and every custom value change. Append-only.
CREATE TABLE IF NOT EXISTS mdm_change_log (
  id           bigserial PRIMARY KEY,
  master_type  text NOT NULL CHECK (master_type IN ('BANK','TSP','BANKER','MERCHANT','CHANNEL')),
  record_id    text,            -- NULL for a template change
  kind         text NOT NULL CHECK (kind IN ('TEMPLATE_PROPOSED','TEMPLATE_APPLIED','TEMPLATE_REJECTED','EXTRA_SET','EXTRA_PROPOSED','EXTRA_REJECTED')),
  version      integer,         -- the template version in force (or applied)
  field_key    text,
  before       jsonb,
  after        jsonb,
  actor        text NOT NULL,
  request_id   text,
  notes        text,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mdm_change_log_record_idx ON mdm_change_log (master_type, record_id, at DESC);
CREATE INDEX IF NOT EXISTS mdm_change_log_type_idx ON mdm_change_log (master_type, at DESC);

CREATE OR REPLACE FUNCTION mdm_change_log_locked() RETURNS trigger AS $$
BEGIN
  -- Local test cleanup only: SET LOCAL mdm.maintenance = 'on' (as ledger.maintenance, ledger 0004).
  IF current_setting('mdm.maintenance', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'mdm_change_log is append-only';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS mdm_change_log_locked_trg ON mdm_change_log;
CREATE TRIGGER mdm_change_log_locked_trg BEFORE UPDATE OR DELETE ON mdm_change_log
  FOR EACH ROW EXECUTE FUNCTION mdm_change_log_locked();
DROP TRIGGER IF EXISTS mdm_change_log_truncate_trg ON mdm_change_log;
CREATE TRIGGER mdm_change_log_truncate_trg BEFORE TRUNCATE ON mdm_change_log
  FOR EACH STATEMENT EXECUTE FUNCTION mdm_change_log_locked();

-- A version, once written, is never changed.
CREATE OR REPLACE FUNCTION mdm_template_versions_locked() RETURNS trigger AS $$
BEGIN
  -- Local test cleanup only: SET LOCAL mdm.maintenance = 'on' (as ledger.maintenance, ledger 0004).
  IF current_setting('mdm.maintenance', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'mdm_template_versions is append-only';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS mdm_template_versions_locked_trg ON mdm_template_versions;
CREATE TRIGGER mdm_template_versions_locked_trg BEFORE UPDATE OR DELETE ON mdm_template_versions
  FOR EACH ROW EXECUTE FUNCTION mdm_template_versions_locked();

-- Version 1 of each template: the core fields only (lib/mdm.ts CORE at the time of writing).
INSERT INTO mdm_templates (type, current_version)
VALUES ('BANK', 1), ('TSP', 1), ('BANKER', 1), ('MERCHANT', 1), ('CHANNEL', 1)
ON CONFLICT (type) DO NOTHING;

INSERT INTO mdm_template_versions (type, version, fields, created_by, approved_by) VALUES
  ('BANK', 1, $j$[{"key":"id","label":"ID","type":"uuid","required":true,"core":true,"notes":"Primary key"},{"key":"code","label":"Code","type":"string","required":true,"core":true,"notes":"Unique; ^[A-Z][A-Z0-9_]{1,19}$ (IFSC prefix)"},{"key":"name","label":"Name","type":"string","required":true,"core":true},{"key":"bank_type","label":"Bank type","type":"enum","required":true,"core":true,"options":["PUBLIC","PRIVATE","COOPERATIVE","FOREIGN","SMALL_FINANCE","PAYMENTS"]},{"key":"settlement_account","label":"Settlement account","type":"string","required":false,"core":true,"sensitive":true,"notes":"Sealed (lib/sealed-text); never searched in SQL"},{"key":"neft_enabled","label":"NEFT enabled","type":"boolean","required":true,"core":true,"notes":"Default true"},{"key":"imps_enabled","label":"IMPS enabled","type":"boolean","required":true,"core":true,"notes":"Default true"},{"key":"upi_enabled","label":"UPI enabled","type":"boolean","required":true,"core":true,"notes":"Default true"},{"key":"contact_email","label":"Contact email","type":"email","required":false,"core":true},{"key":"status","label":"Status","type":"enum","required":true,"core":true,"options":["ACTIVE","INACTIVE"],"notes":"Default ACTIVE"},{"key":"created_by","label":"Created by","type":"string","required":false,"core":true},{"key":"created_at","label":"Created at","type":"timestamp","required":true,"core":true},{"key":"updated_at","label":"Updated at","type":"timestamp","required":true,"core":true}]$j$::jsonb, 'migration', 'migration'),
  ('TSP', 1, $j$[{"key":"id","label":"ID","type":"uuid","required":true,"core":true,"notes":"Primary key"},{"key":"code","label":"Code","type":"string","required":true,"core":true,"notes":"Unique; ^[A-Z][A-Z0-9_]{1,19}$"},{"key":"name","label":"Name","type":"string","required":true,"core":true},{"key":"legal_name","label":"Legal name","type":"string","required":false,"core":true},{"key":"tsp_type","label":"TSP type","type":"enum","required":true,"core":true,"options":["PAYMENT_AGGREGATOR","PAYMENT_GATEWAY","ACQUIRING_BANK_ARM"]},{"key":"gateway_code","label":"Gateway code","type":"string","required":false,"core":true,"notes":"Connector it runs (lib/pg-catalog)"},{"key":"rbi_licence_no","label":"RBI licence no.","type":"string","required":false,"core":true},{"key":"pci_dss_cert_no","label":"PCI DSS certificate no.","type":"string","required":false,"core":true},{"key":"primary_contact_name","label":"Primary contact","type":"string","required":false,"core":true},{"key":"primary_contact_email","label":"Primary contact email","type":"email","required":false,"core":true},{"key":"primary_contact_phone","label":"Primary contact phone","type":"string","required":false,"core":true},{"key":"compliance_officer_name","label":"Compliance officer","type":"string","required":false,"core":true},{"key":"compliance_officer_email","label":"Compliance officer email","type":"email","required":false,"core":true},{"key":"allowed_flows","label":"Allowed flows","type":"list","required":true,"core":true,"options":["INTENT","P2P","PAYOUT"],"notes":"Default empty"},{"key":"max_mids_per_banker","label":"Max MIDs per banker","type":"number","required":false,"core":true,"min":1},{"key":"max_bankers","label":"Max bankers","type":"number","required":false,"core":true,"min":1},{"key":"stage","label":"Stage","type":"enum","required":true,"core":true,"options":["APPLICATION","KYB_PENDING","SCREENING","BANK_VERIFY","CONFIG","LIVE","SUSPENDED","REJECTED"],"notes":"Moved by the onboarding steps; LIVE / SUSPENDED through Maker-Checker"},{"key":"screening_result","label":"Screening result","type":"enum","required":false,"core":true,"options":["CLEAR","REVIEW","HIT"]},{"key":"screened_by","label":"Screened by","type":"string","required":false,"core":true},{"key":"screened_at","label":"Screened at","type":"timestamp","required":false,"core":true},{"key":"notes","label":"Notes","type":"string","required":false,"core":true},{"key":"created_by","label":"Created by","type":"string","required":false,"core":true},{"key":"created_at","label":"Created at","type":"timestamp","required":true,"core":true},{"key":"updated_at","label":"Updated at","type":"timestamp","required":true,"core":true}]$j$::jsonb, 'migration', 'migration'),
  ('BANKER', 1, $j$[{"key":"id","label":"ID","type":"uuid","required":true,"core":true,"notes":"Primary key"},{"key":"tenant_id","label":"Tenant","type":"string","required":true,"core":true,"notes":"Default tenant-default"},{"key":"merchant_code","label":"Banker code","type":"string","required":true,"core":true,"notes":"Unique"},{"key":"legal_name","label":"Legal name","type":"string","required":true,"core":true},{"key":"brand_name","label":"Brand name","type":"string","required":false,"core":true},{"key":"business_type","label":"Business type","type":"string","required":false,"core":true},{"key":"category_mcc","label":"Category (MCC)","type":"string","required":false,"core":true},{"key":"contact_email","label":"Contact email","type":"email","required":true,"core":true},{"key":"contact_phone","label":"Contact phone","type":"string","required":false,"core":true},{"key":"website","label":"Website","type":"url","required":false,"core":true},{"key":"registered_address","label":"Registered address","type":"string","required":false,"core":true},{"key":"stage","label":"Stage","type":"enum","required":true,"core":true,"options":["APPLICATION","DOCS_PENDING","SCREENING","BANK_VERIFY","MID_ISSUANCE","CONFIG","IN_REVIEW","APPROVED","LIVE","SUSPENDED","TERMINATED","REJECTED"],"notes":"Moved by the onboarding steps"},{"key":"risk_tier","label":"Risk tier","type":"string","required":false,"core":true},{"key":"step_application","label":"Step: application","type":"boolean","required":true,"core":true},{"key":"step_kyb_docs","label":"Step: KYB documents","type":"boolean","required":true,"core":true},{"key":"step_screening","label":"Step: screening","type":"boolean","required":true,"core":true},{"key":"step_bank_verify","label":"Step: bank verification","type":"boolean","required":true,"core":true},{"key":"step_config","label":"Step: configuration","type":"boolean","required":true,"core":true},{"key":"step_approval","label":"Step: approval","type":"boolean","required":true,"core":true},{"key":"approved_at","label":"Approved at","type":"timestamp","required":false,"core":true},{"key":"approved_by","label":"Approved by","type":"string","required":false,"core":true},{"key":"created_at","label":"Created at","type":"timestamp","required":true,"core":true},{"key":"updated_at","label":"Updated at","type":"timestamp","required":true,"core":true},{"key":"webhook_url","label":"Callback URL","type":"url","required":false,"core":true},{"key":"return_url","label":"Return URL","type":"url","required":false,"core":true},{"key":"webhook_slug","label":"Webhook slug","type":"string","required":false,"core":true},{"key":"gstin","label":"GSTIN","type":"string","required":false,"core":true},{"key":"business_pan","label":"Business PAN","type":"string","required":false,"core":true,"sensitive":true},{"key":"director_name","label":"Director name","type":"string","required":false,"core":true},{"key":"director_pan","label":"Director PAN","type":"string","required":false,"core":true,"sensitive":true},{"key":"director_aadhaar_last4","label":"Director Aadhaar (last 4)","type":"string","required":false,"core":true,"sensitive":true},{"key":"est_monthly_volume","label":"Estimated monthly volume","type":"number","required":false,"core":true},{"key":"webhook_version","label":"Webhook version","type":"enum","required":true,"core":true,"options":["v1","v2"]},{"key":"webhook_events","label":"Webhook events","type":"enum","required":true,"core":true,"options":["ALL","PAID_ONLY"]},{"key":"webhook_secret","label":"Webhook signing secret","type":"string","required":false,"core":true,"sensitive":true,"notes":"Sealed (lib/sealed-text)"},{"key":"webhook_version_set_by","label":"Webhook version set by","type":"string","required":false,"core":true},{"key":"webhook_version_set_at","label":"Webhook version set at","type":"timestamp","required":false,"core":true},{"key":"parent_tsp_id","label":"TSP","type":"uuid","required":false,"core":true,"notes":"tsps.id (merchant 0018)"},{"key":"issuing_bank_id","label":"Issuing bank","type":"uuid","required":false,"core":true,"notes":"banks.id (merchant 0018)"},{"key":"step_mid_issuance","label":"Step: MID issuance","type":"boolean","required":true,"core":true}]$j$::jsonb, 'migration', 'migration'),
  ('MERCHANT', 1, $j$[{"key":"id","label":"ID","type":"uuid","required":true,"core":true,"notes":"Primary key"},{"key":"tenant_id","label":"Tenant","type":"string","required":true,"core":true,"notes":"Default tenant-default"},{"key":"code","label":"Merchant code","type":"string","required":true,"core":true,"notes":"Unique (lib/merchant-code)"},{"key":"legal_name","label":"Legal name","type":"string","required":true,"core":true},{"key":"contact_email","label":"Contact email","type":"email","required":true,"core":true},{"key":"contact_phone","label":"Contact phone","type":"string","required":false,"core":true},{"key":"kind","label":"Kind","type":"string","required":true,"core":true,"notes":"Default PROVIDER"},{"key":"kyc_status","label":"KYC status","type":"string","required":true,"core":true,"notes":"Default PENDING; changed through Maker-Checker"},{"key":"status","label":"Status","type":"string","required":true,"core":true,"notes":"Default ACTIVE; changed through Maker-Checker"},{"key":"settlement_currency","label":"Settlement currency","type":"string","required":true,"core":true,"notes":"Default INR"},{"key":"bank_account_no","label":"Bank account number","type":"string","required":false,"core":true,"sensitive":true,"notes":"Sealed (lib/sealed-text)"},{"key":"bank_ifsc","label":"Bank IFSC","type":"string","required":false,"core":true},{"key":"low_balance_threshold","label":"Low balance threshold","type":"number","required":false,"core":true},{"key":"created_at","label":"Created at","type":"timestamp","required":true,"core":true},{"key":"updated_at","label":"Updated at","type":"timestamp","required":true,"core":true},{"key":"payin_flow","label":"Pay-in flow","type":"enum","required":true,"core":true,"options":["UNSET","P2P","INTENT","BOTH"],"notes":"lib/payin-flow"},{"key":"payin_active_flow","label":"Default flow","type":"enum","required":false,"core":true,"options":["P2P","INTENT"]},{"key":"payin_flow_set_by","label":"Flow set by","type":"string","required":false,"core":true},{"key":"payin_flow_set_at","label":"Flow set at","type":"timestamp","required":false,"core":true},{"key":"services","label":"Services","type":"enum","required":true,"core":true,"options":["UNSET","PAYIN","PAYOUT","BOTH"],"notes":"lib/merchant-services"},{"key":"services_set_by","label":"Services set by","type":"string","required":false,"core":true},{"key":"services_set_at","label":"Services set at","type":"timestamp","required":false,"core":true}]$j$::jsonb, 'migration', 'migration'),
  ('CHANNEL', 1, $j$[{"key":"id","label":"ID","type":"uuid","required":true,"core":true,"notes":"Primary key"},{"key":"provider","label":"Provider","type":"string","required":true,"core":true,"notes":"Unique with method + direction"},{"key":"method","label":"Method","type":"string","required":true,"core":true},{"key":"direction","label":"Direction","type":"enum","required":true,"core":true,"options":["PAYIN","PAYOUT"],"notes":"Default PAYIN"},{"key":"enabled","label":"Enabled","type":"boolean","required":true,"core":true,"notes":"Default true"},{"key":"weight","label":"Weight","type":"number","required":true,"core":true,"notes":"Default 100"},{"key":"mdr_bps","label":"MDR (bps)","type":"number","required":true,"core":true,"notes":"Default 0"},{"key":"created_at","label":"Created at","type":"timestamp","required":true,"core":true},{"key":"kill_switch","label":"Kill switch","type":"boolean","required":true,"core":true,"notes":"Default false"},{"key":"kill_switch_reason","label":"Kill switch reason","type":"string","required":false,"core":true},{"key":"kill_switch_at","label":"Kill switch at","type":"timestamp","required":false,"core":true},{"key":"kill_switch_by","label":"Kill switch by","type":"string","required":false,"core":true}]$j$::jsonb, 'migration', 'migration')
ON CONFLICT (type, version) DO NOTHING;
