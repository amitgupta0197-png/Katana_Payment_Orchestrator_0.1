-- routingengineservice_db: base tables the additive migrations (0001/0002)
-- extend. These were lost in the 2026-06-15 wipe and are reconstructed here
-- from the BFF queries (lib/routing.ts, api/admin/routing/*, api/routing/*).
-- Columns added later (kill_switch*, circuit_state*, cascade_ranks, …) live in
-- 0001/0002 via ADD COLUMN IF NOT EXISTS, so this file holds only the originals.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Bank/provider rails: one row per (provider, method, direction). Read by
-- lib/routing.ts (provider, method, weight, mdr_bps, enabled, kill_switch) and
-- api/admin/routing/health (provider, method, direction, enabled, mdr_bps).
CREATE TABLE IF NOT EXISTS rails (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider   text NOT NULL,
  method     text NOT NULL,
  direction  text NOT NULL DEFAULT 'PAYIN',     -- PAYIN | PAYOUT
  enabled    boolean NOT NULL DEFAULT true,
  weight     integer NOT NULL DEFAULT 100,
  mdr_bps    integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, method, direction)
);

-- Routing decision log (route trace). 0001 adds order/merchant/factor columns.
CREATE TABLE IF NOT EXISTS routing_decisions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  selected_provider text,
  decided_at        timestamptz NOT NULL DEFAULT now()
);
