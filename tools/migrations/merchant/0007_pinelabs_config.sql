-- merchantservice_db: per-branch Pine Labs (Plural) API credentials, so Katana can pull
-- that merchant's transactions + RRN from Pine Labs. Non-secret fields live here; the
-- client_secret is sealed in the credential_vault (kind=merchant_secret, owner=merchant,
-- label=pinelabs_client_secret). Keyed by merchant_code so admin and merchant self-serve
-- read/write the same row.
CREATE TABLE IF NOT EXISTS pinelabs_config (
  merchant_code         text PRIMARY KEY,
  enabled               boolean NOT NULL DEFAULT false,
  env                   text NOT NULL DEFAULT 'PROD' CHECK (env IN ('SANDBOX','PROD')),
  client_id             text,                 -- Pine Labs / Plural client id (not sensitive)
  pinelabs_merchant_id  text,                 -- the merchant's id on Pine Labs' side
  secret_set            boolean NOT NULL DEFAULT false,   -- is a client_secret vaulted?
  updated_by            text,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now()
);
