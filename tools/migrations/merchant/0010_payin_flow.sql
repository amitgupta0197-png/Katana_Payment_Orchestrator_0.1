-- merchantservice_db: PAY-IN BUSINESS FLOW of one banker — which Katana pay-in flow its orders take.
--
-- Katana takes pay-ins on two flows:
--
--   P2P     the payer pays the banker's own UPI ID; the proof is a bank credit.
--   INTENT  a payment gateway issues the payment and confirms it.
--
-- Until now the flow of an order was inferred from whichever credentials the merchant happened
-- to have. It is now an explicit choice made for the merchant:
--
--   payin_flow         P2P | INTENT | BOTH | UNSET
--   payin_active_flow  for BOTH only: the flow (P2P or INTENT) the merchant's orders take
--
-- A row here is a BANKER (a branch; "Banker" in the dashboard). The flow is normally selected
-- once for the merchant the banker belongs to (provider 0017, providers.payin_flow) and every
-- banker under it inherits that. A flow set here is that one banker's own and wins over the
-- merchant's.
--
-- UNSET is a banker with no flow of its own: it takes the merchant's, and when the merchant has
-- none either its orders keep the old inferred routing. Applying this migration therefore
-- changes nothing until a flow is selected.

ALTER TABLE merchant_payment_config ADD COLUMN IF NOT EXISTS payin_flow        text NOT NULL DEFAULT 'UNSET';
ALTER TABLE merchant_payment_config ADD COLUMN IF NOT EXISTS payin_active_flow text;
ALTER TABLE merchant_payment_config ADD COLUMN IF NOT EXISTS payin_flow_set_by text;
ALTER TABLE merchant_payment_config ADD COLUMN IF NOT EXISTS payin_flow_set_at timestamptz;

DO $$ BEGIN
  ALTER TABLE merchant_payment_config ADD CONSTRAINT merchant_payment_config_payin_flow_chk
    CHECK (payin_flow IN ('UNSET','P2P','INTENT','BOTH'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE merchant_payment_config ADD CONSTRAINT merchant_payment_config_payin_active_flow_chk
    CHECK (payin_active_flow IS NULL OR payin_active_flow IN ('P2P','INTENT'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- BOTH always says which of the two is in use; a single-flow merchant never carries one.
DO $$ BEGIN
  ALTER TABLE merchant_payment_config ADD CONSTRAINT merchant_payment_config_payin_both_chk
    CHECK ((payin_flow = 'BOTH') = (payin_active_flow IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS merchant_payment_config_payin_flow_idx ON merchant_payment_config (payin_flow);

-- Every change of a merchant's flow, append-only: who moved it from what to what, and why.
CREATE TABLE IF NOT EXISTS merchant_payin_flow_history (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_code    text NOT NULL,
  from_flow        text,
  from_active_flow text,
  to_flow          text NOT NULL,
  to_active_flow   text,
  changed_by       text,
  note             text,
  changed_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS merchant_payin_flow_history_merchant_idx ON merchant_payin_flow_history (merchant_code, changed_at DESC);
