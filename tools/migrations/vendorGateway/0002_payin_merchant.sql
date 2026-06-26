-- vendorgatewayservice_db: associate pay-in orders with the merchant that
-- created them (merchant-signed /api/v1/poolpay/order). Lets the cockpit show a
-- per-merchant ops queue.

ALTER TABLE vendor_payin_orders ADD COLUMN IF NOT EXISTS merchant_id text;

CREATE INDEX IF NOT EXISTS vendor_payin_orders_merchant_idx
  ON vendor_payin_orders (merchant_id, created_at DESC);
