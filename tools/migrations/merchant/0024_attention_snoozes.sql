-- merchantservice_db: "Needs attention" (/attention, lib/attention). A row hidden by staff for a
-- while: "Resolved / snooze 24h". The rows themselves are worked out from live data on request;
-- only the snoozes are stored. Keyed on the condition's stable key (e.g. PAID_NOT_TOLD:<banker>:<order>).
--
-- Re-runnable. Additive only.

CREATE TABLE IF NOT EXISTS attention_snoozes (
  key           text PRIMARY KEY,
  snoozed_until timestamptz NOT NULL,
  snoozed_by    text NOT NULL,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attention_snoozes_until_idx ON attention_snoozes (snoozed_until);
