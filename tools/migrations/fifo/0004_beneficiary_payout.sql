-- fifoservice_db: beneficiary registry (BRD §11.B) + maker-checker approvals
-- (BRD §9, §18). Payout orders reuse fifo_orders (direction='PAYOUT',
-- beneficiary_id already present in 0001). Account numbers are stored server-side
-- and masked in API responses (SEC-008); the whitelist == status 'APPROVED'.

CREATE TABLE IF NOT EXISTS fifo_beneficiaries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL DEFAULT 'tenant-default',
  merchant_id     text NOT NULL,
  beneficiary_name text NOT NULL,
  bank_name       text,
  account_number  text,                 -- stored server-side, masked in API
  account_last4   text,
  ifsc            text,
  upi_id          text,
  wallet_address  text,                 -- USDT
  network         text,                 -- TRC20 / ERC20 ...
  status          text NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','APPROVED','REJECTED','DISABLED')),
  created_by      text,
  approved_by     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  approved_at     timestamptz
);
CREATE INDEX IF NOT EXISTS fifo_beneficiaries_merchant_idx ON fifo_beneficiaries (merchant_id, status);

-- Maker-checker approval queue (BRD §9). Generic over action_type.
CREATE TABLE IF NOT EXISTS fifo_approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL DEFAULT 'tenant-default',
  action_type   text NOT NULL,          -- PAYOUT_HIGH_VALUE | USDT_WALLET_CHANGE | BENEFICIARY_ADD | SETTLEMENT_RELEASE
  resource_type text,
  resource_id   text,
  order_ref     text,
  merchant_id   text,
  amount_minor  bigint,
  currency      text DEFAULT 'INR',
  detail        text,
  payload       jsonb,
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  maker         text,
  checker       text,
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz
);
CREATE INDEX IF NOT EXISTS fifo_approvals_status_idx ON fifo_approvals (status, created_at DESC);
