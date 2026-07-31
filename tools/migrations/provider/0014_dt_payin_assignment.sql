-- DT pay-in assignment (2026-08-01).
--
-- Business model: Katana advances USDT to a merchant; the merchant repays in pay-in
-- "population" — incoming traffic collected through its bankers. Until now nothing
-- recorded WHICH merchant repays a given purchase lot, so dt-engine.processOrder had to
-- be handed a banker_id by the caller and could only run from /api/v1/dt/simulate.
--
-- NAMING — read before using this column. In this database `merchant_id` conventionally
-- means the BRANCH code (merchants.merchant_code), which the UI now displays as "Banker".
-- The party the UI now calls "Merchant" is a row in `providers`. To keep that distinction
-- unmissable the column is named payin_merchant_code and holds providers.code — NOT a
-- merchants.merchant_code and NOT a uuid.
--
--   pay-in lands with vendor_txn_alerts.merchant_id  (= merchants.merchant_code, a banker)
--     -> provider_merchant_mappings                   (banker -> merchant)
--       -> providers.code                             (= dt_purchases.payin_merchant_code)
--         -> FIFO over that merchant's ACTIVE lots
--
-- Additive and reversible: existing lots keep payin_merchant_code NULL and are simply
-- never selected by the pay-in path, so nothing changes until an admin assigns one.

ALTER TABLE dt_purchases ADD COLUMN IF NOT EXISTS payin_merchant_code text;

COMMENT ON COLUMN dt_purchases.payin_merchant_code IS
  'providers.code of the merchant whose incoming pay-ins consume this lot. NOT merchants.merchant_code.';

-- Lookup path for every incoming pay-in: assigned merchant + status, oldest first (OD-05 FIFO).
CREATE INDEX IF NOT EXISTS dt_purchases_payin_merchant_idx
  ON dt_purchases (payin_merchant_code, status, created_at)
  WHERE payin_merchant_code IS NOT NULL;

-- Pay-ins that arrived with no funded lot to consume. The money has already landed, so it
-- is never rejected — it is recorded here and surfaced to admin to resolve (top-up, refill
-- or manual assignment). Kept separate from dt_journal_entries because this is an
-- operational queue, not an accounting posting.
CREATE TABLE IF NOT EXISTS dt_unallocated_payins (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           text NOT NULL DEFAULT 'tenant-default',
  alert_id            text,                     -- vendor_txn_alerts.id that triggered this
  banker_code         text,                     -- merchants.merchant_code the money landed on
  payin_merchant_code text,                     -- providers.code it resolved to, if any
  amount              numeric(18,2) NOT NULL,
  reason              text NOT NULL,            -- NO_ASSIGNED_LOT | NO_CAPACITY | UNRESOLVED_MERCHANT
  status              text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED','IGNORED')),
  resolved_by         text,
  resolved_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dt_unallocated_payins_open_idx
  ON dt_unallocated_payins (status, created_at DESC);

-- One row per alert: the ingest path is retried/replayed, and a replay must not inflate
-- the queue or double-count the population. Deliberately NOT a partial index — the insert
-- uses ON CONFLICT (alert_id), and Postgres cannot infer a partial index without repeating
-- its predicate. A plain unique index still permits many NULLs, which is what we want.
CREATE UNIQUE INDEX IF NOT EXISTS dt_unallocated_payins_alert_uidx
  ON dt_unallocated_payins (alert_id);

-- Consumed pay-ins, so "population" is answerable from the DT side alone and a replayed
-- alert cannot consume quota twice. traffic_reservations keys on order_ref, which for this
-- path is the alert id — this table records the resolved attribution alongside it.
CREATE TABLE IF NOT EXISTS dt_payin_consumption (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           text NOT NULL DEFAULT 'tenant-default',
  alert_id            text NOT NULL,
  banker_code         text,
  payin_merchant_code text NOT NULL,
  purchase_id         uuid,
  reservation_id      uuid,
  amount              numeric(18,2) NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS dt_payin_consumption_alert_uidx
  ON dt_payin_consumption (alert_id);

CREATE INDEX IF NOT EXISTS dt_payin_consumption_merchant_idx
  ON dt_payin_consumption (payin_merchant_code, created_at DESC);
