-- Run against authservice_db.
-- Demo BANKER login for the DT business model (see docs/portal-login-demo-video.md).
-- password_hash is NULL, so the shared DEMO_PASSWORD ('demo') is accepted — this works
-- in development ONLY; the demo-login path is disabled when NODE_ENV=production
-- (security audit C5). In prod an admin must set a real password for this account.

INSERT INTO users (id, email, full_name, status)
VALUES
  ('e0000000-0000-0000-0000-000000000004', 'banker@katana.dev', 'Bala Banker', 'active')
ON CONFLICT (email) DO NOTHING;
