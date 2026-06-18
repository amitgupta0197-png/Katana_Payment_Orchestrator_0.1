-- 05_audit_notification.sql
-- Idempotent SEED data (NO schema changes) for the audit + notification dashboards.
-- Tables already exist via tools/migrations/audit/* and tools/migrations/notification/*.
--
-- Each table lives in exactly ONE database. The runner must split this file on the
-- two headers below and apply each section against its own DB:
--   -- ==== DB: auditservice_db ====        -> event_stream, worm_audit_log,
--                                              worm_audit_chain_head, slo_observations,
--                                              incidents, anomaly_groups, dr_drills,
--                                              hardening_checks (status update only)
--   -- ==== DB: notificationservice_db ==== -> merchant_webhook_configs, webhook_outbox,
--                                              webhook_dispatch_attempts
--
-- Safe under: psql -v ON_ERROR_STOP=1
-- No \c meta-commands. Merchant ids: 'merchant-acme', 'merchant-globex'.


-- ============================================================================
-- ==== DB: auditservice_db ====
-- ============================================================================

-- ----------------------------------------------------------------------------
-- event_stream (pages /events, /admin-log feed) — 10 rows.
-- event_id has no natural unique key besides PK (random uuid), so guard with
-- WHERE NOT EXISTS on a deterministic (entity_type, entity_id, event_type) tuple.
-- ----------------------------------------------------------------------------
INSERT INTO event_stream (tenant_id, event_type, producer, entity_type, entity_id, actor_id, payload, created_at)
SELECT v.tenant_id, v.event_type, v.producer, v.entity_type, v.entity_id, v.actor_id, v.payload::jsonb, now() - v.age::interval
FROM (VALUES
  ('tenant-default','merchant.created',           'merchant_onboarding','merchant','merchant-acme',   'admin@katana.io',   '{"legal_name":"Acme Payments Pvt Ltd","mcc":"5732"}',                       '6 days'),
  ('tenant-default','submid.status_changed',       'sub_mid_engine',     'sub_mid', 'submid-acme-01',   'admin@katana.io',   '{"from":"PENDING","to":"ACTIVE","provider":"razorpay"}',                     '5 days'),
  ('tenant-default','payment.created',             'payment_core',       'payment', 'pay-1001',         'merchant-acme',     '{"amount_minor":250000,"currency":"INR","order_id":"ord-1001"}',             '3 hours'),
  ('tenant-default','route.selected',              'routing_engine',     'route',   'pay-1001',         null,                '{"provider":"razorpay","reason":"lowest_cost","score":0.92}',                '178 minutes'),
  ('tenant-default','payment.succeeded',           'payment_core',       'payment', 'pay-1001',         null,                '{"amount_minor":250000,"currency":"INR","provider":"razorpay"}',             '175 minutes'),
  ('tenant-default','callback.received',           'callback_engine',    'callback','cb-9001',          null,                '{"provider":"razorpay","status":"captured","payment_id":"pay-1001"}',        '174 minutes'),
  ('tenant-default','settlement.calculated',       'settlement_engine',  'settlement','setl-acme-2026-06-17','system',       '{"gross_minor":250000,"fee_minor":7500,"net_minor":242500}',                 '2 hours'),
  ('tenant-default','reconciliation.break_opened', 'reconciliation',     'break',   'break-3001',       'system',            '{"merchant_id":"merchant-globex","expected_minor":99900,"actual_minor":0}', '90 minutes'),
  ('tenant-default','risk.alert',                  'risk_engine',        'risk',    'risk-7001',        'system',            '{"merchant_id":"merchant-globex","rule":"velocity","score":0.81}',           '40 minutes'),
  ('tenant-default','provider.kyc_decided',        'provider_mgmt',      'provider','provider-razorpay','reviewer@katana.io','{"decision":"APPROVED","merchant_id":"merchant-acme"}',                      '20 minutes')
) AS v(tenant_id, event_type, producer, entity_type, entity_id, actor_id, payload, age)
WHERE NOT EXISTS (
  SELECT 1 FROM event_stream e
  WHERE e.entity_type = v.entity_type AND e.entity_id = v.entity_id AND e.event_type = v.event_type
);

-- ----------------------------------------------------------------------------
-- worm_audit_log (page /admin-log) — 6 rows. Append-only table (UPDATE/DELETE
-- denied by rule), so guard inserts with WHERE NOT EXISTS on (action, resource_id).
-- prev_hash/hash are illustrative chained sha256-style hex strings.
-- ----------------------------------------------------------------------------
INSERT INTO worm_audit_log (tenant_id, actor_id, actor_email, action, resource_type, resource_id, before_value, after_value, notes, prev_hash, hash, created_at)
SELECT v.tenant_id, v.actor_id, v.actor_email, v.action, v.resource_type, v.resource_id,
       v.before_value::jsonb, v.after_value::jsonb, v.notes, v.prev_hash, v.hash, now() - v.age::interval
FROM (VALUES
  ('tenant-default','reviewer@katana.io','reviewer@katana.io','provider.kyc.approve','provider','provider-razorpay','{"status":"PENDING"}','{"status":"APPROVED"}','KYC docs verified',
     '',                                                                 '8f1ad0e2c4b3a6f7d9e0c1b2a3948576655443322110ffeeddccbbaa99887766', '7 days'),
  ('tenant-default','admin@katana.io','admin@katana.io','merchant.advance','merchant','merchant-acme','{"stage":"ONBOARDING"}','{"stage":"LIVE"}','Advanced to live after sub-MID active',
     '8f1ad0e2c4b3a6f7d9e0c1b2a3948576655443322110ffeeddccbbaa99887766', 'a2c3e4f50617283940516273849506a7b8c9d0e1f2031425364758697a8b9c0d', '6 days'),
  ('tenant-default','admin@katana.io','admin@katana.io','submid.activate','sub_mid','submid-acme-01','{"status":"PENDING"}','{"status":"ACTIVE"}','Provider returned live MID',
     'a2c3e4f50617283940516273849506a7b8c9d0e1f2031425364758697a8b9c0d', 'b3d4f5061728394a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2', '5 days'),
  ('tenant-default','ops@katana.io','ops@katana.io','webhook.discard','webhook_outbox','wh-dead-2001','{"status":"DEAD_LETTER"}','{"status":"DEAD_LETTER","discarded":true}','Permanently discarded after merchant confirmed bad endpoint',
     'b3d4f5061728394a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2', 'c4e5061728394a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3', '2 days'),
  ('tenant-default','ops@katana.io','ops@katana.io','incident.investigating','incident','inc-noc-01','{"status":"OPEN"}','{"status":"INVESTIGATING"}','On-call engaged, paging payments team',
     'c4e5061728394a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3', 'd5061728394a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4', '90 minutes'),
  ('tenant-default','reviewer@katana.io','reviewer@katana.io','dr.drill.passed','dr_drill','drill-backup-2026-06','{"status":"RUNNING"}','{"status":"PASSED","rto_observed_minutes":42}','Monthly backup restore drill within RTO',
     'd5061728394a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4', 'e6172839405160718293a4b5c6d7e8f9a0b1c2d3e4f5061728394a5b6c7d8e9f', '1 day')
) AS v(tenant_id, actor_id, actor_email, action, resource_type, resource_id, before_value, after_value, notes, prev_hash, hash, age)
WHERE NOT EXISTS (
  SELECT 1 FROM worm_audit_log w WHERE w.action = v.action AND w.resource_id = v.resource_id
);

-- Chain head convenience row (PK = tenant_id => ON CONFLICT DO NOTHING).
INSERT INTO worm_audit_chain_head (tenant_id, last_hash, last_log_id, updated_at)
SELECT 'tenant-default',
       'e6172839405160718293a4b5c6d7e8f9a0b1c2d3e4f5061728394a5b6c7d8e9f',
       (SELECT log_id FROM worm_audit_log WHERE action = 'dr.drill.passed' AND resource_id = 'drill-backup-2026-06' LIMIT 1),
       now() - interval '1 day'
WHERE EXISTS (SELECT 1 FROM worm_audit_log WHERE action = 'dr.drill.passed' AND resource_id = 'drill-backup-2026-06')
ON CONFLICT (tenant_id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- slo_observations (page /admin/noc). slo_targets are already seeded by
-- migration 0003. Attach observations to each target by name. 10 rows total
-- (a recent + an older sample per target). Guard with WHERE NOT EXISTS keyed
-- on (target_id, observed_at) which is unique enough for seed purposes.
-- status enum: OK | WARN | BREACH.
-- ----------------------------------------------------------------------------
INSERT INTO slo_observations (target_id, measured_value, status, detail, observed_at)
SELECT t.target_id, v.measured_value, v.status, v.detail::jsonb, now() - v.age::interval
FROM (VALUES
  ('payment_api_availability', 0.9997, 'OK',     '{"window_minutes":60,"burn_rate":0.4}',  '5 minutes'),
  ('payment_api_availability', 0.9991, 'WARN',   '{"window_minutes":60,"burn_rate":1.8}',  '3 hours'),
  ('payment_routing_latency',  287.0,  'OK',     '{"window_minutes":10,"unit":"ms"}',      '5 minutes'),
  ('payment_routing_latency',  412.0,  'BREACH', '{"window_minutes":10,"unit":"ms","burn_rate":2.4}', '95 minutes'),
  ('webhook_processing_sla',   0.992,  'OK',     '{"window_minutes":60,"delivered_lt_60s":0.992}', '5 minutes'),
  ('webhook_processing_sla',   0.971,  'WARN',   '{"window_minutes":60,"delivered_lt_60s":0.971}', '4 hours'),
  ('settlement_sync_sla',      0.995,  'OK',     '{"window_minutes":1440}',                '30 minutes'),
  ('settlement_sync_sla',      0.982,  'WARN',   '{"window_minutes":1440}',                '20 hours'),
  ('reconciliation_sla',       0.961,  'OK',     '{"window_minutes":1440,"auto_match_pct":0.961}', '30 minutes'),
  ('reconciliation_sla',       0.918,  'BREACH', '{"window_minutes":1440,"auto_match_pct":0.918,"burn_rate":1.7}', '22 hours')
) AS v(target_name, measured_value, status, detail, age)
JOIN slo_targets t ON t.name = v.target_name
WHERE NOT EXISTS (
  SELECT 1 FROM slo_observations o
  WHERE o.target_id = t.target_id AND o.status = v.status AND o.measured_value = v.measured_value
);

-- ----------------------------------------------------------------------------
-- incidents (page /admin/noc) — 5 rows across the lifecycle.
-- severity: SEV1..SEV4 ; status: OPEN|INVESTIGATING|MITIGATING|RESOLVED|POST_MORTEM
-- source: slo_breach|manual|risk|webhook_dlq|recon_sla
-- No natural unique key, so guard on a deterministic title.
-- related_target points at the matching SLO target where relevant.
-- ----------------------------------------------------------------------------
INSERT INTO incidents (tenant_id, severity, status, source, title, summary, related_target, related_entities, opened_at, opened_by, acked_at, resolved_at, resolved_by, resolution_notes)
SELECT v.tenant_id, v.severity, v.status, v.source, v.title, v.summary,
       (SELECT target_id FROM slo_targets WHERE name = v.target_name),
       v.related_entities::jsonb,
       now() - v.opened_age::interval,
       v.opened_by,
       CASE WHEN v.acked_age   IS NULL THEN NULL ELSE now() - v.acked_age::interval   END,
       CASE WHEN v.resolved_age IS NULL THEN NULL ELSE now() - v.resolved_age::interval END,
       v.resolved_by, v.resolution_notes
FROM (VALUES
  ('tenant-default','SEV2','INVESTIGATING','slo_breach','Routing latency p95 above 300ms',
     'p95 charge latency breached the 300ms SLO for the routing engine.', 'payment_routing_latency',
     '{"kind":"slo_target","detail":{"target":"payment_routing_latency"}}',
     '95 minutes','ops@katana.io', text '90 minutes', NULL::text, '', NULL::text),
  ('tenant-default','SEV3','OPEN','webhook_dlq','Globex webhook endpoint dead-lettering',
     'Multiple webhooks to merchant-globex moved to DEAD_LETTER after 5 attempts.', NULL,
     '{"kind":"merchant","detail":{"merchant_id":"merchant-globex"}}',
     '70 minutes','system', NULL::text, NULL::text, '', NULL::text),
  ('tenant-default','SEV1','MITIGATING','risk','Velocity fraud spike on Globex',
     'Risk engine flagged a velocity anomaly; manual review hold applied.', NULL,
     '{"kind":"merchant","detail":{"merchant_id":"merchant-globex","rule":"velocity"}}',
     '40 minutes','risk@katana.io', text '38 minutes', NULL::text, '', NULL::text),
  ('tenant-default','SEV2','RESOLVED','recon_sla','Reconciliation auto-match below 95%',
     'Auto-match dropped below SLA after a provider file delay; re-ingested.', 'reconciliation_sla',
     '{"kind":"slo_target","detail":{"target":"reconciliation_sla"}}',
     '22 hours','ops@katana.io', text '21 hours', text '20 hours','ops@katana.io', text 'Provider file re-ingested; auto-match recovered to 96%.'),
  ('tenant-default','SEV4','POST_MORTEM','manual','Planned failover drill follow-ups',
     'Action items captured from the monthly DR failover drill.', NULL,
     '{"kind":"dr_drill","detail":{"kind":"failover"}}',
     '3 days','reviewer@katana.io', text '3 days', text '2 days','reviewer@katana.io', text 'Follow-up tickets filed; alerting delay addressed.')
) AS v(tenant_id, severity, status, source, title, summary, target_name, related_entities,
       opened_age, opened_by, acked_age, resolved_age, resolved_by, resolution_notes)
WHERE NOT EXISTS (SELECT 1 FROM incidents i WHERE i.title = v.title);

-- ----------------------------------------------------------------------------
-- anomaly_groups (page /admin/ai-ops) — 5 rows.
-- UNIQUE (signal_kind, entity_type, event_type, bucket_start) => ON CONFLICT DO NOTHING.
-- severity: INFO | WARN | ALERT. sample_ids is text[].
-- ----------------------------------------------------------------------------
INSERT INTO anomaly_groups (tenant_id, signal_kind, entity_type, event_type, bucket_start, bucket_end, signal_count, sample_ids, severity, detail)
VALUES
  ('tenant-default','event_burst','payment','payment.created',
     date_trunc('hour', now() - interval '2 hours'), date_trunc('hour', now() - interval '1 hour'),
     42, ARRAY['pay-1001','pay-1002','pay-1003','pay-1004','pay-1005'], 'ALERT',
     '{"threshold":5,"observed":42,"merchant_id":"merchant-acme"}'::jsonb),
  ('tenant-default','event_burst','callback','callback.received',
     date_trunc('hour', now() - interval '2 hours'), date_trunc('hour', now() - interval '1 hour'),
     18, ARRAY['cb-9001','cb-9002','cb-9003'], 'WARN',
     '{"threshold":5,"observed":18}'::jsonb),
  ('tenant-default','event_burst','risk','risk.alert',
     date_trunc('hour', now() - interval '1 hour'), date_trunc('hour', now()),
     9, ARRAY['risk-7001','risk-7002'], 'WARN',
     '{"threshold":5,"observed":9,"merchant_id":"merchant-globex"}'::jsonb),
  ('tenant-default','error_burst','break','reconciliation.break_opened',
     date_trunc('hour', now() - interval '3 hours'), date_trunc('hour', now() - interval '2 hours'),
     6, ARRAY['break-3001','break-3002'], 'INFO',
     '{"threshold":5,"observed":6}'::jsonb),
  ('tenant-default','latency_spike','route','route.selected',
     date_trunc('hour', now() - interval '2 hours'), date_trunc('hour', now() - interval '1 hour'),
     25, ARRAY['pay-1001','pay-1004'], 'ALERT',
     '{"threshold":5,"observed":25,"p95_ms":412}'::jsonb)
ON CONFLICT (signal_kind, entity_type, event_type, bucket_start) DO NOTHING;

-- ----------------------------------------------------------------------------
-- dr_drills (page /admin/hardening) — 5 rows. No natural unique key; guard on
-- (kind, started_at-ish) via a deterministic notes marker. kind:
-- backup_restore|failover|chaos|queue_recovery ; status: PLANNED|RUNNING|PASSED|FAILED.
-- ----------------------------------------------------------------------------
INSERT INTO dr_drills (kind, status, rto_target_minutes, rpo_target_seconds, rto_observed_minutes, rpo_observed_seconds, runbook_url, evidence, notes, ran_by, started_at, completed_at)
SELECT v.kind, v.status, v.rto_t, v.rpo_t, v.rto_o, v.rpo_o, v.runbook_url, v.evidence::jsonb, v.notes, v.ran_by,
       now() - v.start_age::interval,
       CASE WHEN v.done_age IS NULL THEN NULL ELSE now() - v.done_age::interval END
FROM (VALUES
  ('backup_restore','PASSED',60,60,42,18,'https://runbooks.katana.io/dr/backup-restore',
     '{"restored_db":"isolated","rows_verified":1250000}','Monthly backup restore drill within RTO/RPO','reviewer@katana.io', '1 day', '23 hours'),
  ('failover','PASSED',60,60,55,40,'https://runbooks.katana.io/dr/failover',
     '{"region_from":"ap-south-1","region_to":"ap-southeast-1"}','Quarterly DB failover drill','reviewer@katana.io', '3 days', '3 days'),
  ('chaos','FAILED',60,60,78,90,'https://runbooks.katana.io/dr/chaos',
     '{"injected":"provider_outage","gap":"alerting_delayed"}','Provider outage chaos drill exceeded RTO; follow-ups filed','reviewer@katana.io', '8 days', '8 days'),
  ('queue_recovery','PASSED',30,30,12,5,'https://runbooks.katana.io/dr/queue-recovery',
     '{"queue":"webhook_outbox","replayed":340}','Kafka/outbox replay drill','ops@katana.io', '15 days', '15 days'),
  ('backup_restore','RUNNING',60,60,NULL,NULL,'https://runbooks.katana.io/dr/backup-restore',
     '{}','In-progress scheduled restore drill','ops@katana.io', '20 minutes', NULL)
) AS v(kind, status, rto_t, rpo_t, rto_o, rpo_o, runbook_url, evidence, notes, ran_by, start_age, done_age)
WHERE NOT EXISTS (SELECT 1 FROM dr_drills d WHERE d.notes = v.notes);

-- ----------------------------------------------------------------------------
-- hardening_checks (page /admin/hardening): rows already seeded by migration 0005
-- with status='UNKNOWN'. To make the scorecard show a mix of states, set
-- current_value/status/last_checked_at where they are still UNKNOWN (idempotent:
-- the WHERE clause makes a re-run a no-op once values are set).
-- status enum: READY | WARN | NOT_READY | UNKNOWN.
-- ----------------------------------------------------------------------------
UPDATE hardening_checks SET status='READY',     current_value='52m',            last_checked_at = now() - interval '1 hour' WHERE code='rto_target'          AND status='UNKNOWN';
UPDATE hardening_checks SET status='READY',     current_value='30s',            last_checked_at = now() - interval '1 hour' WHERE code='rpo_target'          AND status='UNKNOWN';
UPDATE hardening_checks SET status='READY',     current_value='ran 1d ago',     last_checked_at = now() - interval '1 hour' WHERE code='backup_drill'        AND status='UNKNOWN';
UPDATE hardening_checks SET status='NOT_READY', current_value='last drill failed', last_checked_at = now() - interval '1 hour' WHERE code='chaos_drill'      AND status='UNKNOWN';
UPDATE hardening_checks SET status='READY',     current_value='integrity_ok',   last_checked_at = now() - interval '1 hour' WHERE code='worm_audit'          AND status='UNKNOWN';
UPDATE hardening_checks SET status='READY',     current_value='enforced',       last_checked_at = now() - interval '1 hour' WHERE code='maker_checker'       AND status='UNKNOWN';
UPDATE hardening_checks SET status='READY',     current_value='hashed_only',    last_checked_at = now() - interval '1 hour' WHERE code='token_vault'         AND status='UNKNOWN';
UPDATE hardening_checks SET status='READY',     current_value='sealed',         last_checked_at = now() - interval '1 hour' WHERE code='credential_vault'    AND status='UNKNOWN';
UPDATE hardening_checks SET status='READY',     current_value='enforced',       last_checked_at = now() - interval '1 hour' WHERE code='rbac_isolation'      AND status='UNKNOWN';
UPDATE hardening_checks SET status='READY',     current_value='enabled',        last_checked_at = now() - interval '1 hour' WHERE code='idempotency'         AND status='UNKNOWN';
UPDATE hardening_checks SET status='WARN',      current_value='3 in DLQ',       last_checked_at = now() - interval '1 hour' WHERE code='outbox'              AND status='UNKNOWN';
UPDATE hardening_checks SET status='READY',     current_value='enabled',        last_checked_at = now() - interval '1 hour' WHERE code='circuit_breaker'     AND status='UNKNOWN';
UPDATE hardening_checks SET status='READY',     current_value='enabled',        last_checked_at = now() - interval '1 hour' WHERE code='replay_protection'   AND status='UNKNOWN';
UPDATE hardening_checks SET status='READY',     current_value='100% balanced',  last_checked_at = now() - interval '1 hour' WHERE code='double_entry'        AND status='UNKNOWN';
UPDATE hardening_checks SET status='READY',     current_value='used_on_new',    last_checked_at = now() - interval '1 hour' WHERE code='minor_unit_amounts'  AND status='UNKNOWN';
UPDATE hardening_checks SET status='WARN',      current_value='1 pending review', last_checked_at = now() - interval '1 hour' WHERE code='reserve_release'    AND status='UNKNOWN';
UPDATE hardening_checks SET status='READY',     current_value='5_defined',      last_checked_at = now() - interval '1 hour' WHERE code='slo_targets_present' AND status='UNKNOWN';
UPDATE hardening_checks SET status='READY',     current_value='enabled',        last_checked_at = now() - interval '1 hour' WHERE code='incident_lifecycle'  AND status='UNKNOWN';
UPDATE hardening_checks SET status='READY',     current_value='flowing',        last_checked_at = now() - interval '1 hour' WHERE code='event_stream'        AND status='UNKNOWN';
UPDATE hardening_checks SET status='WARN',      current_value='1 adapter pending', last_checked_at = now() - interval '1 hour' WHERE code='contract_tests'   AND status='UNKNOWN';


-- ============================================================================
-- ==== DB: notificationservice_db ====
-- ============================================================================

-- ----------------------------------------------------------------------------
-- merchant_webhook_configs (page /admin/webhooks) — 2 rows.
-- UNIQUE INDEX on (merchant_id) => ON CONFLICT (merchant_id) DO NOTHING.
-- ----------------------------------------------------------------------------
INSERT INTO merchant_webhook_configs (tenant_id, merchant_id, target_url, secret, enabled)
VALUES
  ('tenant-default','merchant-acme',  'https://hooks.acme.example.com/katana',   'whsec_acme_3f9a1c7b2d', true),
  ('tenant-default','merchant-globex','https://hooks.globex.example.com/katana', 'whsec_globex_8b2e4d1a', true)
ON CONFLICT (merchant_id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- webhook_outbox (page /admin/webhooks) — 8 rows: PENDING (incl. retrying),
-- DEAD_LETTER, DELIVERED. No natural unique key; the table has fixed uuid PK,
-- so guard with WHERE NOT EXISTS keyed on a deterministic payload->>'seed_key'.
-- status enum: PENDING | DELIVERED | DEAD_LETTER.
-- order_id is uuid (nullable) — use literal uuids so [id] pages can link.
-- ----------------------------------------------------------------------------
INSERT INTO webhook_outbox (tenant_id, merchant_id, order_id, event_type, payload, target_url, status, attempts, next_attempt_at, last_error, delivered_at, dead_lettered_at, created_at)
SELECT v.tenant_id, v.merchant_id, v.order_id::uuid, v.event_type, v.payload::jsonb, v.target_url, v.status, v.attempts,
       now() - v.next_age::interval,
       v.last_error,
       CASE WHEN v.delivered_age IS NULL THEN NULL ELSE now() - v.delivered_age::interval END,
       CASE WHEN v.dl_age IS NULL THEN NULL ELSE now() - v.dl_age::interval END,
       now() - v.created_age::interval
FROM (VALUES
  -- PENDING (fresh, never attempted)
  ('tenant-default','merchant-acme',  '11111111-1111-1111-1111-111111110001','payment.success',
     '{"seed_key":"wo-acme-pending-1","order_id":"ord-1001","amount_minor":250000,"currency":"INR","payment_id":"pay-1001"}',
     'https://hooks.acme.example.com/katana','PENDING',0, text '-1 minutes', NULL::text, NULL::text, NULL::text, '2 minutes'),
  -- PENDING (retrying, backing off)
  ('tenant-default','merchant-acme',  '11111111-1111-1111-1111-111111110002','refund.updated',
     '{"seed_key":"wo-acme-pending-2","order_id":"ord-1002","amount_minor":50000,"currency":"INR","refund_id":"rfnd-2001"}',
     'https://hooks.acme.example.com/katana','PENDING',2, text '-3 minutes', text 'HTTP 503 from merchant endpoint', NULL::text, NULL::text, '25 minutes'),
  ('tenant-default','merchant-globex','11111111-1111-1111-1111-111111110003','payment.failed',
     '{"seed_key":"wo-globex-pending-1","order_id":"ord-3001","amount_minor":99900,"currency":"INR","payment_id":"pay-3001"}',
     'https://hooks.globex.example.com/katana','PENDING',3, text '-5 minutes', text 'connection timeout after 10s', NULL::text, NULL::text, '55 minutes'),
  -- DEAD_LETTER (exhausted retries)
  ('tenant-default','merchant-globex','11111111-1111-1111-1111-111111110004','payment.success',
     '{"seed_key":"wo-globex-dlq-1","order_id":"ord-3002","amount_minor":120000,"currency":"INR","payment_id":"pay-3002"}',
     'https://hooks.globex.example.com/katana','DEAD_LETTER',5, text '0 minutes', text 'HTTP 410 Gone (endpoint removed)', NULL::text, text '40 minutes', '3 hours'),
  ('tenant-default','merchant-globex','11111111-1111-1111-1111-111111110005','settlement.updated',
     '{"seed_key":"wo-globex-dlq-2","order_id":"ord-3003","amount_minor":985000,"currency":"INR","settlement_id":"setl-3003"}',
     'https://hooks.globex.example.com/katana','DEAD_LETTER',5, text '0 minutes', text 'TLS handshake failed', NULL::text, text '70 minutes', '5 hours'),
  -- DELIVERED
  ('tenant-default','merchant-acme',  '11111111-1111-1111-1111-111111110006','payment.success',
     '{"seed_key":"wo-acme-delivered-1","order_id":"ord-1000","amount_minor":175000,"currency":"INR","payment_id":"pay-1000"}',
     'https://hooks.acme.example.com/katana','DELIVERED',1, text '0 minutes', NULL::text, text '170 minutes', NULL::text, '175 minutes'),
  ('tenant-default','merchant-acme',  '11111111-1111-1111-1111-111111110007','refund.updated',
     '{"seed_key":"wo-acme-delivered-2","order_id":"ord-0999","amount_minor":25000,"currency":"INR","refund_id":"rfnd-1999"}',
     'https://hooks.acme.example.com/katana','DELIVERED',2, text '0 minutes', NULL::text, text '4 hours', NULL::text, '5 hours'),
  ('tenant-default','merchant-globex','11111111-1111-1111-1111-111111110008','settlement.updated',
     '{"seed_key":"wo-globex-delivered-1","order_id":"ord-2998","amount_minor":640000,"currency":"INR","settlement_id":"setl-2998"}',
     'https://hooks.globex.example.com/katana','DELIVERED',1, text '0 minutes', NULL::text, text '20 hours', NULL::text, '21 hours')
) AS v(tenant_id, merchant_id, order_id, event_type, payload, target_url, status, attempts, next_age, last_error, delivered_age, dl_age, created_age)
WHERE NOT EXISTS (
  SELECT 1 FROM webhook_outbox w WHERE w.payload->>'seed_key' = (v.payload::jsonb->>'seed_key')
);

-- ----------------------------------------------------------------------------
-- webhook_dispatch_attempts (page /admin/webhooks detail) — one+ row per
-- non-fresh outbox row, resolved by payload seed_key. FK -> webhook_outbox.
-- UNIQUE guard on (outbox_id, attempt_no).
-- ----------------------------------------------------------------------------
INSERT INTO webhook_dispatch_attempts (outbox_id, attempt_no, target_url, request_body, signature, timestamp_sent, response_status, response_body, duration_ms, error, attempted_at)
SELECT o.outbox_id, v.attempt_no, o.target_url, o.payload, v.signature,
       extract(epoch FROM (now() - v.age::interval))::bigint,
       v.response_status,
       v.response_body, v.duration_ms, v.error, now() - v.age::interval
FROM (VALUES
  ('wo-acme-pending-2',  1, 'sha256=ab12cd', 503, '{"error":"service unavailable"}', 1205, text 'HTTP 503 from merchant endpoint', '20 minutes'),
  ('wo-acme-pending-2',  2, 'sha256=ab12ce', 503, '{"error":"service unavailable"}', 1180, text 'HTTP 503 from merchant endpoint', '8 minutes'),
  ('wo-globex-pending-1',1, 'sha256=ef34gh', NULL::integer, '', 10000, text 'connection timeout after 10s', '50 minutes'),
  ('wo-globex-pending-1',2, 'sha256=ef34gi', NULL::integer, '', 10000, text 'connection timeout after 10s', '30 minutes'),
  ('wo-globex-pending-1',3, 'sha256=ef34gj', NULL::integer, '', 10000, text 'connection timeout after 10s', '12 minutes'),
  ('wo-globex-dlq-1',    5, 'sha256=ij56kl', 410, '{"error":"gone"}', 95, text 'HTTP 410 Gone (endpoint removed)', '40 minutes'),
  ('wo-globex-dlq-2',    5, 'sha256=mn78op', NULL::integer, '', 4200, text 'TLS handshake failed', '70 minutes'),
  ('wo-acme-delivered-1',1, 'sha256=qr90st', 200, '{"ok":true}', 142, NULL::text, '170 minutes'),
  ('wo-acme-delivered-2',2, 'sha256=uv12wx', 200, '{"ok":true}', 168, NULL::text, '4 hours'),
  ('wo-globex-delivered-1',1,'sha256=yz34ab',200, '{"ok":true}', 210, NULL::text, '20 hours')
) AS v(seed_key, attempt_no, signature, response_status, response_body, duration_ms, error, age)
JOIN webhook_outbox o ON o.payload->>'seed_key' = v.seed_key
WHERE NOT EXISTS (
  SELECT 1 FROM webhook_dispatch_attempts a
  WHERE a.outbox_id = o.outbox_id AND a.attempt_no = v.attempt_no
);
