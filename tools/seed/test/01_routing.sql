-- Test data for routingengineservice_db. Run AFTER migrations (needs the
-- additive columns from 0001/0002). Idempotent via ON CONFLICT.

-- Rails: three providers across PAYIN methods + a PAYOUT rail.
INSERT INTO rails (provider, method, direction, enabled, weight, mdr_bps, kill_switch) VALUES
  ('poolpay',  'UPI_INTENT',  'PAYIN',  true,  120, 90,  false),
  ('poolpay',  'UPI_COLLECT', 'PAYIN',  true,  100, 95,  false),
  ('poolpay',  'CARD',        'PAYIN',  true,   80, 180, false),
  ('quickpay', 'UPI_INTENT',  'PAYIN',  true,  110, 85,  false),
  ('quickpay', 'NETBANKING',  'PAYIN',  true,   70, 150, false),
  ('quickpay', 'CARD',        'PAYIN',  true,   90, 175, true),   -- killed rail (demo)
  ('swiftbank','UPI_INTENT',  'PAYIN',  true,   60, 100, false),
  ('poolpay',  'UPI_PAYOUT',  'PAYOUT', true,  100, 40,  false),
  ('quickpay', 'IMPS',        'PAYOUT', true,   80, 50,  false)
ON CONFLICT (provider, method, direction) DO NOTHING;

UPDATE rails SET kill_switch_reason = 'High decline rate observed (demo)',
                 kill_switch_at = now() - interval '2 hours',
                 kill_switch_by = 'admin@katana.dev'
 WHERE provider = 'quickpay' AND method = 'CARD' AND direction = 'PAYIN' AND kill_switch = true;

-- Provider health snapshots + circuit state.
INSERT INTO provider_health_snapshot
  (provider_code, success_rate, p95_latency_ms, failure_rate, utilization,
   circuit_state, consecutive_failures, last_success_at, updated_at) VALUES
  ('poolpay',  0.9930, 240, 0.0070, 0.62, 'CLOSED',    0, now() - interval '30 seconds', now()),
  ('quickpay', 0.9710, 410, 0.0290, 0.48, 'HALF_OPEN', 2, now() - interval '4 minutes',  now()),
  ('swiftbank',0.8450, 980, 0.1550, 0.91, 'OPEN',      7, now() - interval '22 minutes', now())
ON CONFLICT (provider_code) DO UPDATE SET
  success_rate = EXCLUDED.success_rate, p95_latency_ms = EXCLUDED.p95_latency_ms,
  failure_rate = EXCLUDED.failure_rate, utilization = EXCLUDED.utilization,
  circuit_state = EXCLUDED.circuit_state, consecutive_failures = EXCLUDED.consecutive_failures,
  last_success_at = EXCLUDED.last_success_at, updated_at = EXCLUDED.updated_at;

UPDATE provider_health_snapshot
   SET circuit_opened_at = now() - interval '22 minutes', last_failure_at = now() - interval '20 minutes'
 WHERE provider_code = 'swiftbank';
UPDATE provider_health_snapshot
   SET half_open_at = now() - interval '1 minute', last_failure_at = now() - interval '4 minutes'
 WHERE provider_code = 'quickpay';

-- One A/B experiment (cost-leaning variant), enabled on UPI_INTENT.
INSERT INTO routing_experiments
  (name, description, control_weights, variant_weights, traffic_split, method_scope, enabled, started_at, created_by) VALUES
  ('upi-cost-tilt-2026q2',
   'Shift 10% weight from success-rate to cost on UPI_INTENT to test margin impact.',
   '{"success_rate":0.35,"latency":0.15,"cost":0.10,"health":0.20,"risk":0.05,"failure_penalty":0.10,"capacity_penalty":0.05}'::jsonb,
   '{"success_rate":0.25,"latency":0.15,"cost":0.20,"health":0.20,"risk":0.05,"failure_penalty":0.10,"capacity_penalty":0.05}'::jsonb,
   0.30, 'UPI_INTENT', true, now() - interval '3 days', 'admin@katana.dev')
ON CONFLICT (name) DO NOTHING;

-- A few routing decisions for the trace view. Fixed ids so re-runs are idempotent.
INSERT INTO routing_decisions
  (id, selected_provider, merchant_id, method, amount_minor, currency, selected_rank, decided_at,
   cascade_ranks, factors, weights_applied) VALUES
  ('d0000000-0000-0000-0000-000000000001',
   'poolpay',  'merchant-acme',  'UPI_INTENT', 150000, 'INR', 1, now() - interval '5 minutes',
   '[{"rank":1,"provider":"poolpay","score":0.91},{"rank":2,"provider":"quickpay","score":0.86}]'::jsonb,
   '{"poolpay":{"recent_success_rate":0.993,"inverse_fee_score":0.7}}'::jsonb,
   '{"success_rate":0.35,"latency":0.15,"cost":0.10,"health":0.20,"risk":0.05,"failure_penalty":0.10,"capacity_penalty":0.05}'::jsonb),
  ('d0000000-0000-0000-0000-000000000002',
   'quickpay', 'merchant-globex', 'UPI_INTENT', 89900,  'INR', 1, now() - interval '12 minutes',
   '[{"rank":1,"provider":"quickpay","score":0.88},{"rank":2,"provider":"poolpay","score":0.85}]'::jsonb,
   '{"quickpay":{"recent_success_rate":0.971,"inverse_fee_score":0.75}}'::jsonb,
   '{"success_rate":0.25,"latency":0.15,"cost":0.20,"health":0.20,"risk":0.05,"failure_penalty":0.10,"capacity_penalty":0.05}'::jsonb),
  ('d0000000-0000-0000-0000-000000000003',
   'poolpay',  'merchant-acme',  'CARD',       2500000,'INR', 1, now() - interval '40 minutes',
   '[{"rank":1,"provider":"poolpay","score":0.83}]'::jsonb,
   '{"poolpay":{"recent_success_rate":0.993,"inverse_fee_score":0.4}}'::jsonb,
   '{"success_rate":0.35,"latency":0.15,"cost":0.10,"health":0.20,"risk":0.05,"failure_penalty":0.10,"capacity_penalty":0.05}'::jsonb)
ON CONFLICT (id) DO NOTHING;
