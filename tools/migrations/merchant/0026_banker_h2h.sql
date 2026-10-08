-- merchantservice_db: A BANKER'S OWN CHOICE OF HOST-TO-HOST (H2H) OR REDIRECT FOR INTENT.
--
-- A merchant chooses H2H or redirect for its Intent checkout (providers.needs_h2h, provider
-- 0023) and its bankers inherit it. A banker may have its own choice, which wins, the same way
-- a banker's own pay-in flow wins over its merchant's (lib/checkout-mode-store).
--
--   merchants.needs_h2h   NULL  the merchant's choice (every banker, so applying this changes nothing)
--                         true  H2H: no redirect-only Intent account without a Super Admin's note
--                         false redirect is fine, whatever the merchant chose

ALTER TABLE merchants ADD COLUMN IF NOT EXISTS needs_h2h        boolean;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS needs_h2h_set_by text;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS needs_h2h_set_at timestamptz;

-- Every change of a banker's own choice, append-only. NULL = back to the merchant's.
CREATE TABLE IF NOT EXISTS merchant_h2h_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_code text NOT NULL,
  from_value    boolean,
  to_value      boolean,
  changed_by    text,
  note          text,
  changed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS merchant_h2h_history_code_idx ON merchant_h2h_history (merchant_code, changed_at DESC);
