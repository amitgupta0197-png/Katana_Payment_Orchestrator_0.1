-- Merchant activation for the DT refill model (2026-07-31).
--
-- A merchant cannot simply start raising DT purchase requests: it asks to be activated
-- for the DT refill model, an admin approves, and only then does its DT dashboard
-- become usable. Two channel models the merchant can operate under:
--
--   PURE_INTENT  — merchant gets provider access (the intent/collect flow already live)
--   DIRECT_QUASI — merchant onboards a third-party direct QR; the Katana agent app on
--                  the collection phone tracks the RRN
--
-- One row per merchant per request. History is preserved rather than overwritten, so a
-- re-application after a rejection leaves the rejection visible for audit.

CREATE TABLE IF NOT EXISTS merchant_dt_activations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id   text NOT NULL,
  model         text NOT NULL CHECK (model IN ('PURE_INTENT','DIRECT_QUASI')),
  status        text NOT NULL DEFAULT 'REQUESTED'
                CHECK (status IN ('REQUESTED','APPROVED','REJECTED','REVOKED')),
  -- What the merchant said when asking, and what the reviewer said when deciding.
  request_note  text,
  review_note   text,
  requested_by  text,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  reviewed_by   text,
  reviewed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- "Is this merchant activated?" and "show me the queue" are the only two reads.
CREATE INDEX IF NOT EXISTS merchant_dt_activations_merchant_idx
  ON merchant_dt_activations (merchant_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS merchant_dt_activations_status_idx
  ON merchant_dt_activations (status, requested_at DESC);

-- At most ONE request in flight per merchant. Without this a merchant could spam the
-- approval queue by clicking twice, and "the pending request" would be ambiguous.
-- Partial unique index rather than a table constraint so decided rows stay unlimited.
CREATE UNIQUE INDEX IF NOT EXISTS merchant_dt_activations_one_pending
  ON merchant_dt_activations (merchant_id)
  WHERE status = 'REQUESTED';

-- Likewise at most one APPROVED row per merchant — the activation is a state, not a
-- collection. Re-approving after a revoke replaces rather than accumulates.
CREATE UNIQUE INDEX IF NOT EXISTS merchant_dt_activations_one_approved
  ON merchant_dt_activations (merchant_id)
  WHERE status = 'APPROVED';
