-- Run against providerservice_db (after merchant seed).
-- Maps Northstar → Merchant 10001 + 10002 so the provider portal scopes correctly.

INSERT INTO provider_merchant_mappings (provider_id, merchant_id, status, mapped_by)
VALUES
  ('a0000000-0000-0000-0000-000000000001'::uuid,
   'b0000000-0000-0000-0000-000000010001'::uuid, 'ACTIVE', 'seed'),
  ('a0000000-0000-0000-0000-000000000001'::uuid,
   'b0000000-0000-0000-0000-000000010002'::uuid, 'ACTIVE', 'seed')
ON CONFLICT (provider_id, merchant_id) DO NOTHING;

INSERT INTO provider_commission_rules (provider_id, rule_kind, rate_bps, fixed_fee, currency)
VALUES ('a0000000-0000-0000-0000-000000000001'::uuid, 'BPS', 50, 0, 'INR')
ON CONFLICT DO NOTHING;
