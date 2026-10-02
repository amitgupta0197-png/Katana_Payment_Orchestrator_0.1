-- merchantservice_db: WEBHOOK VERSION — which callback contract a banker's server is sent.
--
--   v1  the status callback every integration already receives: STATUS Captured / Failed /
--       Expired, a HASH in the body signed with the checkout Salt (lib/merchant-callback).
--   v2  payment.success / payment.failed / payment.expired, signed in the X-Katana-Signature
--       header with the banker's own webhook secret (lib/webhook-v2).
--
-- EVERY EXISTING BANKER STAYS ON v1. The column is added with DEFAULT 'v1', which fills the
-- rows that exist; only then is the default moved to 'v2', so a banker created from here on
-- starts on v2. Nobody is moved by this migration: a banker changes version in the portal.
--
-- webhook_events: ALL (success, failed and expired) or PAID_ONLY (success only; the banker
-- reads the other outcomes from the status API).
-- webhook_secret: the v2 signing secret, sealed (lib/sealed-text, SEALED_COLUMNS). Shown once
-- when it is made; never selected for display.
--
-- Safe to apply before the code that reads it, and safe to run again.

ALTER TABLE merchants ADD COLUMN IF NOT EXISTS webhook_version text NOT NULL DEFAULT 'v1';
ALTER TABLE merchants ALTER COLUMN webhook_version SET DEFAULT 'v2';
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS webhook_events  text NOT NULL DEFAULT 'ALL';
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS webhook_secret  text;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS webhook_version_set_by text;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS webhook_version_set_at timestamptz;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'merchants_webhook_version_chk') THEN
    ALTER TABLE merchants ADD CONSTRAINT merchants_webhook_version_chk CHECK (webhook_version IN ('v1','v2'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'merchants_webhook_events_chk') THEN
    ALTER TABLE merchants ADD CONSTRAINT merchants_webhook_events_chk CHECK (webhook_events IN ('ALL','PAID_ONLY'));
  END IF;
END $$;
