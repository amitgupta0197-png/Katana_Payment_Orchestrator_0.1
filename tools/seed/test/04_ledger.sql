-- Test data for ledgerservice_db. Run AFTER migrations 0000/0001/0002, so it
-- may use the minor-unit + commission columns those add (journal_entries
-- total_debit_minor/total_credit_minor/journal_type/merchant_id,
-- ledger_lines.amount_minor, commission_ledger, reserve_ledger).
--
-- Coherent double-entry test data so /ledger, /reserves and /commission show
-- rows. Every journal is balanced: total_debit_minor == total_credit_minor and
-- sum(debit lines) == sum(credit lines). All INR (exponent 2 -> minor = paise).
--
-- Idempotent via fixed uuid literals + ON CONFLICT DO NOTHING. Insert order
-- respects FKs: accounts -> journal_entries -> ledger_lines / commission_ledger.

-- ---------------------------------------------------------------------------
-- Chart of accounts referenced by the lines below.
-- (accounts.id is IDENTITY, so we look the rows up by code when posting lines.)
-- ---------------------------------------------------------------------------
INSERT INTO accounts (tenant_id, code, type, currency, normal_balance) VALUES
  ('tenant-default', 'ASSETS.CLEARING.poolpay',                    'ASSET',     'INR', 'D'),
  ('tenant-default', 'ASSETS.SETTLEMENT_BANK',                     'ASSET',     'INR', 'D'),
  ('tenant-default', 'LIABILITIES.MERCHANT_PAYABLE.merchant-acme', 'LIABILITY', 'INR', 'C'),
  ('tenant-default', 'LIABILITIES.MERCHANT_PAYABLE.merchant-globex','LIABILITY','INR', 'C'),
  ('tenant-default', 'LIABILITIES.MERCHANT_RESERVE.merchant-acme', 'LIABILITY', 'INR', 'C'),
  ('tenant-default', 'INCOME.MDR_EARNED.poolpay',                  'INCOME',    'INR', 'C'),
  ('tenant-default', 'LIABILITIES.COMMISSION_PAYABLE.poolpay',     'LIABILITY', 'INR', 'C')
ON CONFLICT (tenant_id, code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Journal headers (5). Fixed ids so lines + commission rows can cross-reference.
--   J1 payment.success  (acme)    gross 100000, MDR 2000  -> net payable 98000
--   J2 payment.success  (globex)  gross  50000, MDR 1000  -> net payable 49000
--   J3 refund.posted    (acme)    refund 30000
--   J4 settlement.batch (acme)    payout 98000
--   J5 payment.success  (acme)    gross 250000, MDR 5000  -> net 245000 (+reserve)
-- ---------------------------------------------------------------------------
INSERT INTO journal_entries
  (id, tenant_id, posted_at, narration, currency, ref_type, ref_id, idempotency_key,
   prev_hash, entry_hash, metadata, journal_type, merchant_id,
   total_debit_minor, total_credit_minor) VALUES
  ('11111111-1111-1111-1111-111111111111', 'tenant-default', now() - interval '5 days',
     'Payment success ord_acme_001', 'INR', 'order', 'ord_acme_001', 'seed-j1',
     repeat('0',64), repeat('a',64), '{"source":"seed"}'::jsonb,
     'payment.success', 'merchant-acme', 100000, 100000),
  ('22222222-2222-2222-2222-222222222222', 'tenant-default', now() - interval '4 days',
     'Payment success ord_globex_001', 'INR', 'order', 'ord_globex_001', 'seed-j2',
     repeat('a',64), repeat('b',64), '{"source":"seed"}'::jsonb,
     'payment.success', 'merchant-globex', 50000, 50000),
  ('33333333-3333-3333-3333-333333333333', 'tenant-default', now() - interval '3 days',
     'Refund ord_acme_001', 'INR', 'order', 'ord_acme_001', 'seed-j3',
     repeat('b',64), repeat('c',64), '{"source":"seed"}'::jsonb,
     'refund.posted', 'merchant-acme', 30000, 30000),
  ('44444444-4444-4444-4444-444444444444', 'tenant-default', now() - interval '2 days',
     'Settlement batch acme', 'INR', 'settlement', 'stl_acme_2026w24', 'seed-j4',
     repeat('c',64), repeat('d',64), '{"source":"seed"}'::jsonb,
     'settlement.batch', 'merchant-acme', 98000, 98000),
  ('55555555-5555-5555-5555-555555555555', 'tenant-default', now() - interval '1 day',
     'Payment success ord_acme_002', 'INR', 'order', 'ord_acme_002', 'seed-j5',
     repeat('d',64), repeat('e',64), '{"source":"seed"}'::jsonb,
     'payment.success', 'merchant-acme', 250000, 250000)
ON CONFLICT (tenant_id, idempotency_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Ledger lines. amount == amount_minor (minor units). Each journal balances:
-- sum(side='D') == sum(side='C'). account_id resolved by code.
-- ---------------------------------------------------------------------------
INSERT INTO ledger_lines (id, journal_id, tenant_id, account_id, side, amount, amount_minor, currency)
SELECT v.id::uuid, v.journal_id::uuid, 'tenant-default',
       (SELECT id FROM accounts WHERE tenant_id='tenant-default' AND code=v.code),
       v.side, v.amt, v.amt, 'INR'
FROM (VALUES
  -- J1: payment.success acme  (D clearing 100000 = C payable 98000 + C MDR 2000)
  ('a1111111-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','ASSETS.CLEARING.poolpay',                    'D', 100000),
  ('a1111111-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','LIABILITIES.MERCHANT_PAYABLE.merchant-acme', 'C',  98000),
  ('a1111111-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','INCOME.MDR_EARNED.poolpay',                  'C',   2000),
  -- J2: payment.success globex (D clearing 50000 = C payable 49000 + C MDR 1000)
  ('a2222222-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','ASSETS.CLEARING.poolpay',                     'D', 50000),
  ('a2222222-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','LIABILITIES.MERCHANT_PAYABLE.merchant-globex','C', 49000),
  ('a2222222-0000-0000-0000-000000000003','22222222-2222-2222-2222-222222222222','INCOME.MDR_EARNED.poolpay',                   'C',  1000),
  -- J3: refund acme (D payable 30000 = C clearing 30000)
  ('a3333333-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333','LIABILITIES.MERCHANT_PAYABLE.merchant-acme',  'D', 30000),
  ('a3333333-0000-0000-0000-000000000002','33333333-3333-3333-3333-333333333333','ASSETS.CLEARING.poolpay',                     'C', 30000),
  -- J4: settlement.batch acme (D payable 98000 = C settlement bank 98000)
  ('a4444444-0000-0000-0000-000000000001','44444444-4444-4444-4444-444444444444','LIABILITIES.MERCHANT_PAYABLE.merchant-acme',  'D', 98000),
  ('a4444444-0000-0000-0000-000000000002','44444444-4444-4444-4444-444444444444','ASSETS.SETTLEMENT_BANK',                      'C', 98000),
  -- J5: payment.success acme (D clearing 250000 = C payable 200000 + C reserve 45000 + C MDR 5000)
  ('a5555555-0000-0000-0000-000000000001','55555555-5555-5555-5555-555555555555','ASSETS.CLEARING.poolpay',                     'D',250000),
  ('a5555555-0000-0000-0000-000000000002','55555555-5555-5555-5555-555555555555','LIABILITIES.MERCHANT_PAYABLE.merchant-acme',  'C',200000),
  ('a5555555-0000-0000-0000-000000000003','55555555-5555-5555-5555-555555555555','LIABILITIES.MERCHANT_RESERVE.merchant-acme',  'C', 45000),
  ('a5555555-0000-0000-0000-000000000004','55555555-5555-5555-5555-555555555555','INCOME.MDR_EARNED.poolpay',                   'C',  5000)
) AS v(id, journal_id, code, side, amt)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Reserve ledger (0001 columns). Two merchants, mixed statuses.
-- ---------------------------------------------------------------------------
INSERT INTO reserve_ledger
  (id, tenant_id, merchant_id, source_order_id, hold_amount, hold_percent_bps,
   held_at, release_date, release_status, released_amount, currency) VALUES
  ('b1111111-0000-0000-0000-000000000001', 'tenant-default', 'merchant-acme', 'ord_acme_002',
     450.00, 500, now() - interval '1 day',  now() + interval '6 days', 'HELD',      0,   'INR'),
  ('b1111111-0000-0000-0000-000000000002', 'tenant-default', 'merchant-acme', 'ord_acme_old',
     300.00, 500, now() - interval '9 days',  now() - interval '2 days', 'RELEASED',  300.00, 'INR'),
  ('b2222222-0000-0000-0000-000000000001', 'tenant-default', 'merchant-globex', 'ord_globex_001',
     250.00, 500, now() - interval '4 days',  now() + interval '3 days', 'HELD',      0,   'INR')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Commission ledger (0002 columns). References J1 (acme) + J2 (globex).
-- ---------------------------------------------------------------------------
INSERT INTO commission_ledger
  (entry_id, tenant_id, merchant_id, provider_id, agent_id, txn_id, kind,
   rate_bps, fixed_minor, amount_minor, currency, journal_id, status, accrued_at) VALUES
  ('c1111111-0000-0000-0000-000000000001', 'tenant-default', 'merchant-acme', 'poolpay', NULL,
     'ord_acme_001',  'ACQUIRER', 200, 0, 2000, 'INR',
     '11111111-1111-1111-1111-111111111111', 'ACCRUED', now() - interval '5 days'),
  ('c1111111-0000-0000-0000-000000000002', 'tenant-default', 'merchant-acme', 'poolpay', NULL,
     'ord_acme_001',  'PLATFORM', 50,  0, 500,  'INR',
     '11111111-1111-1111-1111-111111111111', 'ACCRUED', now() - interval '5 days'),
  ('c2222222-0000-0000-0000-000000000001', 'tenant-default', 'merchant-globex', 'poolpay', NULL,
     'ord_globex_001','ACQUIRER', 200, 0, 1000, 'INR',
     '22222222-2222-2222-2222-222222222222', 'ACCRUED', now() - interval '4 days')
ON CONFLICT (entry_id) DO NOTHING;
