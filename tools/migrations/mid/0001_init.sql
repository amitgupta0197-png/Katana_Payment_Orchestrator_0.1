-- midservice_db: main_mids + sub_mids + history.
-- Reconstructed from BFF queries in apps/admin-dashboard/src/app/api/sub-mids/.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS main_mids (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             text NOT NULL DEFAULT 'tenant-default',
  merchant_id           text NOT NULL,
  mid_code              text NOT NULL,
  status                text NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN ('ACTIVE','SUSPENDED','TERMINATED')),
  settlement_enabled    boolean NOT NULL DEFAULT false,
  created_by            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, mid_code)
);

CREATE TABLE IF NOT EXISTS sub_mids (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  main_mid_id           uuid NOT NULL REFERENCES main_mids(id) ON DELETE CASCADE,
  tenant_id             text NOT NULL DEFAULT 'tenant-default',
  merchant_id           text NOT NULL,
  provider_id           uuid,
  sub_mid_code          text NOT NULL,
  traffic_mode          text NOT NULL DEFAULT 'TRAFFIC'
                        CHECK (traffic_mode IN ('TRAFFIC','KYC_APPROVED')),
  kyc_status            text NOT NULL DEFAULT 'PENDING'
                        CHECK (kyc_status IN ('PENDING','IN_REVIEW','APPROVED','REJECTED','EXPIRED')),
  settlement_enabled    boolean NOT NULL DEFAULT false,
  status                text NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN ('ACTIVE','SUSPENDED','TERMINATED')),
  requested_at          timestamptz NOT NULL DEFAULT now(),
  approved_at           timestamptz,
  approved_by           text,
  UNIQUE (tenant_id, sub_mid_code),
  -- §3.2 invariant: settlement_enabled requires kyc_status=APPROVED.
  CONSTRAINT settle_requires_kyc CHECK (settlement_enabled = false OR kyc_status = 'APPROVED')
);

CREATE TABLE IF NOT EXISTS sub_mid_limits (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sub_mid_id            uuid NOT NULL REFERENCES sub_mids(id) ON DELETE CASCADE,
  per_txn_max           numeric,
  daily_amount          numeric,
  daily_count           int,
  monthly_amount        numeric,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sub_mid_status_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sub_mid_id    uuid NOT NULL REFERENCES sub_mids(id) ON DELETE CASCADE,
  from_status   text,
  to_status     text,
  from_mode     text,
  to_mode       text,
  actor         text,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
