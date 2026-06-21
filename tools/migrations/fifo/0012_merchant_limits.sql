-- fifoservice_db: per-merchant transaction limits (BRD FR-003, §11.A, §15 step 3).
-- NULL columns = no limit on that dimension. Enforced at order intake for pay-ins.

CREATE TABLE IF NOT EXISTS fifo_merchant_limits (
  merchant_id   text PRIMARY KEY,
  currency      text NOT NULL DEFAULT 'INR',
  per_txn_minor bigint,
  daily_minor   bigint,
  monthly_minor bigint,
  created_at    timestamptz NOT NULL DEFAULT now()
);
