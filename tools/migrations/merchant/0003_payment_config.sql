-- merchantservice_db: per-merchant payment collection config.
--   enabled_methods — which collection methods the merchant may use
--   poolpay         — PoolPay (PG pay-in) settings for this merchant
CREATE TABLE IF NOT EXISTS merchant_payment_config (
  merchant_code   text PRIMARY KEY,
  tenant_id       text NOT NULL DEFAULT 'tenant-default',
  enabled_methods jsonb NOT NULL DEFAULT '["UPI_INTENT","UPI_COLLECT","CARD","NETBANKING","WALLET","QR","CRYPTO"]'::jsonb,
  poolpay         jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      text
);
