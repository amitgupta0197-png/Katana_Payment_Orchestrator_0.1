-- vendorgatewayservice_db: SMS/Email Transaction Reconciliation & Forensic Security
-- (per "SMS Transaction Reconciliation & Forensic Security Architecture"). Adds the
-- entities the architecture requires on top of the raw-alert ingestion already in
-- 0005: device registry + trust, bank accounts, manual cases (ops fallback),
-- security alerts (risk/forensics), and a recon audit trail. Plus the forensic
-- columns on vendor_txn_alerts (sender, message hash, nonce, parser version, device
-- trust snapshot) for duplicate/replay detection and append-only evidence.

-- Company-owned bank accounts/cards whose alerts we ingest (ERD §4).
CREATE TABLE IF NOT EXISTS vendor_bank_accounts (
  bank_account_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         text NOT NULL DEFAULT 'tenant-default',
  merchant_id       text,
  bank_name         text,
  masked_account_no text,
  ifsc              text,
  settlement_vpa    text,
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vendor_bank_accounts_merchant_idx ON vendor_bank_accounts (merchant_id);

-- Forwarder devices. Only TRUSTED devices may auto-confirm orders; UNKNOWN/SUSPENDED
-- route to manual review. Heartbeat + SIM/app fingerprints power forensic checks.
CREATE TABLE IF NOT EXISTS vendor_devices (
  device_id       text PRIMARY KEY,                 -- agent-reported device id
  tenant_id       text NOT NULL DEFAULT 'tenant-default',
  merchant_id     text,
  bank_account_id uuid,
  employee_id     text,
  label           text,
  status          text NOT NULL DEFAULT 'UNKNOWN'
                  CHECK (status IN ('TRUSTED','UNKNOWN','SUSPENDED','REVOKED')),
  app_hash        text,
  sim_id          text,
  last_heartbeat  timestamptz,
  registered_by   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vendor_devices_status_idx ON vendor_devices (status);

-- Operations fallback: a verification ticket for every alert that does NOT clear the
-- auto-confirm policy (low confidence, ambiguous, unmatched, duplicate, untrusted…).
CREATE TABLE IF NOT EXISTS vendor_manual_cases (
  case_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL DEFAULT 'tenant-default',
  alert_id        uuid,
  order_id        uuid,
  order_ref       text,
  device_id       text,
  reason          text NOT NULL,        -- LOW_CONFIDENCE|AMBIGUOUS|UNMATCHED|DUPLICATE|UNTRUSTED_DEVICE|SUSPICIOUS_DEVICE|AMOUNT_CONFLICT
  expected_amount numeric(18,2),
  confidence      int NOT NULL DEFAULT 0,
  detail          text,
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED','REJECTED')),
  assigned_to     text,
  resolution      text,
  resolved_by     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz
);
CREATE INDEX IF NOT EXISTS vendor_manual_cases_open_idx ON vendor_manual_cases (status, created_at DESC);

-- Risk/forensics: suspicious-device, replay, nonce-reuse, SIM-change, fake-sender…
CREATE TABLE IF NOT EXISTS vendor_security_alerts (
  alert_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    text NOT NULL DEFAULT 'tenant-default',
  device_id    text,
  risk_type    text NOT NULL,           -- REPLAY|NONCE_REUSE|SIM_CHANGE|UNKNOWN_DEVICE|SUSPENDED_DEVICE|FAKE_SENDER|DUPLICATE|HEARTBEAT_GAP|APP_TAMPER
  severity     text NOT NULL DEFAULT 'MEDIUM' CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  detail       text,
  ref_alert_id uuid,
  status       text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','REVIEWED','DISMISSED')),
  reviewed_by  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  reviewed_at  timestamptz
);
CREATE INDEX IF NOT EXISTS vendor_security_alerts_open_idx ON vendor_security_alerts (status, severity, created_at DESC);

-- Recon decision audit trail (forensic, append-only).
CREATE TABLE IF NOT EXISTS vendor_recon_audit (
  audit_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor      text,
  action     text NOT NULL,
  entity     text,
  entity_id  text,
  detail     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vendor_recon_audit_created_idx ON vendor_recon_audit (created_at DESC);

-- Forensic columns on the raw alert (Raw SMS Event §4): sender, content hash for
-- duplicate detection, nonce for replay defence, parser version, device-trust snapshot.
ALTER TABLE vendor_txn_alerts ADD COLUMN IF NOT EXISTS sender          text;
ALTER TABLE vendor_txn_alerts ADD COLUMN IF NOT EXISTS message_hash    text;
ALTER TABLE vendor_txn_alerts ADD COLUMN IF NOT EXISTS nonce           text;
ALTER TABLE vendor_txn_alerts ADD COLUMN IF NOT EXISTS parser_version  text;
ALTER TABLE vendor_txn_alerts ADD COLUMN IF NOT EXISTS txn_type        text;
ALTER TABLE vendor_txn_alerts ADD COLUMN IF NOT EXISTS device_status   text;
ALTER TABLE vendor_txn_alerts ADD COLUMN IF NOT EXISTS manual_case_id  uuid;
ALTER TABLE vendor_txn_alerts ADD COLUMN IF NOT EXISTS security_alert_id uuid;
CREATE INDEX IF NOT EXISTS vendor_txn_alerts_hash_idx  ON vendor_txn_alerts (message_hash) WHERE message_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS vendor_txn_alerts_nonce_idx ON vendor_txn_alerts (device_id, nonce) WHERE nonce IS NOT NULL;

-- Seed TRUSTED sandbox devices so the cockpit "Simulate bank credit" tester and the
-- agent's default device id auto-confirm out of the box. Real phones come up as
-- UNKNOWN and must be trusted from the console (per the architecture).
INSERT INTO vendor_devices (device_id, label, status, registered_by)
VALUES ('sim-device-01', 'Sandbox simulator', 'TRUSTED', 'seed'),
       ('android-agent-01', 'Default agent device', 'TRUSTED', 'seed')
ON CONFLICT (device_id) DO NOTHING;
