-- vendorgatewayservice_db: THE BANKER SWITCH — a merchant's pay-in traffic moved between its own bankers.
--
-- A merchant (provider) with several bankers holds a Key + Salt for each. With its banker switch on,
-- an order signed with ANY of those Keys is taken by the banker the switch picks (the manual switch,
-- else PRIORITY or WEIGHTED among the bankers in rotation, passing over a banker that cannot take
-- the order). The order then belongs to that banker: its MIDs, limits, settlement and chargebacks.
-- Its callback is sent and signed as the signing banker's own would be, so the merchant's server
-- verifies it with the Salt it signed the order with.
--
-- Traffic never leaves the merchant: only bankers mapped under the same merchant take part.
--
--   payin_banker_switch           per merchant: on / off, PRIORITY or WEIGHTED, the manual switch
--   payin_banker_switch_members   per banker: in rotation, priority, weight
--   payin_banker_switch_events    every change and every automatic switch, APPEND-ONLY
--   vendor_payin_orders.signed_by the banker whose Key signed an order another banker took
--                                 (NULL when the signer took it itself: every order before this)

CREATE TABLE IF NOT EXISTS payin_banker_switch (
  provider_id    text PRIMARY KEY,
  enabled        boolean NOT NULL DEFAULT false,
  mode           text NOT NULL DEFAULT 'PRIORITY' CHECK (mode IN ('PRIORITY','WEIGHTED')),
  pinned_banker  text,
  pinned_until   timestamptz,
  pin_reason     text,
  last_banker    text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     text
);

CREATE TABLE IF NOT EXISTS payin_banker_switch_members (
  provider_id  text NOT NULL,
  banker_code  text NOT NULL,
  in_rotation  boolean NOT NULL DEFAULT true,
  priority     int NOT NULL DEFAULT 10 CHECK (priority BETWEEN 1 AND 99),
  weight       int NOT NULL DEFAULT 1 CHECK (weight BETWEEN 0 AND 100),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text,
  PRIMARY KEY (provider_id, banker_code)
);

CREATE TABLE IF NOT EXISTS payin_banker_switch_events (
  id           bigserial PRIMARY KEY,
  provider_id  text NOT NULL,
  banker_code  text,
  action       text NOT NULL,   -- SETTINGS, MEMBER, PINNED, UNPINNED, AUTO_SWITCH, PASSED_OVER, NONE_AVAILABLE
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor        text NOT NULL,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payin_banker_switch_events_provider_idx ON payin_banker_switch_events (provider_id, at DESC);

CREATE OR REPLACE FUNCTION payin_banker_switch_events_locked() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'payin_banker_switch_events is append-only' USING ERRCODE = 'insufficient_privilege';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS payin_banker_switch_events_locked_trg ON payin_banker_switch_events;
CREATE TRIGGER payin_banker_switch_events_locked_trg BEFORE UPDATE OR DELETE ON payin_banker_switch_events
  FOR EACH ROW EXECUTE FUNCTION payin_banker_switch_events_locked();

ALTER TABLE vendor_payin_orders ADD COLUMN IF NOT EXISTS signed_by text;

-- A txnid is unique per SIGNING banker and mode, wherever the order went: a retry signed with the
-- same Key finds the order on whichever banker took it, and two racing requests cannot create it
-- on two bankers. For every order before this signed_by is NULL, so the key is the banker's own,
-- exactly as vendor_payin_orders_merchant_mode_order_uk (0026), which stays.
CREATE UNIQUE INDEX IF NOT EXISTS vendor_payin_orders_signer_mode_order_uk
  ON vendor_payin_orders (vendor, COALESCE(signed_by, merchant_id, ''), livemode, order_id);
