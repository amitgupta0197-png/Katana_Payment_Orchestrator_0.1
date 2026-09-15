-- checkoutservice_db: TEST / LIVE MODE, PHASE 1 OF 2 (see 0008).
--
-- `livemode` on hosted-checkout orders and on the merchant's checkout keys. Same rules as
-- vendorGateway 0026: NOT NULL DEFAULT true, so every existing order and key stays live and
-- current integrations keep working unchanged. Safe to apply before the code that uses it.

ALTER TABLE checkout_orders        ADD COLUMN IF NOT EXISTS livemode boolean NOT NULL DEFAULT true;
ALTER TABLE merchant_checkout_keys ADD COLUMN IF NOT EXISTS livemode boolean NOT NULL DEFAULT true;

-- ONE KEY PER MERCHANT PER MODE. A merchant gets a test pair (mk_test_…) and a live pair
-- (mk_live_…); legacy mk_<hex> keys are live. The old UNIQUE (merchant_code) stays until 0008
-- — the current code deletes-then-inserts by merchant_code and never relies on that
-- constraint, but it would block issuing a second (test) key.
CREATE UNIQUE INDEX IF NOT EXISTS merchant_checkout_keys_merchant_mode_uk
  ON merchant_checkout_keys (merchant_code, livemode);

-- Test runs of the admin "Test checkout" harness (test-pay) used txnid / idempotency key
-- TEST-<epoch>. They were never real payments.
UPDATE checkout_orders SET livemode = false
 WHERE livemode = true AND (idempotency_key LIKE 'TEST-%' OR txn_id LIKE 'TEST-%');
