-- merchantservice_db: merchants + activity.
-- Schema reconstructed from BFF queries in apps/admin-dashboard/src/app/api/merchants/.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS merchants (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            text NOT NULL DEFAULT 'tenant-default',
  merchant_code        text NOT NULL,
  legal_name           text NOT NULL,
  brand_name           text,
  business_type        text,
  category_mcc         text,
  contact_email        text NOT NULL,
  contact_phone        text,
  website              text,
  registered_address   text,
  stage                text NOT NULL DEFAULT 'APPLICATION'
                       CHECK (stage IN ('APPLICATION','DOCS_PENDING','SCREENING','BANK_VERIFY','CONFIG','IN_REVIEW','APPROVED','LIVE','SUSPENDED','TERMINATED','REJECTED')),
  risk_tier            text CHECK (risk_tier IN ('LOW','MEDIUM','HIGH')),
  step_application     boolean NOT NULL DEFAULT false,
  step_kyb_docs        boolean NOT NULL DEFAULT false,
  step_screening       boolean NOT NULL DEFAULT false,
  step_bank_verify     boolean NOT NULL DEFAULT false,
  step_config          boolean NOT NULL DEFAULT false,
  step_approval        boolean NOT NULL DEFAULT false,
  approved_at          timestamptz,
  approved_by          text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, merchant_code)
);

CREATE TABLE IF NOT EXISTS merchant_activity (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id   uuid NOT NULL,
  action        text NOT NULL,
  actor         text,
  payload       jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS merchant_activity_merchant_idx ON merchant_activity (merchant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS merchant_bank_accounts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id       uuid NOT NULL,
  bank_account_no   text NOT NULL,
  bank_ifsc         text NOT NULL,
  beneficiary_name  text NOT NULL,
  upi_vpa           text,
  verified_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS merchant_risk_profiles (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id           uuid NOT NULL,
  declared_mcc          text,
  declared_avg_ticket   numeric,
  declared_geos         text[] NOT NULL DEFAULT '{}',
  chargeback_history    text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
