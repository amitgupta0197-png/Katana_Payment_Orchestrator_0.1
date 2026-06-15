-- Run against providerservice_db.
-- Seeds Northstar Partners with a stable UUID so auth seeds can reference it.

INSERT INTO providers (id, tenant_id, code, legal_name, contact_email, contact_phone, kind, kyc_status, status)
VALUES ('a0000000-0000-0000-0000-000000000001', 'tenant-default', 'NORTHSTAR',
        'Northstar Partners Pvt Ltd', 'ops@northstar.example', '9999900001',
        'PROVIDER', 'APPROVED', 'ACTIVE')
ON CONFLICT (tenant_id, code) DO NOTHING;
