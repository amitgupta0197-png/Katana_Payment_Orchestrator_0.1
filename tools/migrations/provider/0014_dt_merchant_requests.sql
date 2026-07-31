-- DT flow role change (2026-07-31): the MERCHANT raises the DT purchase / refill
-- request and the BANKER confirms the DT was received. Previously the banker raised
-- and ADMIN/FINANCE confirmed.
--
-- Additive and idempotent. `requested_by_merchant` is NULLABLE on purpose: every
-- existing row was raised by a banker or an admin and has no merchant, and must stay
-- valid. A NULL therefore means "not merchant-raised", never "unknown merchant".
--
-- banker_id stays NOT NULL and keeps its meaning — the banker whose DT position this
-- is. The merchant column records who ASKED for it, which is a different question.

ALTER TABLE dt_purchases
  ADD COLUMN IF NOT EXISTS requested_by_merchant text;

ALTER TABLE dt_refill_requests
  ADD COLUMN IF NOT EXISTS requested_by_merchant text;

-- Who confirmed receipt, and when. Distinct from approved_by (the maker-checker
-- approval) so an audit can tell "admin approved the request" apart from "banker
-- confirmed the money arrived".
ALTER TABLE dt_purchases
  ADD COLUMN IF NOT EXISTS received_confirmed_by text,
  ADD COLUMN IF NOT EXISTS received_confirmed_at timestamptz;

ALTER TABLE dt_refill_requests
  ADD COLUMN IF NOT EXISTS received_confirmed_by text,
  ADD COLUMN IF NOT EXISTS received_confirmed_at timestamptz;

-- A merchant listing "my requests" filters on this column; without an index that is a
-- sequential scan of every purchase in the system on every page load.
CREATE INDEX IF NOT EXISTS dt_purchases_merchant_idx
  ON dt_purchases (requested_by_merchant, created_at DESC);

CREATE INDEX IF NOT EXISTS dt_refill_requests_merchant_idx
  ON dt_refill_requests (requested_by_merchant, created_at DESC);
