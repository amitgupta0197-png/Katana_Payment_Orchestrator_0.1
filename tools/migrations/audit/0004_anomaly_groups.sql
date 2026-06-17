-- auditservice_db (Sprint 8): anomaly grouping (BRD §14 P10
-- "alert grouping, anomaly detection").
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS anomaly_groups (
  group_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL DEFAULT 'tenant-default',
  signal_kind   text NOT NULL,        -- event_burst | error_burst | latency_spike
  entity_type   text NOT NULL,
  event_type    text NOT NULL,
  bucket_start  timestamptz NOT NULL,
  bucket_end    timestamptz NOT NULL,
  signal_count  integer NOT NULL DEFAULT 0,
  sample_ids    text[] NOT NULL DEFAULT '{}',
  severity      text NOT NULL DEFAULT 'INFO',  -- INFO | WARN | ALERT
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS anomaly_groups_bucket_idx
  ON anomaly_groups (entity_type, event_type, bucket_start DESC);
CREATE UNIQUE INDEX IF NOT EXISTS anomaly_groups_key
  ON anomaly_groups (signal_kind, entity_type, event_type, bucket_start);
