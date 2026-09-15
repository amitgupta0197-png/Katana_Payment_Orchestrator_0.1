-- vendorgatewayservice_db: TEST / LIVE MODE, PHASE 2 OF 2 (see 0026).
--
-- Drops the mode-blind order-ref index from 0024. Apply ONLY once the build whose
-- createPoolPayOrder says
--   ON CONFLICT (vendor, COALESCE(merchant_id, ''), livemode, order_id)
-- is live: the previous build names the index dropped here, and Postgres would reject every
-- pay-in insert with "no unique or exclusion constraint matching the ON CONFLICT
-- specification" until the new code is running.
--
-- After this, a merchant can use the same order ref once in test and once in live.

DROP INDEX IF EXISTS vendor_payin_orders_merchant_order_uk;
