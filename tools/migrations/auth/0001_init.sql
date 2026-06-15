-- authservice_db: users + api_keys.
-- Schema is reconstructed from the BFF queries in apps/admin-dashboard/src/app/api/.
-- Real schema may differ once original migrations are recovered.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           citext UNIQUE,
  full_name       text,
  password_hash   text,
  status          text NOT NULL DEFAULT 'active',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Fallback to text if citext extension isn't available.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS citext;
    ALTER TABLE users ALTER COLUMN email TYPE citext;
  EXCEPTION WHEN OTHERS THEN
    ALTER TABLE users ALTER COLUMN email TYPE text;
  END;
END $$;

CREATE TABLE IF NOT EXISTS api_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL DEFAULT 'tenant-default',
  owner_kind      text NOT NULL,    -- PLATFORM | PROVIDER | MERCHANT
  owner_id        text NOT NULL,
  label           text NOT NULL,
  prefix          text NOT NULL,
  secret_hash     text NOT NULL,
  scopes          text[] NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'ACTIVE',
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz,
  revoked_at      timestamptz,
  issued_by       text
);
CREATE INDEX IF NOT EXISTS api_keys_owner_idx ON api_keys (owner_kind, owner_id);
