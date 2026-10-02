-- routingengineservice_db: CIRCUIT BREAKER EVENTS — every change of a provider's circuit.
--
-- provider_health_snapshot holds only the circuit's current state, so a trip that has since
-- recovered left no trace. One row is written here per change (lib/circuit-breaker):
--
--   TRIPPED       CLOSED → OPEN       consecutive failures reached the threshold
--   HALF_OPEN     OPEN → HALF_OPEN    the cool-off ran out; the next request is the probe
--   PROBE_FAILED  HALF_OPEN → OPEN    the probe failed; the cool-off starts again
--   RECOVERED     HALF_OPEN → CLOSED  the probe succeeded
--   RESET         any → CLOSED        an operator reset it

CREATE TABLE IF NOT EXISTS circuit_breaker_events (
  id                    bigserial PRIMARY KEY,
  provider_code         text NOT NULL,
  event                 text NOT NULL CHECK (event IN ('TRIPPED','HALF_OPEN','PROBE_FAILED','RECOVERED','RESET')),
  from_state            text,
  to_state              text NOT NULL,
  consecutive_failures  integer,
  actor                 text NOT NULL DEFAULT 'system',
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS circuit_breaker_events_provider_idx ON circuit_breaker_events (provider_code, created_at DESC);
CREATE INDEX IF NOT EXISTS circuit_breaker_events_time_idx     ON circuit_breaker_events (created_at DESC);
