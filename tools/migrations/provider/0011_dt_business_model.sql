-- providerservice_db: DT (Digital Token) Business Model — Phase 1 (Foundation).
-- Additive schema per the DT BRD §18. ALL tables are inert until the UI/routing phases
-- wire them up — nothing reads or writes them yet, so applying this changes NO live
-- behaviour (safe, reversible, feature-flag-gated later). The double-entry ledger reuses
-- the EXISTING ledgerservice_db.journal_entries; audit uses dt_audit_logs here.
--
-- Terminology (BRD §1): DT is an internal configurable commercial unit used to fund and
-- control banker traffic allocation. It is NOT a regulated currency/deposit/investment.
-- Commercial waterfall (BRD §5/§14): merchant 5.75% − banker 4.50% = Katana 1.25%.

-- ── Pricing: versioned, effective-dated DT rate cards ────────────────────────
CREATE TABLE IF NOT EXISTS dt_rate_cards (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  currency       text NOT NULL DEFAULT 'INR',
  rate           numeric(18,4) NOT NULL,               -- Katana-controlled price per DT unit
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to   timestamptz,
  status         text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT','ACTIVE','EXPIRED','SUPERSEDED')),
  version        integer NOT NULL DEFAULT 1,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dt_rate_cards_active_idx ON dt_rate_cards (status, effective_from DESC);

-- ── DT purchase lifecycle (BRD §10 status model) ─────────────────────────────
-- One row per banker advance purchase. buy_rate is snapshotted from the rate card.
CREATE TABLE IF NOT EXISTS dt_purchases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        text NOT NULL DEFAULT 'tenant-default',
  banker_id        text NOT NULL,                       -- provider code/id (banker)
  quantity         numeric(18,4) NOT NULL CHECK (quantity > 0),
  buy_rate         numeric(18,4) NOT NULL,              -- Katana-controlled rate at purchase
  total_amount     numeric(18,2) NOT NULL,              -- advance debit = quantity × buy_rate
  priority_percent numeric(5,2) NOT NULL DEFAULT 60.00, -- → traffic quota
  security_percent numeric(5,2) NOT NULL DEFAULT 40.00, -- → security reserve
  rate_version     integer,
  rule_version     integer,
  status           text NOT NULL DEFAULT 'DRAFT'
                   CHECK (status IN ('DRAFT','PENDING_APPROVAL','AWAITING_FUNDS','FUNDS_SUBMITTED',
                                     'ACTIVE','EXHAUSTED','SUSPENDED','REFILLED','CLOSED','REJECTED')),
  payment_ref      text,
  created_by       text,
  approved_by      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dt_purchases_banker_idx ON dt_purchases (banker_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS dt_purchases_status_idx ON dt_purchases (status);

-- ── Advance funding verification (Finance confirms the banker paid) ──────────
CREATE TABLE IF NOT EXISTS funding_confirmations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id  uuid NOT NULL REFERENCES dt_purchases(id) ON DELETE CASCADE,
  reference_no text NOT NULL,                            -- bank ref Finance verifies against
  amount       numeric(18,2) NOT NULL,
  proof_uri    text,
  verified_by  text,
  verified_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS funding_confirmations_purchase_idx ON funding_confirmations (purchase_id);

-- ── Traffic quota (60% priority) per purchase — the routable capacity ────────
-- available = allocated − reserved − consumed (+ reversals). UI-derived; sub-ledger truth.
CREATE TABLE IF NOT EXISTS traffic_allocations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id      uuid NOT NULL REFERENCES dt_purchases(id) ON DELETE CASCADE,
  priority_percent numeric(5,2) NOT NULL,
  allocated        numeric(18,2) NOT NULL,               -- advance × priority%
  reserved         numeric(18,2) NOT NULL DEFAULT 0,     -- in-flight locks
  consumed         numeric(18,2) NOT NULL DEFAULT 0,     -- successful eligible traffic
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','EXHAUSTED','CLOSED')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS traffic_allocations_purchase_idx ON traffic_allocations (purchase_id, status);

-- ── Security reserve (40%) per purchase — locked under Katana control ────────
CREATE TABLE IF NOT EXISTS security_reserves (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id    uuid NOT NULL REFERENCES dt_purchases(id) ON DELETE CASCADE,
  reserve_percent numeric(5,2) NOT NULL,
  held           numeric(18,2) NOT NULL,                 -- advance × security%
  released       numeric(18,2) NOT NULL DEFAULT 0,       -- release requires approval (OD-03)
  status         text NOT NULL DEFAULT 'HELD' CHECK (status IN ('HELD','PARTIALLY_RELEASED','RELEASED')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS security_reserves_purchase_idx ON security_reserves (purchase_id);

-- ── In-flight quota locks (reserve before provider call; consume/release after) ─
CREATE TABLE IF NOT EXISTS traffic_reservations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_ref     text NOT NULL,                           -- merchant pay-in order
  allocation_id uuid NOT NULL REFERENCES traffic_allocations(id) ON DELETE CASCADE,
  amount        numeric(18,2) NOT NULL,
  status        text NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED','CONSUMED','RELEASED','EXPIRED')),
  reason        text,
  expiry        timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS traffic_reservations_alloc_idx ON traffic_reservations (allocation_id, status);
CREATE INDEX IF NOT EXISTS traffic_reservations_order_idx ON traffic_reservations (order_ref);

-- ── Effective-dated commission rules (BRD §14 hierarchy) ─────────────────────
-- global → banker → merchant group → branch → channel → contract override.
CREATE TABLE IF NOT EXISTS commission_rules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope          text NOT NULL DEFAULT 'GLOBAL'
                 CHECK (scope IN ('GLOBAL','BANKER','MERCHANT_GROUP','BRANCH','CHANNEL','CONTRACT')),
  banker_id      text,
  merchant_group text,
  branch         text,
  channel        text,
  merchant_rate  numeric(6,4) NOT NULL DEFAULT 5.75,     -- % charged to merchant
  banker_rate    numeric(6,4) NOT NULL DEFAULT 4.50,     -- % payable to banker
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to   timestamptz,
  version        integer NOT NULL DEFAULT 1,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commission_rules_scope_idx ON commission_rules (scope, effective_from DESC);

-- ── Per-transaction commission accrual (the waterfall) ───────────────────────
CREATE TABLE IF NOT EXISTS commission_entries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_ref   text NOT NULL,
  purchase_lot      uuid REFERENCES dt_purchases(id),
  base_amount       numeric(18,2) NOT NULL,              -- eligible amount
  merchant_charge   numeric(18,2) NOT NULL,              -- base × merchant_rate
  banker_commission numeric(18,2) NOT NULL,              -- base × banker_rate
  katana_margin     numeric(18,2) NOT NULL,              -- merchant_charge − banker_commission
  rule_version      integer,
  reversal_of       uuid REFERENCES commission_entries(id),  -- refund/reversal linkage
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commission_entries_txn_idx ON commission_entries (transaction_ref);

-- ── Refill workflow (BRD §16 thresholds) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS dt_refill_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  banker_id     text NOT NULL,
  allocation_id uuid REFERENCES traffic_allocations(id),
  quantity      numeric(18,4),
  trigger       text CHECK (trigger IN ('LOW_BALANCE','EXHAUSTION','MANUAL')),
  status        text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','FUNDED','VERIFIED','CLOSED','CANCELLED')),
  expiry        timestamptz,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dt_refill_requests_banker_idx ON dt_refill_requests (banker_id, status);

-- ── Module audit trail (immutable before/after) ──────────────────────────────
CREATE TABLE IF NOT EXISTS dt_audit_logs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor      text,
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  text,
  before     jsonb,
  after      jsonb,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dt_audit_logs_entity_idx ON dt_audit_logs (entity, entity_id, created_at DESC);
