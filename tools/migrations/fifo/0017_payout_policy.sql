-- fifoservice_db: per-merchant payout policy (payout tracker, Merchant Mapping sheet).
-- NULL = no limit on that dimension; an empty/NULL allowed_rails = every rail.
-- Enforced when a payout is created (dashboard or API). Re-runnable. Apply after 0016.

CREATE TABLE IF NOT EXISTS fifo_payout_policies (
  merchant_id     text PRIMARY KEY,
  min_txn_minor   bigint,
  max_txn_minor   bigint,
  daily_minor     bigint,           -- sum of the day's (IST) payouts that weren't refused
  allowed_rails   text[],           -- subset of IMPS / NEFT / RTGS / UPI
  -- AUTO: only payouts at or above the high-value threshold wait for approval.
  -- MAKER_CHECKER: every payout waits for a second person.
  approval_rule   text NOT NULL DEFAULT 'AUTO' CHECK (approval_rule IN ('AUTO','MAKER_CHECKER')),
  updated_by      text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
