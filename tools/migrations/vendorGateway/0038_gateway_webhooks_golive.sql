-- vendorgatewayservice_db: GATEWAY WEBHOOKS RECEIVED, and the GO-LIVE CHECKLIST.
--
-- gateway_webhook_events — one row per server-to-server event a pay-in gateway posted to
-- /api/gateway/<gateway>/webhook. Until now nothing recorded that an event arrived, only what
-- it changed, so "has this gateway stopped sending webhooks?" could not be answered. The
-- gateway health screen reads this (lib/gateway-performance). Staff only: it names gateways.
--
--   signature_ok  true / false, NULL when that gateway does not sign its events
--   outcome       what Katana did with it: APPLIED, ALREADY_FINAL, NOT_FINAL, UNKNOWN_ORDER,
--                 BAD_SIGNATURE, NOT_CONNECTED, LOOKUP_FAILED, IGNORED
--   order_id      the pay-in it was about, when it matched one

CREATE TABLE IF NOT EXISTS gateway_webhook_events (
  id            bigserial PRIMARY KEY,
  gateway       text NOT NULL,
  merchant_id   text,
  txn_id        text,
  order_id      uuid,
  signature_ok  boolean,
  outcome       text NOT NULL,
  gateway_status text,                  -- SUCCESS / FAILED / UNKNOWN as Katana read it
  received_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gateway_webhook_events_gateway_idx  ON gateway_webhook_events (gateway, received_at DESC);
CREATE INDEX IF NOT EXISTS gateway_webhook_events_merchant_idx ON gateway_webhook_events (merchant_id, gateway, received_at DESC);

-- gateway_golive — a banker's gateway account on its way to LIVE.
--
-- A row is made when live credentials are saved for a banker (POST …/gateway-mid, env PROD).
-- While it is VERIFYING the account takes only a few small real payments
-- (lib/gateway-golive: GOLIVE_VERIFY_MAX_AMOUNT / GOLIVE_VERIFY_MAX_ORDERS), enough to prove the
-- three things below; it becomes LIVE only when all are recorded, by a named member of staff.
--
--   ping_*      Katana's callback URL for that gateway answered HTTP 200 to a test request
--   webhook_*   a real payment on this account was confirmed by the gateway's own webhook
--   status_*    the gateway's status API said the same payment was paid
--
-- AN ACCOUNT WITH NO ROW IS NOT GATED. Every account that was taking live payments before this
-- table existed has none, and keeps working exactly as it did.

CREATE TABLE IF NOT EXISTS gateway_golive (
  merchant_id        text NOT NULL,
  gateway            text NOT NULL,
  status             text NOT NULL DEFAULT 'VERIFYING' CHECK (status IN ('VERIFYING','LIVE')),
  ping_ok            boolean,
  ping_http_status   integer,
  ping_at            timestamptz,
  ping_by            text,
  webhook_order_id   uuid,
  webhook_txn_id     text,                -- Katana's reference at the gateway for that payment
  webhook_at         timestamptz,
  webhook_by         text,
  status_order_id    uuid,
  status_at          timestamptz,
  status_by          text,
  live_at            timestamptz,
  live_by            text,
  note               text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         text,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, gateway)
);
