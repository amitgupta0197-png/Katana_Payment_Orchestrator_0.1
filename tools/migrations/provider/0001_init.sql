-- providerservice_db: providers + users + KYC + commission + mappings.
-- Reconstructed from BFF queries in apps/admin-dashboard/src/app/api/providers/ + sub-mids/.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS providers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             text NOT NULL DEFAULT 'tenant-default',
  code                  text NOT NULL,
  legal_name            text NOT NULL,
  contact_email         text NOT NULL,
  contact_phone         text,
  kind                  text NOT NULL DEFAULT 'PROVIDER'
                        CHECK (kind IN ('PROVIDER','AGENT','PARTNER','FRANCHISE')),
  kyc_status            text NOT NULL DEFAULT 'PENDING'
                        CHECK (kyc_status IN ('PENDING','IN_REVIEW','APPROVED','REJECTED','EXPIRED')),
  status                text NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN ('ACTIVE','SUSPENDED','TERMINATED')),
  settlement_currency   text NOT NULL DEFAULT 'INR',
  bank_account_no       text,
  bank_ifsc             text,
  low_balance_threshold numeric,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS provider_users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id  uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  email        text NOT NULL,
  name         text,
  role         text NOT NULL DEFAULT 'OPERATOR' CHECK (role IN ('OWNER','OPERATOR','READER')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, email)
);

CREATE TABLE IF NOT EXISTS provider_kyc_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id  uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  doc_type     text NOT NULL,
  uri          text NOT NULL,
  sha256       text NOT NULL,
  verified_at  timestamptz,
  verified_by  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, sha256)
);

CREATE TABLE IF NOT EXISTS provider_commission_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    text NOT NULL DEFAULT 'tenant-default',
  provider_id  uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  rule_kind    text NOT NULL CHECK (rule_kind IN ('BPS','FIXED','SLAB')),
  rate_bps     int  NOT NULL DEFAULT 0,
  fixed_fee    numeric NOT NULL DEFAULT 0,
  currency     text NOT NULL DEFAULT 'INR',
  valid_from   timestamptz NOT NULL DEFAULT now(),
  valid_to     timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provider_merchant_mappings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id  uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  merchant_id  uuid NOT NULL,
  status       text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','TERMINATED')),
  mapped_by    text,
  mapped_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, merchant_id)
);

CREATE TABLE IF NOT EXISTS provider_audit_logs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id  uuid NOT NULL,
  action       text NOT NULL,
  actor        text,
  payload      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
