-- merchantservice_db: the health engine's cache and its accomplishment log (lib/health.ts rules,
-- lib/health-store.ts reads and writes).
--
-- actor_health is a CACHE: one row per actor (TSP, BANKER, MERCHANT = providers row,
-- INTEGRATION = one banker on one flow, id "<banker code>:<FLOW>"), rewritten by every
-- recomputation (cron /api/v1/cron/actor-health, every 5 minutes, and a single actor's detail).
-- Deleting it loses nothing; the next run rebuilds it.
--
-- health_checklist_completions is the record of what was accomplished: a row whenever a
-- recomputation sees a checklist item go MISSING → DONE (method SYSTEM_AUTO, evidence = what
-- proved it). Append-only, locked by a trigger like merchant 0018's history tables.
--
-- Staff only. Items may name a TSP or gateway; none of this reaches a merchant.

CREATE TABLE IF NOT EXISTS actor_health (
  actor_type   text NOT NULL CHECK (actor_type IN ('TSP','BANKER','MERCHANT','INTEGRATION')),
  actor_id     text NOT NULL,
  label        text,                       -- code / name, for lists and alerts
  live         boolean NOT NULL DEFAULT false,
  score        integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  raw_score    integer NOT NULL DEFAULT 0, -- done / required before a BLOCKED item zeroes it
  band         text NOT NULL CHECK (band IN ('GREEN','AMBER','RED','BLOCKED')),
  items        jsonb NOT NULL DEFAULT '[]'::jsonb,
  computed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_type, actor_id)
);
CREATE INDEX IF NOT EXISTS actor_health_band_idx ON actor_health (band) WHERE band IN ('RED','BLOCKED');

CREATE TABLE IF NOT EXISTS health_checklist_completions (
  id            bigserial PRIMARY KEY,
  actor_type    text NOT NULL,
  actor_id      text NOT NULL,
  item_key      text NOT NULL,
  completed_at  timestamptz NOT NULL DEFAULT now(),
  completed_by  text NOT NULL DEFAULT 'SYSTEM',
  method        text NOT NULL CHECK (method IN ('MANUAL','SYSTEM_AUTO','MAKER_CHECKER')),
  evidence_ref  text
);
CREATE INDEX IF NOT EXISTS health_checklist_completions_actor_idx
  ON health_checklist_completions (actor_type, actor_id, completed_at DESC);

CREATE OR REPLACE FUNCTION health_completions_locked() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'health_checklist_completions is append-only';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS health_checklist_completions_locked_trg ON health_checklist_completions;
CREATE TRIGGER health_checklist_completions_locked_trg BEFORE UPDATE OR DELETE ON health_checklist_completions
  FOR EACH ROW EXECUTE FUNCTION health_completions_locked();
