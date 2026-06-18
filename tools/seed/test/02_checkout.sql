-- Test data for checkoutservice_db. Run AFTER all checkout migrations
-- (0000_base .. 0004_refunds), so columns added by 0001-0004 are available.
-- Idempotent: re-running is safe (guarded inserts + ON CONFLICT DO NOTHING).
--
-- Feeds these dashboard pages:
--   /checkout, /payin-order, /payin-data  -> GET /api/checkout  (checkout_orders + checkout_attempts)
--   /payout-order                          -> GET /api/payout    (payoutservice_db, NOT seeded here)
--   /admin/refunds                         -> GET /api/refunds   (refunds, checkout/0004)
--   /admin/tokens                          -> GET /api/tokens    (payment_tokens, checkout/0003)
--
-- Note: /payout-order reads payoutservice_db.payout_requests, a different
-- service DB outside checkoutservice_db, so it is intentionally not seeded by
-- this file.
--
-- Deterministic UUIDs are used for order ids so attempts / transitions /
-- refunds can reference them across re-runs.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- 1. checkout_orders (~8 rows, mix of statuses).
--    checkout_orders pre-exists; insert is guarded on the PK so re-runs are
--    no-ops. amount_minor (bigint, added by 0001) is populated for every row;
--    amount mirrors it in major units. currency INR; merchants acme + globex.
-- ---------------------------------------------------------------------------
INSERT INTO checkout_orders
  (id, tenant_id, merchant_id, client_ref, txn_id, amount, amount_minor, currency,
   method, selected_rail, status, idempotency_key, customer_email, created_at)
SELECT v.id::uuid, 'tenant-default', v.merchant_id, v.client_ref, v.txn_id,
       v.amount, v.amount_minor, 'INR', v.method, v.selected_rail, v.status,
       v.idempotency_key, v.customer_email, now() - v.age
FROM (VALUES
  ('11111111-1111-1111-1111-000000000001','merchant-acme',  'ord-acme-1001','TXN-SEED0001',1500.00, 150000::bigint,'UPI_INTENT','poolpay',  'SUCCESS',          'seed-idem-0001','riya@acme.example',   interval '5 minutes'),
  ('11111111-1111-1111-1111-000000000002','merchant-acme',  'ord-acme-1002','TXN-SEED0002', 899.00,  89900::bigint,'UPI_COLLECT','quickpay', 'PENDING',          'seed-idem-0002','sam@acme.example',    interval '18 minutes'),
  ('11111111-1111-1111-1111-000000000003','merchant-acme',  'ord-acme-1003','TXN-SEED0003',25000.00,2500000::bigint,'CARD',      'poolpay',  'AUTH_CHALLENGE',   'seed-idem-0003','meera@acme.example',  interval '40 minutes'),
  ('11111111-1111-1111-1111-000000000004','merchant-acme',  'ord-acme-1004','TXN-SEED0004', 499.00,  49900::bigint,'CARD',       'poolpay',  'FAILED',           'seed-idem-0004','arjun@acme.example',  interval '2 hours'),
  ('11111111-1111-1111-1111-000000000005','merchant-globex','ord-globex-2001','TXN-SEED0005',3200.00,320000::bigint,'UPI_INTENT','quickpay', 'SUCCESS',          'seed-idem-0005','lee@globex.example',  interval '1 hour'),
  ('11111111-1111-1111-1111-000000000006','merchant-globex','ord-globex-2002','TXN-SEED0006',7500.00,750000::bigint,'NETBANKING','quickpay', 'PROCESSING',       'seed-idem-0006','noah@globex.example', interval '3 hours'),
  ('11111111-1111-1111-1111-000000000007','merchant-globex','ord-globex-2003','TXN-SEED0007',1200.00,120000::bigint,'CARD',       'poolpay',  'REFUNDED',         'seed-idem-0007','ava@globex.example',  interval '2 days'),
  ('11111111-1111-1111-1111-000000000008','merchant-globex','ord-globex-2004','TXN-SEED0008', 650.00,  65000::bigint,'WALLET',    'poolpay',  'PARTIALLY_REFUNDED','seed-idem-0008','kai@globex.example',  interval '1 day')
) AS v(id, merchant_id, client_ref, txn_id, amount, amount_minor, method, selected_rail, status, idempotency_key, customer_email, age)
WHERE NOT EXISTS (SELECT 1 FROM checkout_orders o WHERE o.id = v.id::uuid);

-- ---------------------------------------------------------------------------
-- 2. checkout_attempts (1-2 per order). attempt_no / auth_status / next_state /
--    response_time_ms come from 0001. Guarded on PK.
-- ---------------------------------------------------------------------------
INSERT INTO checkout_attempts
  (id, order_id, attempt_no, rail_provider, rail_method, status, rail_ref,
   next_state, auth_status, exemption_reason, error_code, error_message,
   response_time_ms, raw_response, started_at, completed_at)
SELECT v.id::uuid, v.order_id::uuid, v.attempt_no, v.rail_provider, v.rail_method,
       v.status, v.rail_ref, v.next_state, v.auth_status, v.exemption_reason,
       v.error_code, v.error_message, v.response_time_ms, v.raw_response::jsonb,
       now() - v.age, now() - v.age + interval '1 second'
FROM (VALUES
  -- order 1: success on first attempt (UPI, no SCA)
  ('a1111111-0000-0000-0000-000000000001','11111111-1111-1111-1111-000000000001',1,'poolpay','UPI_INTENT','SUCCESS','POOL-REF-0001','SUCCESS','NOT_REQUIRED',NULL,NULL,NULL,231,'{"provider":"poolpay","ok":true}', interval '5 minutes'),
  -- order 2: pending (UPI collect awaiting customer)
  ('a1111111-0000-0000-0000-000000000002','11111111-1111-1111-1111-000000000002',1,'quickpay','UPI_COLLECT','PENDING','QUICK-REF-0002','PENDING','NOT_REQUIRED',NULL,NULL,NULL,402,'{"provider":"quickpay","ok":true}', interval '18 minutes'),
  -- order 3: card with 3DS challenge required
  ('a1111111-0000-0000-0000-000000000003','11111111-1111-1111-1111-000000000003',1,'poolpay','CARD','AUTH_CHALLENGE','POOL-REF-0003','AUTH_CHALLENGE','CHALLENGE_REQUIRED',NULL,NULL,NULL,615,'{"provider":"poolpay","challenge":true}', interval '40 minutes'),
  -- order 4: first attempt transient fail, second hard fail
  ('a1111111-0000-0000-0000-000000000004','11111111-1111-1111-1111-000000000004',1,'poolpay','CARD','FAILED','POOL-REF-0004A','FAILED','FRICTIONLESS',NULL,'TIMEOUT','provider timed out',5012,'{"provider":"poolpay","error":"TIMEOUT"}', interval '2 hours'),
  ('a1111111-0000-0000-0000-000000000005','11111111-1111-1111-1111-000000000004',2,'quickpay','CARD','FAILED','QUICK-REF-0004B','FAILED','FRICTIONLESS',NULL,'DO_NOT_HONOR','issuer declined',743,'{"provider":"quickpay","error":"DO_NOT_HONOR"}', interval '2 hours'),
  -- order 5: success (UPI)
  ('a1111111-0000-0000-0000-000000000006','11111111-1111-1111-1111-000000000005',1,'quickpay','UPI_INTENT','SUCCESS','QUICK-REF-0005','SUCCESS','NOT_REQUIRED',NULL,NULL,NULL,288,'{"provider":"quickpay","ok":true}', interval '1 hour'),
  -- order 6: processing (netbanking)
  ('a1111111-0000-0000-0000-000000000007','11111111-1111-1111-1111-000000000006',1,'quickpay','NETBANKING','PROCESSING','QUICK-REF-0006','PROCESSING','NOT_REQUIRED',NULL,NULL,NULL,520,'{"provider":"quickpay","ok":true}', interval '3 hours'),
  -- order 7: success that was later refunded (card, LVP exemption)
  ('a1111111-0000-0000-0000-000000000008','11111111-1111-1111-1111-000000000007',1,'poolpay','CARD','SUCCESS','POOL-REF-0007','SUCCESS','EXEMPTED','LOW_VALUE_PAYMENT',NULL,NULL,344,'{"provider":"poolpay","ok":true}', interval '2 days'),
  -- order 8: success later partially refunded (wallet)
  ('a1111111-0000-0000-0000-000000000009','11111111-1111-1111-1111-000000000008',1,'poolpay','WALLET','SUCCESS','POOL-REF-0008','SUCCESS','NOT_REQUIRED',NULL,NULL,NULL,199,'{"provider":"poolpay","ok":true}', interval '1 day')
) AS v(id, order_id, attempt_no, rail_provider, rail_method, status, rail_ref, next_state, auth_status, exemption_reason, error_code, error_message, response_time_ms, raw_response, age)
WHERE NOT EXISTS (SELECT 1 FROM checkout_attempts a WHERE a.id = v.id::uuid);

-- ---------------------------------------------------------------------------
-- 3. order_state_transitions (from checkout/0001). Guarded on PK.
-- ---------------------------------------------------------------------------
INSERT INTO order_state_transitions
  (id, order_id, from_status, to_status, actor_kind, actor_id, reason, occurred_at)
SELECT v.id::uuid, v.order_id::uuid, v.from_status, v.to_status, v.actor_kind,
       v.actor_id, v.reason, now() - v.age
FROM (VALUES
  ('b1111111-0000-0000-0000-000000000001','11111111-1111-1111-1111-000000000001',NULL,    'CREATED','system','seed','order created',         interval '5 minutes'),
  ('b1111111-0000-0000-0000-000000000002','11111111-1111-1111-1111-000000000001','CREATED','SUCCESS','system','seed','adapter poolpay SUCCESS', interval '5 minutes'),
  ('b1111111-0000-0000-0000-000000000003','11111111-1111-1111-1111-000000000003',NULL,    'CREATED','system','seed','order created',         interval '40 minutes'),
  ('b1111111-0000-0000-0000-000000000004','11111111-1111-1111-1111-000000000003','CREATED','AUTH_CHALLENGE','system','seed','3DS challenge',   interval '40 minutes'),
  ('b1111111-0000-0000-0000-000000000005','11111111-1111-1111-1111-000000000004','CREATED','FAILED','system','seed','all attempts failed',    interval '2 hours'),
  ('b1111111-0000-0000-0000-000000000006','11111111-1111-1111-1111-000000000007','SUCCESS','REFUNDED','admin','seed','full refund',           interval '2 days')
) AS v(id, order_id, from_status, to_status, actor_kind, actor_id, reason, age)
WHERE NOT EXISTS (SELECT 1 FROM order_state_transitions t WHERE t.id = v.id::uuid);

-- ---------------------------------------------------------------------------
-- 4. refunds (from checkout/0004). Guarded on PK (refund_id).
-- ---------------------------------------------------------------------------
INSERT INTO refunds
  (refund_id, tenant_id, order_id, txn_id, merchant_id, amount_minor, currency,
   reason, status, partial, requested_by, requested_at, posted_at)
SELECT v.refund_id::uuid, 'tenant-default', v.order_id::uuid, v.txn_id,
       v.merchant_id, v.amount_minor, 'INR', v.reason, v.status, v.partial,
       v.requested_by, now() - v.age, v.posted
FROM (VALUES
  ('c1111111-0000-0000-0000-000000000001','11111111-1111-1111-1111-000000000007','TXN-SEED0007','merchant-globex',120000::bigint,'customer_request','POSTED',  false,'admin@katana.dev', now() - interval '2 days', interval '2 days'),
  ('c1111111-0000-0000-0000-000000000002','11111111-1111-1111-1111-000000000008','TXN-SEED0008','merchant-globex', 30000::bigint,'partial_return', 'POSTED',  true, 'admin@katana.dev', now() - interval '1 day',  interval '1 day'),
  ('c1111111-0000-0000-0000-000000000003','11111111-1111-1111-1111-000000000001','TXN-SEED0001','merchant-acme',   50000::bigint,'duplicate_charge','PENDING', true, 'ops@katana.dev',   NULL,                      interval '10 minutes')
) AS v(refund_id, order_id, txn_id, merchant_id, amount_minor, reason, status, partial, requested_by, posted, age)
WHERE NOT EXISTS (SELECT 1 FROM refunds r WHERE r.refund_id = v.refund_id::uuid);

-- ---------------------------------------------------------------------------
-- 5. payment_tokens (from checkout/0003). provider_token_hash is the sha256 the
--    vault would store; we use a deterministic placeholder hash. Guarded on PK.
-- ---------------------------------------------------------------------------
INSERT INTO payment_tokens
  (token_id, tenant_id, customer_ref, merchant_id, provider, provider_token_hash,
   network_token_id, method, brand, last4, exp_month, exp_year, status,
   created_at, last_used_at)
SELECT v.token_id::uuid, 'tenant-default', v.customer_ref, v.merchant_id,
       v.provider, encode(digest(v.token_id, 'sha256'), 'hex'),
       v.network_token_id, v.method, v.brand, v.last4, v.exp_month, v.exp_year,
       v.status, now() - v.age, v.last_used
FROM (VALUES
  ('d1111111-0000-0000-0000-000000000001','riya@acme.example',  'merchant-acme',  'POOLPAY', 'NTID-VISA-9001','CARD','VISA','4242',11,2028,'ACTIVE',   interval '20 days', now() - interval '5 minutes'),
  ('d1111111-0000-0000-0000-000000000002','sam@acme.example',   'merchant-acme',  'QUICKPAY',NULL,            'UPI', 'UPI', NULL,  NULL,NULL,'ACTIVE',   interval '12 days', NULL),
  ('d1111111-0000-0000-0000-000000000003','lee@globex.example', 'merchant-globex','POOLPAY', 'NTID-MC-9002',  'CARD','MC',  '5454', 4,2027,'ACTIVE',   interval '8 days',  now() - interval '1 hour'),
  ('d1111111-0000-0000-0000-000000000004','noah@globex.example','merchant-globex','QUICKPAY',NULL,            'WALLET','UPI',NULL, NULL,NULL,'SUSPENDED',interval '60 days', now() - interval '40 days')
) AS v(token_id, customer_ref, merchant_id, provider, network_token_id, method, brand, last4, exp_month, exp_year, status, age, last_used)
WHERE NOT EXISTS (SELECT 1 FROM payment_tokens p WHERE p.token_id = v.token_id::uuid);
