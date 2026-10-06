-- providerservice_db: A MERCHANT THAT NEEDS HOST-TO-HOST (H2H) CHECKOUT.
--
-- An Intent payment account is either host-to-host (the order API returns the UPI link and QR
-- for the merchant's own page) or redirect (the customer pays on the gateway's hosted page),
-- decided per gateway by lib/pg-catalog gatewayCheckoutMode. A merchant whose integration shows
-- the UPI link itself needs H2H: its bankers may not be given a redirect-only account (refused
-- with 409 H2H_REQUIRED unless a Super Admin overrides with a note), and readiness flags one
-- that has one.
--
-- Additive: false for every merchant, so applying this changes nothing until it is switched on.

ALTER TABLE providers ADD COLUMN IF NOT EXISTS needs_h2h        boolean NOT NULL DEFAULT false;
ALTER TABLE providers ADD COLUMN IF NOT EXISTS needs_h2h_set_by text;
ALTER TABLE providers ADD COLUMN IF NOT EXISTS needs_h2h_set_at timestamptz;

-- Every change of the setting, append-only.
CREATE TABLE IF NOT EXISTS provider_h2h_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  from_value  boolean,
  to_value    boolean NOT NULL,
  changed_by  text,
  note        text,
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provider_h2h_history_provider_idx ON provider_h2h_history (provider_id, changed_at DESC);
