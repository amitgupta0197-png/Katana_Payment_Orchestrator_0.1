-- fifoservice_db: SLA sweep support (PayTech BRD §15 steps 9-11, §29).
-- The sweep finds ASSIGNED items past their accept-by SLA and auto-returns them
-- to the queue (or escalates to HOLD after repeated breaches). sla_due_at and
-- reassign_count already exist from 0001_init.sql; this just adds a partial
-- index so the sweep stays cheap as the queue grows.

CREATE INDEX IF NOT EXISTS fifo_queue_sla_idx
  ON fifo_queue (sla_due_at)
  WHERE status = 'ASSIGNED';
