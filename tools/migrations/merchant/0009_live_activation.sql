-- merchantservice_db: TEST / LIVE MODE, PHASE 2 — "Activate live mode".
--
-- A banker integrates with its TEST keys from day one. Taking REAL payments needs live mode
-- ACTIVATED: an automatic checklist goes green, the banker requests activation, a Super Admin
-- approves. Until then the dashboard refuses to issue a live Checkout Key / TSP secret or create
-- a live order for that banker (lib/live-activation.ts).
--
-- Keyed by merchant_code — what keys, orders and credits are stamped with — and deliberately not
-- a foreign key: seed and demo merchants hold keys without a merchants row.
--
-- NO BACKFILL HERE. Bankers already taking live payments are grandfathered, but the evidence
-- (live keys, live TSP secrets, live orders) lives in checkoutservice_db and
-- vendorgatewayservice_db, which a merchantservice_db migration cannot read. The code records
-- them as ACTIVATED (grandfathered = true) the first time they are checked, which is before
-- their next live order or key rotation can be refused.
--
-- SAFE TO APPLY BEFORE THE CODE THAT USES IT: nothing reads the table yet. The code in turn treats
-- a missing table as "not deployed" and lets live traffic through, so the two can ship in either
-- order — apply this first anyway.

CREATE TABLE IF NOT EXISTS merchant_live_activation (
  merchant_code  text PRIMARY KEY,
  status         text NOT NULL DEFAULT 'NOT_REQUESTED'
                 CHECK (status IN ('NOT_REQUESTED', 'REQUESTED', 'ACTIVATED', 'REJECTED')),
  grandfathered  boolean NOT NULL DEFAULT false,   -- activated because it was already live
  requested_at   timestamptz,
  requested_by   text,
  decided_at     timestamptz,
  decided_by     text,
  reason         text,                              -- rejection reason, or the grandfathering note
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- The admin queue lists pending requests newest first.
CREATE INDEX IF NOT EXISTS merchant_live_activation_status_idx
  ON merchant_live_activation (status, requested_at DESC);
