-- vendorgatewayservice_db: PAIRING A CAPTURE PHONE BY QR, AND WHICH BHARATPE KEY IT HOLDS.
--
-- Staff make a one-time pairing code for a banker (lib/agent-pair). The banker's phone opens
-- https://katanapay.co/pair/<code> (the QR) or types the code into the Katana Agent, which
-- redeems it at POST /api/v1/agent/pair and sets itself up: banker code, server, the payment app
-- to read and, for BharatPe, the MID's key + secret. A code lives 15 minutes and works once; only
-- its SHA-256 is stored.
CREATE TABLE IF NOT EXISTS agent_pair_codes (
  code_hash      text PRIMARY KEY,
  merchant_code  text NOT NULL,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz,
  used_by_device text
);
CREATE INDEX IF NOT EXISTS agent_pair_codes_merchant_idx ON agent_pair_codes (merchant_code, created_at DESC);

-- The BharatPe key the phone signs with, as a hint ("bpk_live_dm_F…xy"), from the agent's
-- heartbeat: lets "Check this banker" say when the phone holds another MID's key.
ALTER TABLE vendor_devices ADD COLUMN IF NOT EXISTS bharatpe_key_hint text;
