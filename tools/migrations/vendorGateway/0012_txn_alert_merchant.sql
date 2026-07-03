-- Attribute captured credit alerts to a branch even when the email/SMS carries no
-- payee VPA (e.g. Paytm "Rs X paid at …" wallet notices). The source inbox/device is
-- merchant-scoped, so we stamp that merchant on the alert and let the provider
-- dashboard scope by it. Idempotent.
ALTER TABLE vendor_txn_alerts ADD COLUMN IF NOT EXISTS merchant_id text;
CREATE INDEX IF NOT EXISTS vendor_txn_alerts_merchant_idx ON vendor_txn_alerts (merchant_id) WHERE merchant_id IS NOT NULL;
