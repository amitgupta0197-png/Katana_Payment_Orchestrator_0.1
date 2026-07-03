-- Provider ↔ Branch settlement workflow (manual UTR + verification).
--
-- FLOW
--   1. A provider registers one or more BENEFICIARY bank accounts (the "dedicated
--      accounts" a branch must pay into).
--   2. The provider RAISES a settlement to a branch for the amount it has collected
--      (prefilled from the branch's verified SUCCESS pay-ins, editable).
--   3. The branch pays that beneficiary account externally and SUBMITS the UTR.
--   4. The provider sees the UTR (near-real-time) and VERIFIES it landed → the
--      branch's outstanding collected balance is reduced by the settled amount.
--   5. Admin can MARK-FOR-REVIEW and edit any field to fix reconciliation errors.
--
-- The orchestrator is the middle layer: it never moves money here, it records and
-- verifies the settlement and surfaces status to provider, branch, and admin.

CREATE TABLE IF NOT EXISTS provider_beneficiary_accounts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id       uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  label             text,                       -- friendly name e.g. "HDFC Current"
  beneficiary_name  text NOT NULL,
  account_number    text,
  ifsc              text,
  bank_name         text,
  mobile_number     text,
  vpa               text,                        -- UPI VPA (for UPI mode)
  transfer_mode     text NOT NULL DEFAULT 'IMPS'
                    CHECK (transfer_mode IN ('IMPS','RTGS','NEFT','UPI')),
  active            boolean NOT NULL DEFAULT true,
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prov_benef_provider ON provider_beneficiary_accounts (provider_id);

CREATE TABLE IF NOT EXISTS provider_branch_settlements (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id        uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  merchant_key       text NOT NULL,              -- branch (merchant_code)
  beneficiary_id     uuid REFERENCES provider_beneficiary_accounts(id),
  beneficiary_snapshot jsonb,                    -- stable copy of the benef at request time
  amount             numeric NOT NULL CHECK (amount > 0),
  currency           text NOT NULL DEFAULT 'INR',
  purpose            text,                        -- PoolPay purpose code (Cashbacks/VendorPayouts/…)
  status             text NOT NULL DEFAULT 'REQUESTED'
                     CHECK (status IN ('REQUESTED','UTR_SUBMITTED','VERIFIED','REJECTED','REVIEW','CANCELLED')),
  utr                text,                        -- branch-supplied UTR/RRN
  transfer_mode      text,
  note               text,                        -- free text (provider/branch/admin)
  -- lifecycle stamps
  requested_by       text,
  requested_at       timestamptz NOT NULL DEFAULT now(),
  utr_submitted_by   text,
  utr_submitted_at   timestamptz,
  verified_by        text,
  verified_at        timestamptz,
  review_by          text,
  review_at          timestamptz,
  review_note        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pbs_provider ON provider_branch_settlements (provider_id);
CREATE INDEX IF NOT EXISTS idx_pbs_merchant ON provider_branch_settlements (merchant_key);
CREATE INDEX IF NOT EXISTS idx_pbs_status   ON provider_branch_settlements (status);
