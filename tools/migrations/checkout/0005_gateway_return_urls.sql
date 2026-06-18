-- checkoutservice_db: for hosted-gateway (PayU) redirects, Katana sets the
-- gateway's surl/furl to its own return endpoint, and stores the MERCHANT's
-- success/failure URLs here so the return handler can forward the customer back.

ALTER TABLE checkout_orders ADD COLUMN IF NOT EXISTS client_surl text;
ALTER TABLE checkout_orders ADD COLUMN IF NOT EXISTS client_furl text;
