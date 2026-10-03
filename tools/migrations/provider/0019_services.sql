-- providerservice_db: WHICH SERVICES A MERCHANT TAKES — pay-in, pay-out or both.
--
-- A merchant (a row of `providers`, "Merchants" in the dashboard) is onboarded for pay-ins,
-- for payouts, or for both. It is chosen when the merchant is created, beside its pay-in flow
-- (0017), and every banker mapped under the merchant obeys it: a PAYOUT merchant's bankers take
-- no pay-in orders, a PAYIN merchant's bankers send no payouts (lib/merchant-services).
--
-- UNSET is a merchant nobody has chosen for: every merchant that existed before this. It may do
-- both, as it always could, so applying this migration changes nothing until a choice is made.

ALTER TABLE providers ADD COLUMN IF NOT EXISTS services        text NOT NULL DEFAULT 'UNSET';
ALTER TABLE providers ADD COLUMN IF NOT EXISTS services_set_by text;
ALTER TABLE providers ADD COLUMN IF NOT EXISTS services_set_at timestamptz;

DO $$ BEGIN
  ALTER TABLE providers ADD CONSTRAINT providers_services_chk
    CHECK (services IN ('UNSET','PAYIN','PAYOUT','BOTH'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS providers_services_idx ON providers (services);

-- Every change of a merchant's services, append-only.
CREATE TABLE IF NOT EXISTS provider_services_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id   uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  from_services text,
  to_services   text NOT NULL,
  changed_by    text,
  note          text,
  changed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provider_services_history_provider_idx ON provider_services_history (provider_id, changed_at DESC);
