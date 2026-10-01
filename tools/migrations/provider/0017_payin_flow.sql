-- providerservice_db: PAY-IN BUSINESS FLOW at the merchant (provider) level.
--
-- A merchant — a row of `providers`, "Merchants" in the dashboard — is put on a Katana pay-in
-- flow: P2P, INTENT or BOTH; for BOTH, payin_active_flow says which of the two is in use.
-- Every banker (branch) mapped under the merchant takes that flow, unless the banker has a
-- flow of its own (merchant 0010, merchant_payment_config.payin_flow), which wins.
--
-- UNSET is a merchant nobody has chosen for yet: its bankers keep the routing they always had.

ALTER TABLE providers ADD COLUMN IF NOT EXISTS payin_flow        text NOT NULL DEFAULT 'UNSET';
ALTER TABLE providers ADD COLUMN IF NOT EXISTS payin_active_flow text;
ALTER TABLE providers ADD COLUMN IF NOT EXISTS payin_flow_set_by text;
ALTER TABLE providers ADD COLUMN IF NOT EXISTS payin_flow_set_at timestamptz;

DO $$ BEGIN
  ALTER TABLE providers ADD CONSTRAINT providers_payin_flow_chk
    CHECK (payin_flow IN ('UNSET','P2P','INTENT','BOTH'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE providers ADD CONSTRAINT providers_payin_active_flow_chk
    CHECK (payin_active_flow IS NULL OR payin_active_flow IN ('P2P','INTENT'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE providers ADD CONSTRAINT providers_payin_both_chk
    CHECK ((payin_flow = 'BOTH') = (payin_active_flow IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS providers_payin_flow_idx ON providers (payin_flow);

-- Every change of a merchant's flow, append-only.
CREATE TABLE IF NOT EXISTS provider_payin_flow_history (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id      uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  from_flow        text,
  from_active_flow text,
  to_flow          text NOT NULL,
  to_active_flow   text,
  changed_by       text,
  note             text,
  changed_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provider_payin_flow_history_provider_idx ON provider_payin_flow_history (provider_id, changed_at DESC);
