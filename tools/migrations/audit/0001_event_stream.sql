-- auditservice_db: cross-module event stream (BRD §16 — Event Bus Contracts).
-- Every state-changing operation publishes one row here so dashboard,
-- reconciliation, AI monitoring and audit can consume independently.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS event_stream (
  event_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    text NOT NULL DEFAULT 'tenant-default',
  event_type   text NOT NULL,
    -- merchant.created | submid.status_changed | payment.created
    -- route.selected | callback.received | payment.succeeded
    -- settlement.calculated | reconciliation.break_opened | risk.alert
    -- provider.kyc_decided | maker_checker.requested | maker_checker.decided
  producer     text NOT NULL,
    -- merchant_onboarding | sub_mid_engine | payment_core | routing_engine
    -- callback_engine | settlement_engine | reconciliation | risk_engine | provider_mgmt | auth
  entity_type  text NOT NULL,
    -- merchant | sub_mid | payment | route | callback | settlement | break | risk | provider | session | maker_checker
  entity_id    text NOT NULL,
  actor_id     text,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS event_stream_type_idx     ON event_stream (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS event_stream_entity_idx   ON event_stream (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS event_stream_tenant_idx   ON event_stream (tenant_id, created_at DESC);
