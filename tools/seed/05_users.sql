-- Run against authservice_db.
-- Three demo users from apps/admin-dashboard/src/app/login/page.tsx.
-- Password is 'demo' — checked literally in /api/auth/login (not hashed).

INSERT INTO users (id, email, full_name, status)
VALUES
  ('e0000000-0000-0000-0000-000000000001', 'admin@katana.dev',    'Ada Admin',    'active'),
  ('e0000000-0000-0000-0000-000000000002', 'provider@katana.dev', 'Pat Provider', 'active'),
  ('e0000000-0000-0000-0000-000000000003', 'merchant@katana.dev', 'Mia Merchant', 'active')
ON CONFLICT (email) DO NOTHING;
