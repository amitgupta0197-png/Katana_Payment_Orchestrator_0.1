-- checkoutservice_db (Sprint 8): canonical refund table + AI agents catalog.
-- BRD §10 (refund ledger) + §14 P10 (Agentic AI).

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS refunds (
  refund_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL DEFAULT 'tenant-default',
  order_id      uuid REFERENCES checkout_orders(id),
  txn_id        text NOT NULL,
  merchant_id   text NOT NULL,
  amount_minor  bigint NOT NULL,
  currency      text NOT NULL,
  reason        text NOT NULL,
  status        text NOT NULL DEFAULT 'PENDING',
    -- PENDING | POSTED | FAILED
  partial       boolean NOT NULL DEFAULT false,
  journal_id    uuid,
  requested_by  text,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  posted_at     timestamptz,
  failure_reason text
);
CREATE INDEX IF NOT EXISTS refunds_order_idx ON refunds (order_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS refunds_status_idx ON refunds (status, requested_at DESC);

-- AI agents catalog (BRD §14 P10).
CREATE TABLE IF NOT EXISTS ai_agents (
  agent_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE,
  display_name    text NOT NULL,
  purpose         text NOT NULL,
  commands        text[] NOT NULL DEFAULT '{}',
  enabled         boolean NOT NULL DEFAULT true,
  last_signal_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ai_agents (code, display_name, purpose, commands) VALUES
  ('settlement', 'Settlement Agent', 'Watches batches, reserves and partner sync. Suggests holdovers and break ownership.', ARRAY['/settlement','/reserve','/exceptions']),
  ('risk',       'Risk Agent',       'Velocity, sanctions/PEP anomalies, blocked attempts and fraud cluster grouping.',         ARRAY['/risk','/txn','/merchant']),
  ('treasury',   'Treasury Agent',   'FX exposure, vendor float, payout queue.',                                                 ARRAY['/treasury','/retry_payout']),
  ('provider',   'Provider Agent',   'Provider health, kill-switch suggestions, capacity warnings.',                             ARRAY['/provider','/submid']),
  ('merchant',   'Merchant Agent',   'Onboarding stage progress, doc expiry, escalations.',                                      ARRAY['/merchant']),
  ('compliance', 'Compliance Agent', 'AML cases queue, WORM integrity, audit readiness.',                                        ARRAY['/risk','/exceptions']),
  ('support',    'Support Agent',    'Merchant tickets, dispute representment due dates.',                                       ARRAY['/merchant','/exceptions']),
  ('rca',        'RCA Agent',        'Auto-links recent failures to incidents; surfaces root cause.',                            ARRAY['/exceptions']),
  ('growth',     'Growth Agent',     'Conversion funnel, method ordering, pricing experiments.',                                 ARRAY['/merchant','/provider'])
ON CONFLICT (code) DO UPDATE SET display_name=EXCLUDED.display_name, purpose=EXCLUDED.purpose, commands=EXCLUDED.commands;
