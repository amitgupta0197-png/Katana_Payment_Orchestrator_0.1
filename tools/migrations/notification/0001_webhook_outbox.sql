-- notificationservice_db: merchant webhook outbox + DLQ (BRD §8 P4).
-- BRD acceptance: "failed merchant webhook enters retry/DLQ with full payload and reason."

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Per-merchant webhook configuration (URL + signing secret).
CREATE TABLE IF NOT EXISTS merchant_webhook_configs (
  config_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    text NOT NULL DEFAULT 'tenant-default',
  merchant_id  text NOT NULL,
  target_url   text NOT NULL,
  secret       text NOT NULL,
  enabled      boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS merchant_webhook_configs_uniq
  ON merchant_webhook_configs (merchant_id);

-- Outbox: every webhook the platform owes a merchant.
CREATE TABLE IF NOT EXISTS webhook_outbox (
  outbox_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        text NOT NULL DEFAULT 'tenant-default',
  merchant_id      text NOT NULL,
  order_id         uuid,
  event_type       text NOT NULL,
    -- payment.success | payment.failed | refund.updated | settlement.updated
  payload          jsonb NOT NULL,
  target_url       text NOT NULL,
  status           text NOT NULL DEFAULT 'PENDING',
    -- PENDING | DELIVERED | DEAD_LETTER
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  delivered_at     timestamptz,
  dead_lettered_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_outbox_status_idx
  ON webhook_outbox (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS webhook_outbox_merchant_idx
  ON webhook_outbox (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS webhook_outbox_order_idx
  ON webhook_outbox (order_id);

-- One row per dispatch attempt — request/response audit trail.
CREATE TABLE IF NOT EXISTS webhook_dispatch_attempts (
  attempt_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id        uuid NOT NULL REFERENCES webhook_outbox(outbox_id) ON DELETE CASCADE,
  attempt_no       integer NOT NULL,
  target_url       text NOT NULL,
  request_body     jsonb NOT NULL,
  signature        text,
  timestamp_sent   bigint,
  response_status  integer,
  response_body    text,
  duration_ms      integer,
  error            text,
  attempted_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_dispatch_attempts_outbox_idx
  ON webhook_dispatch_attempts (outbox_id, attempt_no);
