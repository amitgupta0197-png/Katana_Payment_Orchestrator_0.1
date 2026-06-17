-- checkoutservice_db: provider-side callback dedup (BRD §8 P4).
-- BRD acceptance: "Duplicate provider callback cannot create duplicate ledger entry".
--
-- Strategy: every accepted callback inserts (vendor, idempotency_key, payload_hash)
-- with UNIQUE(idempotency_key). Subsequent arrivals with the same key short-
-- circuit to the cached response without touching ledger / event_stream.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS callback_dedup (
  dedup_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor           text NOT NULL,
  idempotency_key  text NOT NULL,
    -- per BRD: provider + provider_txn_id + event_type
  payload_hash     text NOT NULL,
    -- sha256(canonical payload)
  order_id         uuid REFERENCES checkout_orders(id),
  from_status      text,
  to_status        text NOT NULL,
  response_status  integer NOT NULL,
  response_body    jsonb,
  received_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS callback_dedup_key_uniq ON callback_dedup (idempotency_key);
CREATE INDEX IF NOT EXISTS callback_dedup_vendor_idx ON callback_dedup (vendor, received_at DESC);
CREATE INDEX IF NOT EXISTS callback_dedup_order_idx ON callback_dedup (order_id, received_at DESC);
