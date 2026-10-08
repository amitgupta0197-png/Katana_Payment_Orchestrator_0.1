-- vendorgatewayservice_db: BharatPe MIDs (lib/bharatpe-store, lib/bharatpe-setup).
--
-- BharatPe is a P2P-only pay-in source with no API: the customer pays the banker's BharatPe QR, the
-- money lands in the banker's own bank account, and the Katana agent app captures the credit on the
-- merchant's own device and posts it back to be confirmed the ordinary P2P way (confirmKatanaOrder).
-- This table holds the per-MID agent↔Katana credentials, NOT a gateway account: the BharatPe UPI ID
-- itself is saved as the banker's P2P settlement VPA in merchant_payment_config.katana_pay, and a
-- BharatPe order is a pure P2P order (no meta.gateway), so nothing here routes or confirms money.
--
--   api_key        bpk_live_… / bpk_test_…  — identifies the MID on the ingestion endpoint (not secret)
--   secret_sealed  the HMAC key the agent signs each post with (sealed with lib/sealed-text)
--   payee_vpa      the BharatPe UPI ID the customer pays (mirror of the settlement VPA, for display)
--
-- The secret lives in this ordinary column sealed, so it is also listed in SEALED_COLUMNS.
-- Re-runnable. Additive only.

CREATE TABLE IF NOT EXISTS bharatpe_mids (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_code        text NOT NULL,                       -- the banker this MID belongs to
  label                text NOT NULL,                        -- a name staff give this MID
  bharatpe_merchant_id text,                                 -- the BharatPe merchant id (digits)
  payee_vpa            text NOT NULL,                        -- BharatPe UPI ID (lowercased)
  api_key              text NOT NULL UNIQUE,                 -- bpk_live_… / bpk_test_…
  secret_sealed        text NOT NULL,                        -- sealed HMAC secret (never returned)
  env                  text NOT NULL DEFAULT 'TEST' CHECK (env IN ('TEST', 'PROD')),
  status               text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_by           text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_code, label)
);
CREATE INDEX IF NOT EXISTS bharatpe_mids_merchant_idx ON bharatpe_mids (merchant_code, status);
