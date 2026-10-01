-- vendorgatewayservice_db: PAY-IN CHANNEL — every pay-in carries the rail it was collected on.
--
-- One merchant collects on more than one rail, and until now nothing recorded which:
-- vendor_payin_orders.channel is 'UPI_INTENT' on every order whatever took the payment. Two
-- rails exist today:
--
--   INTENT  a gateway issues the payment and confirms it (PayU, RubyVault, iSmartPay, …).
--           The money lands in the gateway's collection account.
--   P2P     the payer pays a banker's own UPI ID and the proof is a bank credit (phone
--           capture, email, UTR). Every row of vendor_txn_alerts is this rail.
--
-- channel_type is the FINAL channel and is what accounting and reconciliation use. It is
-- written when the order is created and never changed afterwards. requested_channel is what
-- was asked for before routing; today routing happens at creation, so the two are equal.
-- channel_id names the specific rail: the gateway for INTENT, UPI_DIRECT for P2P.
--
-- Safe to apply before the code that writes it: an order inserted by older code takes the
-- default and shows as UNCLASSIFIED rather than being silently assigned to a rail.

ALTER TABLE vendor_payin_orders ADD COLUMN IF NOT EXISTS channel_type      text NOT NULL DEFAULT 'UNCLASSIFIED';
ALTER TABLE vendor_payin_orders ADD COLUMN IF NOT EXISTS channel_id        text;
ALTER TABLE vendor_payin_orders ADD COLUMN IF NOT EXISTS requested_channel text;

ALTER TABLE vendor_txn_alerts   ADD COLUMN IF NOT EXISTS channel_type      text NOT NULL DEFAULT 'P2P';
ALTER TABLE vendor_txn_alerts   ADD COLUMN IF NOT EXISTS channel_id        text NOT NULL DEFAULT 'UPI_DIRECT';

DO $$ BEGIN
  ALTER TABLE vendor_payin_orders ADD CONSTRAINT vendor_payin_orders_channel_type_chk
    CHECK (channel_type IN ('INTENT','P2P','UNCLASSIFIED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE vendor_txn_alerts ADD CONSTRAINT vendor_txn_alerts_channel_type_chk
    CHECK (channel_type IN ('INTENT','P2P','UNCLASSIFIED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Legacy orders. The rail was never stored, but what decided it was: an order a gateway took
-- has meta.gateway.provider; an order sent to the live PoolPay vendor has integration.live with
-- no gateway; everything else was a UPI link to the banker's own UPI ID.
UPDATE vendor_payin_orders
   SET channel_type = 'INTENT', channel_id = meta->'gateway'->>'provider', requested_channel = 'INTENT'
 WHERE channel_type = 'UNCLASSIFIED' AND COALESCE(meta->'gateway'->>'provider', '') <> '';

UPDATE vendor_payin_orders
   SET channel_type = 'INTENT', channel_id = 'POOLPAY', requested_channel = 'INTENT'
 WHERE channel_type = 'UNCLASSIFIED' AND meta->'integration'->>'live' = 'true';

UPDATE vendor_payin_orders
   SET channel_type = 'P2P', channel_id = 'UPI_DIRECT', requested_channel = 'P2P'
 WHERE channel_type = 'UNCLASSIFIED' AND vendor = 'POOLPAY' AND meta IS NOT NULL;

CREATE INDEX IF NOT EXISTS vendor_payin_orders_channel_idx
  ON vendor_payin_orders (merchant_id, channel_type, created_at DESC);
