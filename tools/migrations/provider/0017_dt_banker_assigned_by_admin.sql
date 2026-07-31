-- Banker assignment moves to the admin (2026-07-31).
--
-- A merchant raises a DT request without naming a banker — it must not see the banker
-- roster at all. Katana assigns the banker when approving the request.
--
-- That means a request can exist before its banker is known, so banker_id can no
-- longer be NOT NULL. Dropping NOT NULL is backward-compatible: every existing row
-- already has a value and is unaffected.
--
-- The invariant is enforced in the application instead, where it actually belongs: a
-- purchase cannot leave PENDING_APPROVAL without an assigned banker. A NULL banker_id
-- therefore means "awaiting assignment", never "no banker".

ALTER TABLE dt_purchases        ALTER COLUMN banker_id DROP NOT NULL;
ALTER TABLE dt_refill_requests  ALTER COLUMN banker_id DROP NOT NULL;

-- Who assigned the banker, and when — distinct from approved_by, since assignment and
-- approval can be done by different people.
ALTER TABLE dt_purchases
  ADD COLUMN IF NOT EXISTS banker_assigned_by text,
  ADD COLUMN IF NOT EXISTS banker_assigned_at timestamptz;

ALTER TABLE dt_refill_requests
  ADD COLUMN IF NOT EXISTS banker_assigned_by text,
  ADD COLUMN IF NOT EXISTS banker_assigned_at timestamptz;

-- "Which requests still need a banker?" is the admin's queue for this.
CREATE INDEX IF NOT EXISTS dt_purchases_unassigned_idx
  ON dt_purchases (status, created_at DESC) WHERE banker_id IS NULL;
