-- vendorgatewayservice_db: vendor pay-in orders + credentials.
-- Backs the PoolPay/Quickpay vendor cockpits and the PoolPay S2S order flow
-- (order create -> deeplink response -> status enquiry -> final status).

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS vendor_payin_orders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      text NOT NULL DEFAULT 'tenant-default',
  vendor         text NOT NULL,
  pay_id         text,                    -- gateway payment id (PoolPay pay_id)
  order_id       text NOT NULL,           -- our order reference
  amount         numeric(18,2) NOT NULL,
  currency_code  text NOT NULL DEFAULT 'INR',
  channel        text,                    -- UPI_INTENT | UPI_COLLECT | UPI_QR | ...
  vendor_txn_id  text,                    -- gateway transaction id
  rrn            text,                    -- bank reference (set on success)
  response_code  text,
  status         text NOT NULL DEFAULT 'INITIATED',  -- INITIATED|PENDING|SUCCESS|FAILED|EXPIRED
  customer_vpa   text,
  customer_phone text,
  meta           jsonb,                   -- deeplinks, upi_intent, qr_payload
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vendor, order_id)
);

CREATE INDEX IF NOT EXISTS vendor_payin_orders_vendor_idx
  ON vendor_payin_orders (vendor, created_at DESC);

CREATE TABLE IF NOT EXISTS vendor_credentials (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL DEFAULT 'tenant-default',
  vendor      text NOT NULL,
  env         text NOT NULL DEFAULT 'SANDBOX',
  pay_id      text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vendor, env)
);

-- Seed a sandbox PoolPay credential so the Credentials tab isn't empty.
INSERT INTO vendor_credentials (vendor, env, pay_id, active)
VALUES ('POOLPAY', 'SANDBOX', 'pay_sandbox_poolpay', true)
ON CONFLICT (vendor, env) DO NOTHING;
