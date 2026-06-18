-- routingengineservice_db: routing_decisions was reconstructed without the
-- columns lib/routing.persistDecision() writes (txn_id, candidates, winner,
-- score) and the unique key its ON CONFLICT (txn_id) upsert needs. Without
-- these, every order creation fails at the "persist routing decision" step.

ALTER TABLE routing_decisions ADD COLUMN IF NOT EXISTS txn_id     text;
ALTER TABLE routing_decisions ADD COLUMN IF NOT EXISTS candidates jsonb DEFAULT '[]'::jsonb;
ALTER TABLE routing_decisions ADD COLUMN IF NOT EXISTS winner     text;
ALTER TABLE routing_decisions ADD COLUMN IF NOT EXISTS score      double precision;

-- Required for persistDecision()'s ON CONFLICT (txn_id) upsert. NULL txn_ids
-- from any legacy rows are allowed (Postgres unique indexes permit many NULLs).
CREATE UNIQUE INDEX IF NOT EXISTS routing_decisions_txn_id_uniq ON routing_decisions (txn_id);
