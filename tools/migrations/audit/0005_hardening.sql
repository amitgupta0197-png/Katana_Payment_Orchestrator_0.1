-- auditservice_db (Sprint 9): DR drills + production-readiness checklist
-- (BRD §20 + §22).

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS dr_drills (
  drill_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL,            -- backup_restore | failover | chaos | queue_recovery
  status        text NOT NULL DEFAULT 'PLANNED',
                                          -- PLANNED | RUNNING | PASSED | FAILED
  rto_target_minutes integer,
  rpo_target_seconds integer,
  rto_observed_minutes integer,
  rpo_observed_seconds integer,
  runbook_url   text,
  evidence      jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes         text,
  ran_by        text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);
CREATE INDEX IF NOT EXISTS dr_drills_kind_idx ON dr_drills (kind, started_at DESC);
CREATE INDEX IF NOT EXISTS dr_drills_status_idx ON dr_drills (status, started_at DESC);

-- Production readiness scorecard (BRD §22 test areas).
CREATE TABLE IF NOT EXISTS hardening_checks (
  check_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  area         text NOT NULL,             -- DR | Security | Reliability | Money | Observability
  code         text NOT NULL UNIQUE,
  name         text NOT NULL,
  description  text NOT NULL,
  evaluator    text NOT NULL,
    -- key used by lib/hardening.ts to compute the current value
  target_value text NOT NULL,
  status       text NOT NULL DEFAULT 'UNKNOWN',
    -- READY | WARN | NOT_READY | UNKNOWN
  current_value text,
  evidence     jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_checked_at timestamptz
);

-- Seed BRD §22 + §20 checklist items.
INSERT INTO hardening_checks (area, code, name, description, evaluator, target_value, status) VALUES
  ('DR',            'rto_target',          'RTO target',                         'Critical payment APIs restored within 60 minutes (BRD §20).',                                     'dr.rto',           '<= 60m', 'UNKNOWN'),
  ('DR',            'rpo_target',          'RPO target',                         'Financial data loss target near zero for committed transactions (BRD §20).',                       'dr.rpo',           '<= 60s', 'UNKNOWN'),
  ('DR',            'backup_drill',        'Backup restore drill',               'Restored DB to isolated environment within last 30 days (BRD §20).',                               'dr.backup',        'monthly', 'UNKNOWN'),
  ('DR',            'chaos_drill',         'Chaos drill',                        'Provider outage + DB failover drilled this quarter (BRD §20).',                                    'dr.chaos',         'quarterly', 'UNKNOWN'),

  ('Security',      'worm_audit',          'WORM audit integrity',               'worm_audit_log hash chain unbroken (BRD §15).',                                                    'security.worm',    'integrity_ok', 'UNKNOWN'),
  ('Security',      'maker_checker',       'Maker-checker on KYC',               'Sensitive provider/merchant changes require second SUPER_ADMIN (BRD §4).',                          'security.maker',   'enforced', 'UNKNOWN'),
  ('Security',      'token_vault',         'Token vault',                        'payment_tokens never store raw provider token (only sha256).',                                     'security.tokens',  'hashed_only', 'UNKNOWN'),
  ('Security',      'credential_vault',    'Credential vault',                   'credential_vault uses AES-256-GCM envelope encryption.',                                           'security.vault',   'sealed', 'UNKNOWN'),
  ('Security',      'rbac_isolation',      'RBAC tenant isolation',              'PROVIDER/MERCHANT personas blocked from cross-tenant data (BRD §3.11).',                            'security.rbac',    'enforced', 'UNKNOWN'),

  ('Reliability',   'idempotency',         'Webhook idempotency',                'callback_dedup blocks duplicate provider callbacks (BRD §8).',                                     'reliability.idem', 'enabled', 'UNKNOWN'),
  ('Reliability',   'outbox',              'Webhook outbox + DLQ',               'webhook_outbox + DLQ retry schedule per BRD §8.',                                                  'reliability.outbox', 'enabled', 'UNKNOWN'),
  ('Reliability',   'circuit_breaker',     'Circuit breaker',                    'provider_health_snapshot circuit_state trips on consecutive failures (BRD §6).',                   'reliability.cb',   'enabled', 'UNKNOWN'),
  ('Reliability',   'replay_protection',   'Callback replay protection',         '±5min timestamp window + HMAC enforced.',                                                          'reliability.replay','enabled', 'UNKNOWN'),

  ('Money',         'double_entry',        'Double-entry ledger',                'Every journal: sum(debit_minor) === sum(credit_minor) (BRD §10).',                                  'money.double_entry','100% balanced', 'UNKNOWN'),
  ('Money',         'minor_unit_amounts',  'Integer minor units',                'New writes populate amount_minor (BRD §10).',                                                      'money.minor',      'used_on_new',  'UNKNOWN'),
  ('Money',         'reserve_release',     'Reserve release calendar',           'Scheduled releases never exceed held amount.',                                                     'money.reserve',    'no_overruns',  'UNKNOWN'),

  ('Observability', 'slo_targets_present', 'SLO targets',                        'All BRD §13 SLO targets defined.',                                                                 'obs.slos',         '5_defined',    'UNKNOWN'),
  ('Observability', 'incident_lifecycle',  'Incident lifecycle',                 'Auto-open on BREACH; transitions WORM-logged (BRD §13).',                                          'obs.incidents',    'enabled',      'UNKNOWN'),
  ('Observability', 'event_stream',        'Event stream',                       'event_stream populated by all producers (BRD §16).',                                               'obs.events',       'flowing',      'UNKNOWN'),
  ('Observability', 'contract_tests',      'Adapter contract tests',             'PG/Bank/VASP adapters pass charge/refund/getStatus shape (BRD §3).',                               'obs.contracts',    'all_pass',     'UNKNOWN')
ON CONFLICT (code) DO NOTHING;
