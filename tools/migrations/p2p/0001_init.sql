-- p2pservice_db: P2P traders (individual + business), VPA mapping, sub-users,
-- and collections (UTR matching). Backs the P2P Individual + P2P Business modules.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS p2p_traders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL DEFAULT 'tenant-default',
  trader_code   text NOT NULL,
  name          text NOT NULL,
  kind          text NOT NULL DEFAULT 'INDIVIDUAL' CHECK (kind IN ('INDIVIDUAL','BUSINESS')),
  contact_email text,
  contact_phone text,
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','TERMINATED')),
  risk_tier     text DEFAULT 'LOW' CHECK (risk_tier IN ('LOW','MEDIUM','HIGH')),
  per_txn_max      numeric(18,2) NOT NULL DEFAULT 100000,
  daily_amount_max numeric(18,2) NOT NULL DEFAULT 1000000,
  daily_count_max  int NOT NULL DEFAULT 500,
  vpa_mode      text NOT NULL DEFAULT 'STATIC' CHECK (vpa_mode IN ('STATIC','DYNAMIC')),  -- business pool: static or dynamic VPA
  provider_id   uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, trader_code)
);

CREATE TABLE IF NOT EXISTS p2p_trader_vpas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trader_id   uuid NOT NULL REFERENCES p2p_traders(id) ON DELETE CASCADE,
  vpa         text NOT NULL,
  label       text,
  status      text NOT NULL DEFAULT 'READY' CHECK (status IN ('READY','ACTIVE','DISABLED','FAILED')),
  is_primary  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trader_id, vpa)
);

CREATE TABLE IF NOT EXISTS p2p_trader_users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trader_id   uuid NOT NULL REFERENCES p2p_traders(id) ON DELETE CASCADE,
  email       text NOT NULL,
  role        text NOT NULL DEFAULT 'OPERATOR' CHECK (role IN ('OWNER','OPERATOR','READER')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trader_id, email)
);

CREATE TABLE IF NOT EXISTS p2p_collections (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    text NOT NULL DEFAULT 'tenant-default',
  trader_id    uuid NOT NULL REFERENCES p2p_traders(id) ON DELETE CASCADE,
  vpa          text,
  amount       numeric(18,2) NOT NULL,
  utr          text,
  status       text NOT NULL DEFAULT 'PENDING',
  match_result text,                 -- CORRECT | WRONG_AMOUNT | DUPLICATE | UNMATCHED
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS p2p_collections_trader_idx ON p2p_collections (trader_id, created_at DESC);
CREATE INDEX IF NOT EXISTS p2p_collections_utr_idx ON p2p_collections (utr);
