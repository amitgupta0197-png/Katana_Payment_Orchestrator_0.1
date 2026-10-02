-- auditservice_db: JOB HEARTBEATS and OPS ALERTS.
--
-- Scheduled work here is a set of HTTP routes that the server's crontab calls. Nothing recorded
-- that a job had run, so a crontab that stopped (or lost one line) was invisible until its
-- effects were noticed.
--
--   job_heartbeats  one row per job: when it last ran, whether it succeeded, how often it is
--                   expected. /api/health?deep=1 and /api/metrics report the stale ones.
--   ops_alerts      one row per condition that needs a person (a tripped circuit, callbacks in
--                   dead-letter, bank credits waiting for review). The row is what stops the
--                   same condition being sent to Telegram on every check.

CREATE TABLE IF NOT EXISTS job_heartbeats (
  job               text PRIMARY KEY,
  expected_every_s  integer,              -- how often the crontab should call it; NULL = not checked
  last_started_at   timestamptz,
  last_finished_at  timestamptz,
  last_ok           boolean,
  last_error        text,
  last_result       jsonb,
  runs              bigint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ops_alerts (
  alert_key      text PRIMARY KEY,        -- what the alert is about, e.g. 'circuit:PAYU'
  severity       text NOT NULL DEFAULT 'WARN' CHECK (severity IN ('INFO','WARN','CRITICAL')),
  title          text NOT NULL,
  body           text,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_sent_at   timestamptz,             -- when it last went to Telegram
  resolved_at    timestamptz,             -- NULL while the condition holds
  seen_count     bigint NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ops_alerts_open_idx ON ops_alerts (last_seen_at DESC) WHERE resolved_at IS NULL;
