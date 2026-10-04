-- vendorgatewayservice_db: THE MID SWITCH — a banker's pay-in traffic moved between its own MIDs.
--
-- A MID is one way a banker takes pay-ins:
--   GATEWAY  a payment processor account (its credentials sealed in the credential vault under
--            `vault_label`: 'gateway_mid' is the account every banker had before, further
--            accounts are 'gateway_mid:<id>'); Intent orders.
--   UPI      one of the banker's own UPI IDs (one already set up on its payment config); P2P orders.
--
-- The switch only ever moves traffic between ONE banker's MIDs: the money always lands with the
-- banker the order belongs to, so settlement, reconciliation and chargebacks stay with it.
--
--   payin_mids           each MID: priority, weight, limits (per order, per day, per month),
--                        hours and days it takes traffic, paused / disabled, health rule
--   payin_mid_settings   per banker and kind: on / off, PRIORITY or WEIGHTED, and a manual
--                        switch ("send everything to this MID", optionally until a time)
--   payin_mid_events     every change and every automatic switch, APPEND-ONLY
--   vendor_payin_orders.payin_mid_id   the MID that took the order; usage is counted from it
--
-- A banker with no MIDs of a kind is routed as before (its one gateway account, its primary UPI ID).

CREATE TABLE IF NOT EXISTS payin_mids (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  banker_code     text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('GATEWAY','UPI')),
  name            text NOT NULL,
  vault_label     text,                    -- GATEWAY: the credential_vault label of its account
  upi_id          text,                    -- UPI: the UPI ID paid
  payee_name      text,                    -- UPI: the name registered on that UPI ID, when known
  priority        int  NOT NULL DEFAULT 1 CHECK (priority BETWEEN 1 AND 99),   -- 1 is tried first
  weight          int  NOT NULL DEFAULT 1 CHECK (weight BETWEEN 0 AND 100),    -- share in WEIGHTED mode
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED','DISABLED')),
  status_reason   text,
  -- Limits, rupees. NULL = no limit. "Day" and "month" are India time. Failed and expired orders
  -- give their amount back, as in the banker's own daily limit.
  min_amount      numeric CHECK (min_amount IS NULL OR min_amount > 0),
  max_amount      numeric CHECK (max_amount IS NULL OR max_amount > 0),
  daily_amount    numeric CHECK (daily_amount IS NULL OR daily_amount > 0),
  daily_count     int     CHECK (daily_count IS NULL OR daily_count > 0),
  monthly_amount  numeric CHECK (monthly_amount IS NULL OR monthly_amount > 0),
  -- When it takes traffic, India time. NULL hours = all day; a window may cross midnight
  -- (22:00 → 06:00). days: 1 = Monday … 7 = Sunday; NULL = every day.
  active_from     time,
  active_to       time,
  active_days     int[],
  -- Health: skip the MID while its recent paid share is under this (percent of ended orders,
  -- with at least health_min_orders of them), or after repeated failures to create an order.
  skip_unhealthy     boolean NOT NULL DEFAULT true,
  health_min_success int CHECK (health_min_success IS NULL OR health_min_success BETWEEN 1 AND 100),
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'GATEWAY' AND vault_label IS NOT NULL) OR (kind = 'UPI' AND upi_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS payin_mids_gateway_uk ON payin_mids (banker_code, vault_label) WHERE kind = 'GATEWAY';
CREATE UNIQUE INDEX IF NOT EXISTS payin_mids_upi_uk     ON payin_mids (banker_code, lower(upi_id)) WHERE kind = 'UPI';
CREATE INDEX IF NOT EXISTS payin_mids_banker_idx ON payin_mids (banker_code, kind, priority);

CREATE TABLE IF NOT EXISTS payin_mid_settings (
  banker_code   text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('GATEWAY','UPI')),
  enabled       boolean NOT NULL DEFAULT true,
  mode          text NOT NULL DEFAULT 'PRIORITY' CHECK (mode IN ('PRIORITY','WEIGHTED')),
  pinned_mid_id uuid REFERENCES payin_mids(id) ON DELETE SET NULL,
  pinned_until  timestamptz,
  pinned_by     text,
  pin_reason    text,
  last_mid_id   uuid,                      -- the MID that took the last order (to notice a switch)
  updated_by    text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (banker_code, kind)
);

CREATE TABLE IF NOT EXISTS payin_mid_events (
  id           bigserial PRIMARY KEY,
  banker_code  text NOT NULL,
  kind         text,
  mid_id       uuid,
  action       text NOT NULL,   -- ADDED, UPDATED, PAUSED, RESUMED, DISABLED, PINNED, UNPINNED, SETTINGS,
                                -- AUTO_SWITCH, CREATE_FAILED, NONE_AVAILABLE
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor        text NOT NULL,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payin_mid_events_banker_idx ON payin_mid_events (banker_code, at DESC);
CREATE INDEX IF NOT EXISTS payin_mid_events_mid_idx    ON payin_mid_events (mid_id, action, at DESC);

CREATE OR REPLACE FUNCTION payin_mid_events_locked() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'payin_mid_events is append-only' USING ERRCODE = 'insufficient_privilege';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS payin_mid_events_locked_trg ON payin_mid_events;
CREATE TRIGGER payin_mid_events_locked_trg BEFORE UPDATE OR DELETE ON payin_mid_events
  FOR EACH ROW EXECUTE FUNCTION payin_mid_events_locked();

ALTER TABLE vendor_payin_orders ADD COLUMN IF NOT EXISTS payin_mid_id uuid;
CREATE INDEX IF NOT EXISTS vendor_payin_orders_mid_idx ON vendor_payin_orders (payin_mid_id, created_at DESC) WHERE payin_mid_id IS NOT NULL;
