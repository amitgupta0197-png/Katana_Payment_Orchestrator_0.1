-- checkoutservice_db: TEST / LIVE MODE, PHASE 2 OF 2 (see 0007).
--
-- Drops UNIQUE (merchant_code) so a merchant can hold a test key and a live key at once.
-- Apply once the build whose issueCheckoutCreds replaces keys per (merchant_code, livemode)
-- is live. Uniqueness per mode is kept by merchant_checkout_keys_merchant_mode_uk (0007).

ALTER TABLE merchant_checkout_keys DROP CONSTRAINT IF EXISTS merchant_checkout_keys_merchant_code_key;
