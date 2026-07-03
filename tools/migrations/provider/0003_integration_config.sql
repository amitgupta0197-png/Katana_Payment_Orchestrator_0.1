-- Provider-level payment-gateway integration config (PoolPay / Katana Pay AUTO).
--
-- An admin configures a PG integration ONCE on a provider; every merchant
-- (branch) mapped under that provider inherits it automatically (cascade), so
-- their pay-ins sign/route with the provider's credentials and reconcile against
-- the provider's funnel. A merchant may still override individual fields via
-- merchant_payment_config.poolpay (precedence: merchant > provider > env default).
--
-- Secrets (SECRET_KEY for the SHA256 hash, API key/bearer) are NEVER stored here.
-- They live AES-256-GCM-encrypted in the credential_vault (checkout DB), keyed
-- (kind='vendor_secret', owner_type='provider', owner_id=<provider_id>,
--  label='poolpay:secret' | 'poolpay:apikey'). This row only flags secret_set so
-- the UI/cascade can tell whether a secret has been saved without exposing it.

CREATE TABLE IF NOT EXISTS provider_integration_config (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id   uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  vendor        text NOT NULL DEFAULT 'POOLPAY',
  enabled       boolean NOT NULL DEFAULT false,
  env           text NOT NULL DEFAULT 'SANDBOX' CHECK (env IN ('SANDBOX','PROD')),
  base_url      text,                         -- e.g. https://core.pp-007.com
  pay_id        text,                         -- PAY_ID base provided by PoolPay
  client_id     text,                         -- x-client-id (optional)
  return_url    text,                         -- merchant return URL (RETURN_URL)
  callback_url  text,                         -- our callback the PG posts to
  secret_set    boolean NOT NULL DEFAULT false,
  apikey_set    boolean NOT NULL DEFAULT false,
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- extra knobs (currency, channel, …)
  updated_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, vendor)
);

CREATE INDEX IF NOT EXISTS idx_prov_integ_provider
  ON provider_integration_config (provider_id);
