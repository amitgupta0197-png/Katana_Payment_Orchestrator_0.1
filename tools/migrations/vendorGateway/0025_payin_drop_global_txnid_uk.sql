-- vendorgatewayservice_db: PHASE 2 of the merchant-scoped idempotency fix (see 0024).
--
-- Drops the old platform-wide UNIQUE (vendor, order_id). Apply this ONLY once the build
-- carrying the new `ON CONFLICT (vendor, COALESCE(merchant_id, ''), order_id)` is live —
-- the previous code names the constraint being dropped here, and would fail on every
-- insert without it.
--
-- Until this runs, two merchants sharing a txnid collide with a unique violation rather
-- than one being handed the other's order. After it runs, they simply get their own
-- orders, which is the intended behaviour.

ALTER TABLE vendor_payin_orders
  DROP CONSTRAINT IF EXISTS vendor_payin_orders_vendor_order_id_key;
