-- Run against iamservice_db.
-- Each demo user gets one primary persona.
-- scope_id values must match the seeded provider/merchant UUIDs.

INSERT INTO user_personas (user_id, persona_kind, scope_id, scope_label, is_primary, granted_by)
VALUES
  ('e0000000-0000-0000-0000-000000000001'::uuid, 'SUPER_ADMIN', NULL, 'Katana Platform', true, 'seed'),
  ('e0000000-0000-0000-0000-000000000002'::uuid, 'PROVIDER',
     'a0000000-0000-0000-0000-000000000001', 'Northstar Partners', true, 'seed'),
  ('e0000000-0000-0000-0000-000000000003'::uuid, 'MERCHANT',
     'b0000000-0000-0000-0000-000000010001', 'Merchant 10001 — Acme', true, 'seed')
ON CONFLICT DO NOTHING;
