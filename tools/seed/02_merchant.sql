-- Run against merchantservice_db.
-- Seeds Merchant 10001 (LIVE) so the merchant-portal has data.

INSERT INTO merchants (id, tenant_id, merchant_code, legal_name, brand_name, business_type,
                       category_mcc, contact_email, contact_phone, website,
                       stage, risk_tier,
                       step_application, step_kyb_docs, step_screening,
                       step_bank_verify, step_config, step_approval,
                       approved_at, approved_by)
VALUES ('b0000000-0000-0000-0000-000000010001', 'tenant-default', 'M10001',
        'Acme Commerce Pvt Ltd', 'Acme', 'PRIVATE_LIMITED',
        '5411', 'ops@acme.example', '9999910001', 'https://acme.example',
        'LIVE', 'LOW',
        true, true, true, true, true, true,
        now(), 'admin@katana.dev')
ON CONFLICT (tenant_id, merchant_code) DO NOTHING;

-- A second merchant still in onboarding so /provider-portal/leads has rows.
INSERT INTO merchants (id, tenant_id, merchant_code, legal_name, business_type,
                       contact_email, contact_phone, stage,
                       step_application, step_kyb_docs)
VALUES ('b0000000-0000-0000-0000-000000010002', 'tenant-default', 'M10002',
        'Bravo Retail Pvt Ltd', 'PRIVATE_LIMITED',
        'ops@bravo.example', '9999910002', 'DOCS_PENDING',
        true, false)
ON CONFLICT (tenant_id, merchant_code) DO NOTHING;
