-- Test data for reconciliationservice_db. Run AFTER migrations (uses the
-- additive columns from 0001: ageing_bucket, expected_action, evidence,
-- resolved_by, match_level). Idempotent via ON CONFLICT / NOT EXISTS.
--
-- Tenant: tenant-default. Merchants referenced: merchant-acme, merchant-globex.

-- One completed reconciliation run (fixed id for idempotency). Drives
-- lib/slo.ts measureAutoMatch and gives breaks/matches a run_id.
INSERT INTO recon_runs
  (id, tenant_id, window_start, window_end, status, started_at, completed_at,
   items_total, matched_3way, matched_2way, breaks_opened)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'tenant-default',
   now() - interval '1 hour', now() - interval '5 minutes', 'COMPLETED',
   now() - interval '1 hour', now() - interval '4 minutes',
   28, 18, 4, 8)
ON CONFLICT (id) DO UPDATE SET
  status = EXCLUDED.status, completed_at = EXCLUDED.completed_at,
  items_total = EXCLUDED.items_total, matched_3way = EXCLUDED.matched_3way,
  matched_2way = EXCLUDED.matched_2way, breaks_opened = EXCLUDED.breaks_opened;

-- ~8 breaks across statuses (OPEN / INVESTIGATING / RESOLVED) and ageing
-- buckets (0-24h / 1-3d / 3-7d / 7d+), with reasons (expected_action),
-- owners (assignee) and evidence. Idempotent via the
-- (tenant_id, reference, break_type, currency) unique key.
INSERT INTO recon_breaks
  (run_id, tenant_id, reference, break_type, sources_present, amount, currency,
   delta, status, assignee, notes, ageing_bucket, expected_action, evidence,
   opened_at, resolved_at, resolved_by)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'tenant-default',
   'merchant-acme',   'ORPHAN_INTERNAL', 'INTERNAL_ONLY', 150000, 'INR',
   150000, 'OPEN', NULL, NULL, '0-24h', 'request partner record',
   '{"internal_created_at":"now","merchant_id":"merchant-acme"}'::jsonb,
   now() - interval '3 hours', NULL, NULL),

  ('11111111-1111-1111-1111-111111111111', 'tenant-default',
   'txn-acme-8841',   'PARTIAL_MATCH', 'INTERNAL+LEDGER', 89900, 'INR',
   1200, 'OPEN', NULL, NULL, '0-24h', 'investigate',
   '{"internal_created_at":"now","merchant_id":"merchant-acme"}'::jsonb,
   now() - interval '11 hours', NULL, NULL),

  ('11111111-1111-1111-1111-111111111111', 'tenant-default',
   'txn-globex-2207',  'ORPHAN_PARTNER', 'PARTNER_ONLY', 250000, 'INR',
   250000, 'INVESTIGATING', 'ops-anita@katana.dev',
   'Partner posted a payout we have no internal record for.', '1-3d',
   'investigate ghost partner record',
   '{"vendor":"quickpay","pay_id":"pay_globex_2207"}'::jsonb,
   now() - interval '2 days', NULL, NULL),

  ('11111111-1111-1111-1111-111111111111', 'tenant-default',
   'merchant-globex',  'ORPHAN_INTERNAL', 'INTERNAL_ONLY', 47550, 'INR',
   47550, 'INVESTIGATING', 'ops-rahul@katana.dev',
   'Awaiting partner confirmation file.', '1-3d', 'request partner record',
   '{"internal_created_at":"now","merchant_id":"merchant-globex"}'::jsonb,
   now() - interval '2 days 6 hours', NULL, NULL),

  ('11111111-1111-1111-1111-111111111111', 'tenant-default',
   'ledger-9931',      'ORPHAN_LEDGER', 'LEDGER_ONLY', 320000, 'INR',
   320000, 'OPEN', 'ops-anita@katana.dev', NULL, '3-7d',
   'find originating internal txn',
   '{"journal_id":"je-9931","posted_at":"recent"}'::jsonb,
   now() - interval '5 days', NULL, NULL),

  ('11111111-1111-1111-1111-111111111111', 'tenant-default',
   'txn-acme-7012',    'PARTIAL_MATCH', 'INTERNAL+PARTNER', 99900, 'USD',
   500, 'OPEN', NULL, NULL, '3-7d', 'post missing journal',
   '{"internal_created_at":"recent","merchant_id":"merchant-acme"}'::jsonb,
   now() - interval '6 days', NULL, NULL),

  ('11111111-1111-1111-1111-111111111111', 'tenant-default',
   'txn-globex-1003',  'ORPHAN_PARTNER', 'PARTNER_ONLY', 1750000, 'INR',
   1750000, 'OPEN', 'ops-rahul@katana.dev',
   'Stale break — escalate to partner ops.', '7d+',
   'investigate ghost partner record',
   '{"vendor":"poolpay","pay_id":"pay_globex_1003"}'::jsonb,
   now() - interval '9 days', NULL, NULL),

  ('11111111-1111-1111-1111-111111111111', 'tenant-default',
   'txn-acme-5540',    'PARTIAL_MATCH', 'INTERNAL+LEDGER', 60000, 'INR',
   0, 'RESOLVED', 'ops-anita@katana.dev',
   'Manual journal posted; amounts now tie out.', '1-3d', 'investigate',
   '{"internal_created_at":"old","merchant_id":"merchant-acme"}'::jsonb,
   now() - interval '3 days', now() - interval '1 day', 'ops-anita@katana.dev')
ON CONFLICT (tenant_id, reference, break_type, currency) DO UPDATE SET
  run_id = EXCLUDED.run_id, sources_present = EXCLUDED.sources_present,
  amount = EXCLUDED.amount, delta = EXCLUDED.delta, status = EXCLUDED.status,
  assignee = EXCLUDED.assignee, notes = EXCLUDED.notes,
  ageing_bucket = EXCLUDED.ageing_bucket,
  expected_action = EXCLUDED.expected_action, evidence = EXCLUDED.evidence,
  opened_at = EXCLUDED.opened_at, resolved_at = EXCLUDED.resolved_at,
  resolved_by = EXCLUDED.resolved_by;

-- A few matches for the run. recon_matches has no unique key, so guard each
-- INSERT with NOT EXISTS on (run_id, reference, kind).
INSERT INTO recon_matches
  (run_id, tenant_id, reference, amount, currency, kind, internal_id, match_level)
SELECT v.run_id::uuid, 'tenant-default', v.reference, v.amount, v.currency,
       v.kind, NULL, v.match_level
  FROM (VALUES
    ('11111111-1111-1111-1111-111111111111', 'txn-acme-0001',   150000, 'INR', '3WAY', 1),
    ('11111111-1111-1111-1111-111111111111', 'txn-acme-0002',    89900, 'INR', '3WAY', 2),
    ('11111111-1111-1111-1111-111111111111', 'txn-globex-0003', 250000, 'INR', '2WAY', 3),
    ('11111111-1111-1111-1111-111111111111', 'txn-globex-0004',  47550, 'INR', '3WAY', 1)
  ) AS v(run_id, reference, amount, currency, kind, match_level)
 WHERE NOT EXISTS (
   SELECT 1 FROM recon_matches m
    WHERE m.run_id = v.run_id::uuid AND m.reference = v.reference AND m.kind = v.kind
 );
