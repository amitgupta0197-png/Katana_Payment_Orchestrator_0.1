-- Run against iamservice_db.
-- Grants the demo banker its BANKER persona. scope_id IS the banker_id used by every
-- DT table (dt_purchases.banker_id is plain text — there is no `bankers` table), so this
-- value must match tools/seed/09_dt_demo.sql exactly or the banker portal reads zeroes.

INSERT INTO user_personas (user_id, persona_kind, scope_id, scope_label, is_primary, granted_by)
VALUES
  ('e0000000-0000-0000-0000-000000000004'::uuid, 'BANKER',
     'c0000000-0000-0000-0000-000000000001', 'Meridian Capital', true, 'seed')
ON CONFLICT DO NOTHING;
