-- vendorgatewayservice_db: PAY-IN COMPLIANCE FLAGS — transaction patterns a compliance officer
-- should look at (lib/payin-compliance), found by a scheduled scan of live, paid orders.
--
--   STRUCTURING          several orders just under ₹50,000 within one hour
--   VOLUME_SPIKE         a day's total over three times the banker's 30-day daily average
--   NEW_MERCHANT_VOLUME  over ₹5,00,000 in a banker's first seven days
--   ROUND_AMOUNTS        more than 80% of a day's orders are round thousands
--   CTR_THRESHOLD        a day's total over ₹10,00,000
--   HIGH_VALUE           orders of ₹50,000 or more (a record, not an alert)
--
-- One row per banker, rule and day (India time). The scan updates the row's detail while the
-- day runs and never changes its review: a flag a person has reviewed stays reviewed.
-- A flag is a prompt to look, not a finding. Filing an STR or CTR is a person's decision.

CREATE TABLE IF NOT EXISTS payin_compliance_flags (
  id             bigserial PRIMARY KEY,
  merchant_id    text NOT NULL,
  rule           text NOT NULL CHECK (rule IN ('STRUCTURING','VOLUME_SPIKE','NEW_MERCHANT_VOLUME','ROUND_AMOUNTS','CTR_THRESHOLD','HIGH_VALUE')),
  flag_date      date NOT NULL,
  severity       text NOT NULL CHECK (severity IN ('INFO','WARN','CRITICAL')),
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status         text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLEARED','ESCALATED','REPORTED')),
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  reviewed_by    text,
  reviewed_at    timestamptz,
  review_note    text,
  UNIQUE (merchant_id, rule, flag_date)
);
CREATE INDEX IF NOT EXISTS payin_compliance_flags_open_idx ON payin_compliance_flags (flag_date DESC) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS payin_compliance_flags_merchant_idx ON payin_compliance_flags (merchant_id, flag_date DESC);
