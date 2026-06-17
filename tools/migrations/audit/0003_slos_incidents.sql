-- auditservice_db (Sprint 7): SLO targets + observations + incidents
-- (BRD §13 P9: "Live transaction stream, funnel analytics, SLO dashboard,
-- incident panel, NOC health grid").

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS slo_targets (
  target_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL UNIQUE,
  description  text,
  metric_kind  text NOT NULL,
    -- availability | latency_p95_ms | webhook_in_sla | partner_sync | auto_match_pct
  target_value numeric(10,4) NOT NULL,
    -- e.g. 0.9995 = 99.95% availability, 300 = 300ms p95
  comparison   text NOT NULL DEFAULT '>=',  -- >= for availability/% , <= for latency
  window_minutes integer NOT NULL DEFAULT 60,
  burn_rate_alert numeric(6,4) NOT NULL DEFAULT 2.0,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS slo_observations (
  obs_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id    uuid NOT NULL REFERENCES slo_targets(target_id) ON DELETE CASCADE,
  measured_value numeric(12,4) NOT NULL,
  status       text NOT NULL,            -- OK | WARN | BREACH
  detail       jsonb,
  observed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS slo_observations_target_idx ON slo_observations (target_id, observed_at DESC);

-- Incidents (BRD §13 + §14 P10).
CREATE TABLE IF NOT EXISTS incidents (
  incident_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL DEFAULT 'tenant-default',
  severity      text NOT NULL,           -- SEV1 | SEV2 | SEV3 | SEV4
  status        text NOT NULL DEFAULT 'OPEN',
    -- OPEN | INVESTIGATING | MITIGATING | RESOLVED | POST_MORTEM
  source        text NOT NULL,           -- slo_breach | manual | risk | webhook_dlq | recon_sla
  title         text NOT NULL,
  summary       text,
  related_target uuid,
  related_entities jsonb NOT NULL DEFAULT '{}'::jsonb,
  opened_at     timestamptz NOT NULL DEFAULT now(),
  opened_by     text,
  acked_at      timestamptz,
  resolved_at   timestamptz,
  resolved_by   text,
  resolution_notes text,
  postmortem_url text
);
CREATE INDEX IF NOT EXISTS incidents_status_idx ON incidents (status, opened_at DESC);
CREATE INDEX IF NOT EXISTS incidents_severity_idx ON incidents (severity, opened_at DESC);

-- Seed: BRD §13 SLO targets.
INSERT INTO slo_targets (name, description, metric_kind, target_value, comparison, window_minutes, burn_rate_alert) VALUES
  ('payment_api_availability', 'POST /api/checkout success rate', 'availability',     0.9995, '>=',   60, 2.0),
  ('payment_routing_latency',  'p95 charge latency over 10m',     'latency_p95_ms',     300,  '<=',   10, 1.5),
  ('webhook_processing_sla',   '% webhooks delivered < 60s',      'webhook_in_sla',    0.99,  '>=',   60, 2.0),
  ('settlement_sync_sla',      '% partner records synced by T+1', 'partner_sync',      0.99,  '>=', 1440, 1.5),
  ('reconciliation_sla',       '% auto-matched within T+1',       'auto_match_pct',    0.95,  '>=', 1440, 1.5)
ON CONFLICT DO NOTHING;
