-- tenantservice_db: tenants table.
-- Columns derived from apps/admin-dashboard/src/app/api/tenants/route.ts GET.
-- Type: PLATFORM | PROVIDER | MERCHANT — parent_id chains tenants into a tree.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id   uuid REFERENCES tenants(id) ON DELETE SET NULL,
  type        text NOT NULL CHECK (type IN ('PLATFORM','PROVIDER','MERCHANT')),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'ACTIVE',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tenants_parent_idx ON tenants (parent_id);

-- Seed the platform root so PROVIDER/MERCHANT tenants always have a parent.
INSERT INTO tenants (id, type, code, name, status)
VALUES ('00000000-0000-0000-0000-000000000001', 'PLATFORM', 'tenant-default', 'Katana Platform', 'ACTIVE')
ON CONFLICT (code) DO NOTHING;
