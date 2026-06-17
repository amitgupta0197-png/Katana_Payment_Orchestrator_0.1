-- checkoutservice_db: payment-method token vault + credential vault.
-- BRD §15 Security: "Separate card/token vault zone, strict network isolation,
-- least-privilege access and no raw PAN in main application."
--
-- Sprint 5 lives within checkoutservice_db for proximity to the payment
-- pipeline; Sprint 9 (Production Hardening) moves the vault to its own
-- network-isolated service per BRD §15.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS payment_tokens (
  token_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           text NOT NULL DEFAULT 'tenant-default',
  customer_ref        text NOT NULL,
  merchant_id         text NOT NULL,
  provider            text NOT NULL,
  provider_token_hash text NOT NULL,
    -- sha256 of the real provider token. We never store the token itself.
  network_token_id    text,            -- VISA / Mastercard network token reference
  method              text NOT NULL,   -- CARD | UPI | WALLET
  brand               text,            -- VISA | MC | AMEX | RUPAY | UPI
  last4               text,
  exp_month           integer,
  exp_year            integer,
  status              text NOT NULL DEFAULT 'ACTIVE',
    -- ACTIVE | SUSPENDED | EXPIRED | DELETED
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_used_at        timestamptz,
  refreshed_at        timestamptz
);
CREATE INDEX IF NOT EXISTS payment_tokens_customer_idx ON payment_tokens (customer_ref, status);
CREATE INDEX IF NOT EXISTS payment_tokens_merchant_idx ON payment_tokens (merchant_id, created_at DESC);

-- Credential vault (BRD §15: "Encrypt MID keys, API secrets, webhook secrets
-- and bank credentials with key rotation").
-- Stored as AES-256-GCM ciphertext + IV + auth_tag, keyed by a master key
-- supplied via env (production swaps to KMS / HSM).
CREATE TABLE IF NOT EXISTS credential_vault (
  credential_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           text NOT NULL,    -- vendor_secret | mid_secret | webhook_secret | bank_key
  owner_type     text NOT NULL,    -- vendor | merchant | provider | tenant
  owner_id       text NOT NULL,
  label          text NOT NULL,
  iv             bytea NOT NULL,
  auth_tag       bytea NOT NULL,
  ciphertext     bytea NOT NULL,
  key_version    integer NOT NULL DEFAULT 1,
  enabled        boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  rotated_at     timestamptz,
  rotated_by     text
);
CREATE UNIQUE INDEX IF NOT EXISTS credential_vault_uniq
  ON credential_vault (kind, owner_type, owner_id, label, key_version);
CREATE INDEX IF NOT EXISTS credential_vault_owner_idx
  ON credential_vault (owner_type, owner_id, kind);
