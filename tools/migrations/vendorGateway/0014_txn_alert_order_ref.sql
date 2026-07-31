-- Adds order_ref captured from parsed bank/UPI alerts (e.g. hosted-checkout order id
-- embedded in the narration) so the reconciler can match on it directly.
-- Already applied ad-hoc on production (2026-07); checked in to keep schemas in sync.
ALTER TABLE vendor_txn_alerts ADD COLUMN IF NOT EXISTS order_ref text;
