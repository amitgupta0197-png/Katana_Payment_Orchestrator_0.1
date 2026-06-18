-- checkoutservice_db: lookup from a merchant's Katana checkout key (mk_...) to
-- its merchant_code. The matching salt stays sealed in credential_vault; this
-- table only resolves which merchant a presented key belongs to so /api/pay can
-- verify the inbound signature. One active key per merchant.

CREATE TABLE IF NOT EXISTS merchant_checkout_keys (
  mkey          text PRIMARY KEY,
  merchant_code text NOT NULL UNIQUE,
  scheme        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
