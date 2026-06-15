-- Run against midservice_db.
-- Main MID for Merchant 10001 + one settlement-enabled Sub-MID.

INSERT INTO main_mids (id, tenant_id, merchant_id, mid_code, settlement_enabled, created_by)
VALUES ('c0000000-0000-0000-0000-000000010001', 'tenant-default',
        'b0000000-0000-0000-0000-000000010001', 'MID-10001',
        true, 'seed')
ON CONFLICT (tenant_id, mid_code) DO NOTHING;

INSERT INTO sub_mids (id, main_mid_id, tenant_id, merchant_id, provider_id,
                     sub_mid_code, traffic_mode, kyc_status, settlement_enabled,
                     approved_at, approved_by)
VALUES ('d0000000-0000-0000-0000-000000010001',
        'c0000000-0000-0000-0000-000000010001'::uuid,
        'tenant-default',
        'b0000000-0000-0000-0000-000000010001',
        'a0000000-0000-0000-0000-000000000001'::uuid,
        'SUB-10001-A', 'KYC_APPROVED', 'APPROVED', true,
        now(), 'admin@katana.dev')
ON CONFLICT (tenant_id, sub_mid_code) DO NOTHING;

INSERT INTO sub_mid_status_history (sub_mid_id, from_status, to_status, from_mode, to_mode, actor, notes)
VALUES ('d0000000-0000-0000-0000-000000010001'::uuid, NULL, 'ACTIVE', NULL, 'KYC_APPROVED',
        'seed', 'initial seed')
ON CONFLICT DO NOTHING;
