-- routingengineservice_db: advanced routing — circuit breaker, kill switch,
-- A/B experiments (BRD §6 P2 acceptance: "Provider outage triggers failover
-- within 5 seconds; routing decision is logged with score factors").

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Operator emergency lever per rail (provider + method).
ALTER TABLE rails ADD COLUMN IF NOT EXISTS kill_switch boolean NOT NULL DEFAULT false;
ALTER TABLE rails ADD COLUMN IF NOT EXISTS kill_switch_reason text;
ALTER TABLE rails ADD COLUMN IF NOT EXISTS kill_switch_at timestamptz;
ALTER TABLE rails ADD COLUMN IF NOT EXISTS kill_switch_by text;

-- Circuit-breaker state machine per provider (CLOSED → OPEN → HALF_OPEN → CLOSED).
ALTER TABLE provider_health_snapshot ADD COLUMN IF NOT EXISTS circuit_state text NOT NULL DEFAULT 'CLOSED';
  -- CLOSED | OPEN | HALF_OPEN
ALTER TABLE provider_health_snapshot ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0;
ALTER TABLE provider_health_snapshot ADD COLUMN IF NOT EXISTS circuit_opened_at timestamptz;
ALTER TABLE provider_health_snapshot ADD COLUMN IF NOT EXISTS half_open_at timestamptz;
ALTER TABLE provider_health_snapshot ADD COLUMN IF NOT EXISTS last_failure_at timestamptz;
ALTER TABLE provider_health_snapshot ADD COLUMN IF NOT EXISTS last_success_at timestamptz;

-- Routing experiments (A/B). control_weights and variant_weights are full
-- RoutingWeights JSON blobs from lib/routing.ts.
CREATE TABLE IF NOT EXISTS routing_experiments (
  experiment_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL UNIQUE,
  description      text,
  control_weights  jsonb NOT NULL,
  variant_weights  jsonb NOT NULL,
  traffic_split    numeric(3,2) NOT NULL DEFAULT 0.50,   -- 0..1, fraction in variant
  method_scope     text,                                  -- NULL = all methods
  enabled          boolean NOT NULL DEFAULT false,
  started_at       timestamptz,
  ended_at         timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text
);

-- Tag routing_decisions with experiment bucket (BRD acceptance: replayable).
ALTER TABLE routing_decisions ADD COLUMN IF NOT EXISTS experiment_id uuid;
ALTER TABLE routing_decisions ADD COLUMN IF NOT EXISTS experiment_bucket text;
  -- CONTROL | VARIANT
