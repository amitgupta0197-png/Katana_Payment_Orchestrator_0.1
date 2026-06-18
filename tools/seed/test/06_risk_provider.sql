-- Test data for /risk, /risk/aml, /disputes, /admin/maker-checker and provider
-- audit logs. Covers two databases; the file is structured so a per-DB splitter
-- can route each section to the right database.
--
--   riskvelocityservice_db : risk_scores, screening_runs, aml_cases, disputes,
--                            dispute_evidence
--                            (tables from tools/migrations/riskVelocity/
--                             0001_compliance.sql + 0002_disputes.sql)
--   providerservice_db     : maker_checker_requests, provider_audit_logs
--                            (tables from tools/migrations/provider/
--                             0001_init.sql + 0002_audit_maker_checker.sql)
--
-- Idempotent: every row uses a fixed UUID/text primary key with
-- ON CONFLICT (<pk>) DO NOTHING, so re-running is a no-op. Runs cleanly under
-- psql -v ON_ERROR_STOP=1. Only columns that exist in the migrations are used.
-- No \c meta-commands, no schema changes.
--
-- Conventions reused from the existing seeds:
--   - merchant ids are text: 'merchant-acme' / 'merchant-globex'
--     (see tools/seed/test/04_ledger.sql).
--   - existing provider id 'a0000000-0000-0000-0000-000000000001' (code
--     NORTHSTAR) from tools/seed/01_provider_merchant.sql is referenced where a
--     provider id is needed.
--   - the only demo SUPER_ADMIN that signs in is admin@katana.dev /
--     'e0000000-0000-0000-0000-000000000001' (tools/seed/05_users.sql +
--     06_personas.sql). The maker-checker UI blocks a maker from approving their
--     own request (maker_id === session.user_id), so every PENDING request below
--     is raised by a DIFFERENT super-admin ('riskops@katana.dev' /
--     'e0000000-0000-0000-0000-000000000004') — leaving them approvable by the
--     demo admin. Relative timestamps via now() - interval.


-- ==== DB: riskvelocityservice_db ====

-- ---------------------------------------------------------------------------
-- risk_scores: per-transaction risk decisions (0..1). decision ∈ ALLOW |
-- CHALLENGE | BLOCK. components is NOT NULL jsonb.
-- ---------------------------------------------------------------------------
INSERT INTO risk_scores (score_id, order_id, merchant_id, total_score, decision, components, scored_at) VALUES
  ('c1000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-0000000000a1', 'merchant-acme',   0.1200, 'ALLOW',
     '{"velocity":0.05,"geo":0.02,"device":0.05,"bin_risk":0.00}'::jsonb,                            now() - interval '2 hours'),
  ('c1000000-0000-0000-0000-000000000002', 'd1000000-0000-0000-0000-0000000000a2', 'merchant-acme',   0.3400, 'ALLOW',
     '{"velocity":0.18,"geo":0.06,"device":0.10,"bin_risk":0.00}'::jsonb,                            now() - interval '5 hours'),
  ('c1000000-0000-0000-0000-000000000003', 'd1000000-0000-0000-0000-0000000000a3', 'merchant-globex', 0.6700, 'CHALLENGE',
     '{"velocity":0.40,"geo":0.15,"device":0.07,"bin_risk":0.05}'::jsonb,                            now() - interval '1 day'),
  ('c1000000-0000-0000-0000-000000000004', 'd1000000-0000-0000-0000-0000000000a4', 'merchant-globex', 0.7300, 'CHALLENGE',
     '{"velocity":0.45,"geo":0.20,"device":0.08,"bin_risk":0.00}'::jsonb,                            now() - interval '1 day 3 hours'),
  ('c1000000-0000-0000-0000-000000000005', 'd1000000-0000-0000-0000-0000000000a5', 'merchant-acme',   0.9100, 'BLOCK',
     '{"velocity":0.55,"geo":0.20,"device":0.06,"bin_risk":0.10}'::jsonb,                            now() - interval '2 days'),
  ('c1000000-0000-0000-0000-000000000006', 'd1000000-0000-0000-0000-0000000000a6', 'merchant-globex', 0.8800, 'BLOCK',
     '{"velocity":0.50,"geo":0.18,"device":0.10,"bin_risk":0.10}'::jsonb,                            now() - interval '3 days'),
  ('c1000000-0000-0000-0000-000000000007', 'd1000000-0000-0000-0000-0000000000a7', 'merchant-acme',   0.2100, 'ALLOW',
     '{"velocity":0.10,"geo":0.04,"device":0.07,"bin_risk":0.00}'::jsonb,                            now() - interval '4 days')
ON CONFLICT (score_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- screening_runs: one row per sanctions/PEP screening pass. decision ∈ CLEAR |
-- REVIEW | BLOCK. The synthetic hit names match the seeded sanctions_list /
-- pep_list rows in migration 0001 (Ivan Petrov, Kim Hwang, Elena Markovic,
-- Tunde Adewale). raw_hits is jsonb; triggered_case links to an aml_cases row
-- (set below). entity_type ∈ merchant | beneficiary | customer | director.
-- ---------------------------------------------------------------------------
INSERT INTO screening_runs
  (run_id, entity_type, entity_id, full_name, country, dob, identifier,
   hits_count, sanctions_hit, pep_hit, triggered_case, decision, raw_hits, run_at, actor_id) VALUES
  ('c2000000-0000-0000-0000-000000000001', 'merchant', 'merchant-acme',   'Acme Retail India', 'IN', NULL, NULL,
     0, false, false, NULL, 'CLEAR', '[]'::jsonb, now() - interval '6 hours',
     'e0000000-0000-0000-0000-000000000001'),
  ('c2000000-0000-0000-0000-000000000002', 'beneficiary', 'BEN-7781',     'Jane Cooper',        'GB', NULL, NULL,
     0, false, false, NULL, 'CLEAR', '[]'::jsonb, now() - interval '8 hours',
     'e0000000-0000-0000-0000-000000000001'),
  ('c2000000-0000-0000-0000-000000000003', 'director', 'DIR-ACME-01',     'Elena Markovic',     'RS', NULL, NULL,
     1, false, true, 'c3000000-0000-0000-0000-000000000003', 'REVIEW',
     '[{"source":"PEP","full_name":"Elena Markovic","match_kind":"PEP","country":"RS","reason":"Minister of Finance (acting)"}]'::jsonb,
     now() - interval '1 day', 'e0000000-0000-0000-0000-000000000001'),
  ('c2000000-0000-0000-0000-000000000004', 'beneficiary', 'BEN-9001',     'Tunde Adewale',      'NG', NULL, NULL,
     1, false, true, 'c3000000-0000-0000-0000-000000000004', 'REVIEW',
     '[{"source":"PEP","full_name":"Tunde Adewale","match_kind":"PEP","country":"NG","reason":"Central Bank Governor"}]'::jsonb,
     now() - interval '2 days', 'e0000000-0000-0000-0000-000000000001'),
  ('c2000000-0000-0000-0000-000000000005', 'customer', 'CUST-55012',      'Ivan Petrov',        'RU', NULL, 'PASS-RU-001',
     1, true, false, 'c3000000-0000-0000-0000-000000000001', 'BLOCK',
     '[{"source":"OFAC","full_name":"Ivan Petrov","match_kind":"SANCTIONS","country":"RU","reason":"sectoral sanctions: synthetic test record"}]'::jsonb,
     now() - interval '3 days', 'e0000000-0000-0000-0000-000000000001'),
  ('c2000000-0000-0000-0000-000000000006', 'beneficiary', 'BEN-3120',     'Kim Hwang',          'KP', NULL, 'PASS-KP-007',
     1, true, false, 'c3000000-0000-0000-0000-000000000002', 'BLOCK',
     '[{"source":"OFAC","full_name":"Kim Hwang","match_kind":"SANCTIONS","country":"KP","reason":"designated party (synthetic)"}]'::jsonb,
     now() - interval '4 days', 'e0000000-0000-0000-0000-000000000001')
ON CONFLICT (run_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- aml_cases: AML case workflow. status ∈ OPEN | UNDER_REVIEW | ESCALATED |
-- CLOSED_CLEARED | CLOSED_BLOCKED. severity ∈ LOW | MEDIUM | HIGH | CRITICAL.
-- source ∈ sanctions | pep | velocity | manual | risk_score. evidence is jsonb.
-- The /risk/aml page splits these into open (OPEN/UNDER_REVIEW/ESCALATED) and
-- closed (status LIKE 'CLOSED%'). related_run points back to screening_runs.
-- ---------------------------------------------------------------------------
INSERT INTO aml_cases
  (case_id, tenant_id, entity_type, entity_id, source, status, severity, summary,
   evidence, decision_notes, opened_at, opened_by, assigned_to, decided_at, decided_by, related_run) VALUES
  ('c3000000-0000-0000-0000-000000000001', 'tenant-default', 'customer', 'CUST-55012', 'sanctions', 'OPEN', 'CRITICAL',
     'OFAC sanctions hit on customer CUST-55012 (Ivan Petrov) during checkout screening.',
     '[{"type":"screening","source":"OFAC","name":"Ivan Petrov"}]'::jsonb, NULL,
     now() - interval '3 days', 'admin@katana.dev', 'admin@katana.dev', NULL, NULL,
     'c2000000-0000-0000-0000-000000000005'),
  ('c3000000-0000-0000-0000-000000000002', 'tenant-default', 'beneficiary', 'BEN-3120', 'sanctions', 'ESCALATED', 'CRITICAL',
     'OFAC sanctions hit on payout beneficiary BEN-3120 (Kim Hwang). Payout held pending review.',
     '[{"type":"screening","source":"OFAC","name":"Kim Hwang"}]'::jsonb, 'Escalated to compliance lead.',
     now() - interval '4 days', 'admin@katana.dev', 'compliance@katana.dev', NULL, NULL,
     'c2000000-0000-0000-0000-000000000006'),
  ('c3000000-0000-0000-0000-000000000003', 'tenant-default', 'director', 'DIR-ACME-01', 'pep', 'UNDER_REVIEW', 'HIGH',
     'PEP match on director DIR-ACME-01 (Elena Markovic). EDD documentation requested.',
     '[{"type":"screening","source":"PEP","name":"Elena Markovic"}]'::jsonb, NULL,
     now() - interval '1 day', 'admin@katana.dev', 'admin@katana.dev', NULL, NULL,
     'c2000000-0000-0000-0000-000000000003'),
  ('c3000000-0000-0000-0000-000000000004', 'tenant-default', 'beneficiary', 'BEN-9001', 'pep', 'OPEN', 'MEDIUM',
     'PEP match on beneficiary BEN-9001 (Tunde Adewale). Awaiting source-of-funds review.',
     '[{"type":"screening","source":"PEP","name":"Tunde Adewale"}]'::jsonb, NULL,
     now() - interval '2 days', 'admin@katana.dev', NULL, NULL, NULL,
     'c2000000-0000-0000-0000-000000000004'),
  ('c3000000-0000-0000-0000-000000000005', 'tenant-default', 'merchant', 'merchant-globex', 'risk_score', 'OPEN', 'HIGH',
     'Sustained high transaction risk scores (>0.85) for merchant-globex over 3 days.',
     '[{"type":"risk_score","scores":[0.88,0.91]}]'::jsonb, NULL,
     now() - interval '6 hours', 'admin@katana.dev', 'admin@katana.dev', NULL, NULL, NULL),
  ('c3000000-0000-0000-0000-000000000006', 'tenant-default', 'merchant', 'merchant-acme', 'velocity', 'CLOSED_CLEARED', 'LOW',
     'Velocity spike on merchant-acme flagged by transaction monitoring; confirmed legitimate sale event.',
     '[{"type":"velocity","window":"1h","count":420}]'::jsonb, 'Reviewed — flash-sale traffic, no AML concern.',
     now() - interval '7 days', 'admin@katana.dev', 'admin@katana.dev', now() - interval '6 days', 'admin@katana.dev', NULL),
  ('c3000000-0000-0000-0000-000000000007', 'tenant-default', 'customer', 'CUST-41099', 'manual', 'CLOSED_BLOCKED', 'HIGH',
     'Manually opened: adverse-media report on customer CUST-41099. Account terminated.',
     '[{"type":"adverse_media","url":"https://example.test/report"}]'::jsonb, 'Confirmed adverse media — account blocked.',
     now() - interval '9 days', 'admin@katana.dev', 'admin@katana.dev', now() - interval '8 days', 'admin@katana.dev', NULL)
ON CONFLICT (case_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- disputes: BRD dispute lifecycle. status ∈ DISPUTE_OPEN | REPRESENTMENT |
-- ACCEPTED | WON | LOST | EXPIRED. reason_code uses the "<code> <label>" form.
-- amount_minor is paise (INR exponent 2). The /disputes page filters
-- tenant_id='tenant-default' and (for MERCHANT persona) merchant_id.
-- ---------------------------------------------------------------------------
INSERT INTO disputes
  (dispute_id, tenant_id, txn_id, order_id, merchant_id, reason_code, amount_minor, currency,
   status, deadline_at, opened_at, opened_by, resolved_at, resolved_by, resolution_notes) VALUES
  ('c4000000-0000-0000-0000-000000000001', 'tenant-default', 'TXN-DSP-1001', 'd1000000-0000-0000-0000-0000000000b1',
     'merchant-acme',   '10.4 fraud',                 1250000, 'INR', 'DISPUTE_OPEN',
     now() + interval '6 days',  now() - interval '1 day',  'admin@katana.dev', NULL, NULL, NULL),
  ('c4000000-0000-0000-0000-000000000002', 'tenant-default', 'TXN-DSP-1002', 'd1000000-0000-0000-0000-0000000000b2',
     'merchant-acme',   '13.1 service_not_received',   480000, 'INR', 'REPRESENTMENT',
     now() + interval '3 days',  now() - interval '3 days', 'admin@katana.dev', NULL, NULL, NULL),
  ('c4000000-0000-0000-0000-000000000003', 'tenant-default', 'TXN-DSP-1003', 'd1000000-0000-0000-0000-0000000000b3',
     'merchant-globex', '12.5 incorrect_amount',       990000, 'INR', 'REPRESENTMENT',
     now() + interval '2 days',  now() - interval '4 days', 'admin@katana.dev', NULL, NULL, NULL),
  ('c4000000-0000-0000-0000-000000000004', 'tenant-default', 'TXN-DSP-1004', 'd1000000-0000-0000-0000-0000000000b4',
     'merchant-globex', '10.4 fraud',                 2100000, 'INR', 'WON',
     now() - interval '1 day',   now() - interval '12 days','admin@katana.dev',
     now() - interval '2 days', 'admin@katana.dev', 'Compelling evidence accepted — chargeback reversed.'),
  ('c4000000-0000-0000-0000-000000000005', 'tenant-default', 'TXN-DSP-1005', 'd1000000-0000-0000-0000-0000000000b5',
     'merchant-acme',   '13.1 service_not_received',   355000, 'INR', 'LOST',
     now() - interval '3 days',  now() - interval '15 days','admin@katana.dev',
     now() - interval '4 days', 'admin@katana.dev', 'No shipping proof supplied — chargeback upheld.'),
  ('c4000000-0000-0000-0000-000000000006', 'tenant-default', 'TXN-DSP-1006', 'd1000000-0000-0000-0000-0000000000b6',
     'merchant-globex', '12.5 incorrect_amount',       150000, 'INR', 'ACCEPTED',
     now() - interval '5 days',  now() - interval '10 days','admin@katana.dev',
     now() - interval '6 days', 'admin@katana.dev', 'Merchant accepted liability; refund issued.'),
  ('c4000000-0000-0000-0000-000000000007', 'tenant-default', 'TXN-DSP-1007', 'd1000000-0000-0000-0000-0000000000b7',
     'merchant-acme',   '10.4 fraud',                  720000, 'INR', 'EXPIRED',
     now() - interval '7 days',  now() - interval '25 days','admin@katana.dev',
     now() - interval '7 days', 'system',           'Representment window elapsed with no response.')
ON CONFLICT (dispute_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- dispute_evidence: evidence trail for the open / representment disputes.
-- evidence_type ∈ receipt | shipping_proof | customer_correspondence | ip_log |
-- id_match. FK dispute_id -> disputes(dispute_id).
-- ---------------------------------------------------------------------------
INSERT INTO dispute_evidence
  (evidence_id, dispute_id, evidence_type, file_url, notes, submitted_by, submitted_at) VALUES
  ('c5000000-0000-0000-0000-000000000001', 'c4000000-0000-0000-0000-000000000002', 'shipping_proof',
     'https://evidence.example.test/dsp-1002/awb.pdf', 'Carrier AWB showing delivery + signature.',
     'admin@katana.dev', now() - interval '2 days'),
  ('c5000000-0000-0000-0000-000000000002', 'c4000000-0000-0000-0000-000000000002', 'customer_correspondence',
     'https://evidence.example.test/dsp-1002/emails.pdf', 'Email thread confirming receipt.',
     'admin@katana.dev', now() - interval '2 days'),
  ('c5000000-0000-0000-0000-000000000003', 'c4000000-0000-0000-0000-000000000003', 'receipt',
     'https://evidence.example.test/dsp-1003/invoice.pdf', 'Itemised invoice matching the charged amount.',
     'admin@katana.dev', now() - interval '3 days'),
  ('c5000000-0000-0000-0000-000000000004', 'c4000000-0000-0000-0000-000000000004', 'ip_log',
     'https://evidence.example.test/dsp-1004/ip.json', 'Device + IP match across order and account history.',
     'admin@katana.dev', now() - interval '10 days')
ON CONFLICT (evidence_id) DO NOTHING;


-- ==== DB: providerservice_db ====

-- ---------------------------------------------------------------------------
-- maker_checker_requests: PENDING requests + a couple of decided ones.
-- status ∈ PENDING | APPROVED | REJECTED. resource_type ∈ provider | merchant |
-- sub_mid. action examples: provider.kyc.approve | provider.kyc.reject |
-- provider.status.terminate | merchant.advance.live | submid.settlement.enable.
--
-- PENDING rows are raised by a SECOND super-admin ('riskops@katana.dev' /
-- 'e0000000-0000-0000-0000-000000000004'), NOT the demo admin
-- ('e0000000-0000-0000-0000-000000000001'). The maker-checker POST handler
-- blocks maker_id === session.user_id, so the demo admin CAN approve these.
-- Provider-resource requests reference the existing NORTHSTAR provider id.
-- ---------------------------------------------------------------------------
INSERT INTO maker_checker_requests
  (request_id, tenant_id, resource_type, resource_id, action, payload,
   maker_id, maker_email, status, checker_id, checker_email, decision_notes, created_at, decided_at) VALUES
  -- PENDING (approvable by demo admin)
  ('c6000000-0000-0000-0000-000000000001', 'tenant-default', 'provider',
     'a0000000-0000-0000-0000-000000000001', 'provider.kyc.approve',
     '{"kyc_status":"APPROVED"}'::jsonb,
     'e0000000-0000-0000-0000-000000000004', 'riskops@katana.dev', 'PENDING',
     NULL, NULL, NULL, now() - interval '4 hours', NULL),
  ('c6000000-0000-0000-0000-000000000002', 'tenant-default', 'provider',
     'a0000000-0000-0000-0000-000000000001', 'provider.status.terminate',
     '{"status":"TERMINATED","reason":"repeated SLA breaches"}'::jsonb,
     'e0000000-0000-0000-0000-000000000004', 'riskops@katana.dev', 'PENDING',
     NULL, NULL, NULL, now() - interval '2 hours', NULL),
  ('c6000000-0000-0000-0000-000000000003', 'tenant-default', 'merchant',
     'merchant-globex', 'merchant.advance.live',
     '{"target_state":"LIVE"}'::jsonb,
     'e0000000-0000-0000-0000-000000000004', 'riskops@katana.dev', 'PENDING',
     NULL, NULL, NULL, now() - interval '1 hour', NULL),
  ('c6000000-0000-0000-0000-000000000004', 'tenant-default', 'sub_mid',
     'submid-acme-001', 'submid.settlement.enable',
     '{"settlement_enabled":true}'::jsonb,
     'e0000000-0000-0000-0000-000000000004', 'riskops@katana.dev', 'PENDING',
     NULL, NULL, NULL, now() - interval '30 minutes', NULL),
  -- Recent decisions (maker != checker)
  ('c6000000-0000-0000-0000-000000000005', 'tenant-default', 'provider',
     'a0000000-0000-0000-0000-000000000001', 'provider.kyc.approve',
     '{"kyc_status":"APPROVED"}'::jsonb,
     'e0000000-0000-0000-0000-000000000004', 'riskops@katana.dev', 'APPROVED',
     'e0000000-0000-0000-0000-000000000001', 'admin@katana.dev',
     'KYC documents verified — approved.', now() - interval '3 days', now() - interval '3 days' + interval '2 hours'),
  ('c6000000-0000-0000-0000-000000000006', 'tenant-default', 'merchant',
     'merchant-acme', 'merchant.advance.live',
     '{"target_state":"LIVE"}'::jsonb,
     'e0000000-0000-0000-0000-000000000004', 'riskops@katana.dev', 'REJECTED',
     'e0000000-0000-0000-0000-000000000001', 'admin@katana.dev',
     'Outstanding sanctions case — go-live blocked pending clearance.', now() - interval '2 days', now() - interval '2 days' + interval '1 hour')
ON CONFLICT (request_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- provider_audit_logs: WORM-style audit rows for the NORTHSTAR provider.
-- Columns per migration: id, provider_id, action, actor, payload (jsonb),
-- created_at, hash. (The reading routes also reference before_state/after_state/
-- occurred_at which DO NOT exist in the migration; those queries are wrapped in
-- .catch(() => []), so we seed only the real columns here.)
-- ---------------------------------------------------------------------------
INSERT INTO provider_audit_logs (id, provider_id, action, actor, payload, created_at, hash) VALUES
  ('c7000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'provider.created',
     'seed', '{"code":"NORTHSTAR","kind":"PROVIDER"}'::jsonb, now() - interval '30 days',
     'seed-hash-0001'),
  ('c7000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'provider.kyc.submitted',
     'provider@katana.dev', '{"docs":["pan","gst","bank_proof"]}'::jsonb, now() - interval '20 days',
     'seed-hash-0002'),
  ('c7000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'provider.kyc.approve',
     'admin@katana.dev', '{"before":{"kyc_status":"IN_REVIEW"},"after":{"kyc_status":"APPROVED"}}'::jsonb,
     now() - interval '3 days', 'seed-hash-0003'),
  ('c7000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001', 'provider.commission.updated',
     'admin@katana.dev', '{"rule_kind":"BPS","rate_bps":175}'::jsonb, now() - interval '6 days',
     'seed-hash-0004'),
  ('c7000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000001', 'provider.merchant.mapped',
     'admin@katana.dev', '{"merchant_id":"merchant-acme"}'::jsonb, now() - interval '12 days',
     'seed-hash-0005')
ON CONFLICT (id) DO NOTHING;
