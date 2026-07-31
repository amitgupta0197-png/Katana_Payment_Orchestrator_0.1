-- Run against providerservice_db (needs migrations 0011–0013 applied).
--
-- Demo DT position for banker 'Meridian Capital', sized so the banker dashboard shows a
-- realistic, healthy picture for the portal walkthrough video:
--
--   DT purchased    70,000 DT        Traffic quota    ₹42,00,000
--   Advance paid    ₹70,00,000       Consumed         ₹22,00,000
--   Active lots     2                Available        ₹18,00,000  (42.9% — GREEN tile)
--   Rolling reserve ₹26,00,000 · 26,000 DT            Utilisation  52.4%
--
-- The "Available traffic" tile turns amber at ≤20% of quota; 42.9% keeps it green.
-- To demo the WARNING state instead, raise lot 1's `consumed` to 26,00,000.
--
-- Split is the standard 60/40 (traffic quota / rolling reserve). Lot 2 has a partial
-- reserve release (₹2,00,000) so the "released only by verified settlement" rule is
-- visible in the numbers rather than just asserted.

-- Katana-controlled DT rate: ₹100 per DT unit.
INSERT INTO dt_rate_cards (id, currency, rate, status, version, created_by)
VALUES ('d0000000-0000-0000-0000-000000000001'::uuid, 'INR', 100.0000, 'ACTIVE', 1, 'seed')
ON CONFLICT (id) DO NOTHING;

-- ── Lot 1 — 50,000 DT × ₹100 = ₹50,00,000 ───────────────────────────────────
INSERT INTO dt_purchases
  (id, banker_id, quantity, buy_rate, total_amount, priority_percent, security_percent,
   rate_version, status, payment_ref, created_by, approved_by, created_at)
VALUES
  ('d0000000-0000-0000-0000-000000000101'::uuid, 'c0000000-0000-0000-0000-000000000001',
   50000, 100.0000, 5000000.00, 60.00, 40.00, 1, 'ACTIVE', 'NEFT-SEED-0001', 'seed', 'seed',
   now() - interval '21 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO traffic_allocations (id, purchase_id, priority_percent, allocated, reserved, consumed, status)
VALUES ('d0000000-0000-0000-0000-000000000201'::uuid, 'd0000000-0000-0000-0000-000000000101'::uuid,
        60.00, 3000000.00, 150000.00, 1800000.00, 'ACTIVE')
ON CONFLICT (id) DO NOTHING;

INSERT INTO security_reserves (id, purchase_id, reserve_percent, held, released, status)
VALUES ('d0000000-0000-0000-0000-000000000301'::uuid, 'd0000000-0000-0000-0000-000000000101'::uuid,
        40.00, 2000000.00, 0.00, 'HELD')
ON CONFLICT (id) DO NOTHING;

-- ── Lot 2 — 20,000 DT × ₹100 = ₹20,00,000 (partially released reserve) ──────
INSERT INTO dt_purchases
  (id, banker_id, quantity, buy_rate, total_amount, priority_percent, security_percent,
   rate_version, status, payment_ref, created_by, approved_by, created_at)
VALUES
  ('d0000000-0000-0000-0000-000000000102'::uuid, 'c0000000-0000-0000-0000-000000000001',
   20000, 100.0000, 2000000.00, 60.00, 40.00, 1, 'ACTIVE', 'NEFT-SEED-0002', 'seed', 'seed',
   now() - interval '6 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO traffic_allocations (id, purchase_id, priority_percent, allocated, reserved, consumed, status)
VALUES ('d0000000-0000-0000-0000-000000000202'::uuid, 'd0000000-0000-0000-0000-000000000102'::uuid,
        60.00, 1200000.00, 50000.00, 400000.00, 'ACTIVE')
ON CONFLICT (id) DO NOTHING;

INSERT INTO security_reserves (id, purchase_id, reserve_percent, held, released, status)
VALUES ('d0000000-0000-0000-0000-000000000302'::uuid, 'd0000000-0000-0000-0000-000000000102'::uuid,
        40.00, 800000.00, 200000.00, 'PARTIALLY_RELEASED')
ON CONFLICT (id) DO NOTHING;

-- ── Commission entries — the 5.75 / 4.50 / 1.25 waterfall on consumed traffic ─
-- Invariant the engine asserts on every row: merchant_charge − banker_commission = katana_margin.
INSERT INTO commission_entries
  (id, transaction_ref, purchase_lot, base_amount, merchant_charge, banker_commission, katana_margin, rule_version, created_at)
VALUES
  ('d0000000-0000-0000-0000-000000000401'::uuid, 'SEED-TXN-0001', 'd0000000-0000-0000-0000-000000000101'::uuid,
   1800000.00, 103500.00, 81000.00, 22500.00, 1, now() - interval '9 days'),
  ('d0000000-0000-0000-0000-000000000402'::uuid, 'SEED-TXN-0002', 'd0000000-0000-0000-0000-000000000102'::uuid,
   400000.00, 23000.00, 18000.00, 5000.00, 1, now() - interval '3 days')
ON CONFLICT (id) DO NOTHING;
