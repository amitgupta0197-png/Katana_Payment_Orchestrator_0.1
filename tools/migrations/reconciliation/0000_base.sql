-- reconciliationservice_db: base tables that the additive migration (0001)
-- extends. These were lost in the 2026-06-15 wipe and are reconstructed here
-- from the BFF queries (lib/reconciliation.ts, lib/slo.ts,
-- api/recon/breaks/*, api/recon/run). Columns added later
-- (recon_breaks: ageing_bucket, expected_action, sla_breached_at, evidence,
-- resolved_by; recon_matches: match_level) live in 0001 via
-- ADD COLUMN IF NOT EXISTS, so this file holds only the originals.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Reconciliation run summary. Inserted/updated by lib/reconciliation.ts
-- (tenant_id, window_start, window_end, status, started_at, completed_at,
-- items_total, matched_3way, matched_2way, breaks_opened) and read by
-- lib/slo.ts measureAutoMatch (matched_3way, matched_2way, breaks_opened,
-- started_at).
CREATE TABLE IF NOT EXISTS recon_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL DEFAULT 'tenant-default',
  window_start  timestamptz,
  window_end    timestamptz,
  status        text NOT NULL DEFAULT 'RUNNING',   -- RUNNING | COMPLETED
  started_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  items_total   integer NOT NULL DEFAULT 0,
  matched_3way  integer NOT NULL DEFAULT 0,
  matched_2way  integer NOT NULL DEFAULT 0,
  breaks_opened integer NOT NULL DEFAULT 0
);

-- Reconciliation breaks (unmatched / partially matched items). 0001 adds
-- ageing_bucket, expected_action, sla_breached_at, evidence, resolved_by.
-- Columns/types derived from:
--   lib/reconciliation.ts INSERT (run_id, tenant_id, reference, break_type,
--     sources_present, amount, currency, status) + ON CONFLICT target
--     (tenant_id, reference, break_type, currency).
--   api/recon/breaks SELECT (delta, assignee, notes, resolution_kind,
--     opened_at, resolved_at) + WHERE/ORDER BY (status, opened_at).
--   api/recon/breaks/[id] PATCH (status, assignee, notes, resolution_kind,
--     resolution_ref, resolved_at).
-- sources_present is written as a scalar text value by the runner
-- (e.g. 'INTERNAL_ONLY'), so it is text, not text[].
CREATE TABLE IF NOT EXISTS recon_breaks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid,
  tenant_id       text NOT NULL DEFAULT 'tenant-default',
  reference       text NOT NULL,
  break_type      text NOT NULL,
  sources_present text,
  amount          numeric,
  currency        text NOT NULL,
  delta           numeric NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'OPEN',   -- OPEN | INVESTIGATING | RESOLVED | FORCED_CLOSE
  assignee        text,
  notes           text,
  resolution_kind text,
  resolution_ref  text,
  opened_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  UNIQUE (tenant_id, reference, break_type, currency)
);

-- Reconciliation matches (matched items by run). 0001 adds match_level.
-- Columns from lib/reconciliation.ts INSERT:
--   (run_id, tenant_id, reference, amount, currency, kind, internal_id).
CREATE TABLE IF NOT EXISTS recon_matches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      uuid,
  tenant_id   text NOT NULL DEFAULT 'tenant-default',
  reference   text,
  amount      numeric,
  currency    text,
  kind        text,            -- 3WAY | 2WAY
  internal_id text,
  matched_at  timestamptz NOT NULL DEFAULT now()
);
