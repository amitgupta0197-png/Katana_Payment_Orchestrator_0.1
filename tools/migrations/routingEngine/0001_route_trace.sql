-- routingengineservice_db: extend routing_decisions with cascade + factor
-- breakdown (BRD §6 P2 acceptance: "routing decision is logged with score
-- factors; route can be replayed for audit").

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

ALTER TABLE routing_decisions ADD COLUMN IF NOT EXISTS order_id        uuid;
ALTER TABLE routing_decisions ADD COLUMN IF NOT EXISTS merchant_id     text;
ALTER TABLE routing_decisions ADD COLUMN IF NOT EXISTS method          text;
ALTER TABLE routing_decisions ADD COLUMN IF NOT EXISTS amount_minor    bigint;
ALTER TABLE routing_decisions ADD COLUMN IF NOT EXISTS currency        text;
ALTER TABLE routing_decisions ADD COLUMN IF NOT EXISTS cascade_ranks   jsonb DEFAULT '[]'::jsonb;
  -- e.g. [{"rank":1,"provider":"poolpay","score":0.87},{"rank":2,"provider":"quickpay","score":0.81}]
ALTER TABLE routing_decisions ADD COLUMN IF NOT EXISTS factors         jsonb DEFAULT '{}'::jsonb;
  -- per-candidate factor breakdown for replay/audit
ALTER TABLE routing_decisions ADD COLUMN IF NOT EXISTS selected_rank   integer DEFAULT 1;
ALTER TABLE routing_decisions ADD COLUMN IF NOT EXISTS weights_applied jsonb DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS routing_decisions_order_idx ON routing_decisions (order_id);
CREATE INDEX IF NOT EXISTS routing_decisions_merchant_idx ON routing_decisions (merchant_id, decided_at DESC);

-- Provider health snapshot used for routing (BRD §6). Older rail_health
-- table keeps short-window rolling counters; this table is the score-ready
-- view that the orchestrator reads.
CREATE TABLE IF NOT EXISTS provider_health_snapshot (
  provider_code   text PRIMARY KEY,
  success_rate    numeric(5,4) NOT NULL DEFAULT 1.0,    -- 0.0000–1.0000
  p95_latency_ms  integer NOT NULL DEFAULT 0,
  failure_rate    numeric(5,4) NOT NULL DEFAULT 0.0,
  utilization     numeric(5,4) NOT NULL DEFAULT 0.0,
  last_outage_at  timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
