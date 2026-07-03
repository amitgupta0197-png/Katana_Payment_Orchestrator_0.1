-- fifoservice_db: FIFO Payment Operations Module (Katana BRD §15/§16).
-- Operator-driven pay-in/payout requests processed through a timestamped FIFO
-- queue with assignment, SLA, proof upload and an auditable status lifecycle.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Operators that work the queue (BRD §8). Linked to an iam user.
CREATE TABLE IF NOT EXISTS fifo_operators (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        text NOT NULL DEFAULT 'tenant-default',
  user_id          uuid,
  email            text NOT NULL UNIQUE,
  name             text,
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED','OFFLINE')),
  max_concurrent   integer NOT NULL DEFAULT 5,
  max_amount_minor bigint,                          -- per-item amount ceiling (NULL = no cap)
  roles            text[] NOT NULL DEFAULT ARRAY['PAYIN','PAYOUT'],
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- The FIFO order (merchant payment request).
CREATE TABLE IF NOT EXISTS fifo_orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        text NOT NULL DEFAULT 'tenant-default',
  order_ref        text NOT NULL UNIQUE,            -- ORD-...
  merchant_id      text NOT NULL,
  direction        text NOT NULL CHECK (direction IN ('PAYIN','PAYOUT')),
  amount_minor     bigint NOT NULL,
  currency         text NOT NULL DEFAULT 'INR',
  settlement_mode  text NOT NULL DEFAULT 'BANK' CHECK (settlement_mode IN ('BANK','USDT','WALLET','UPI')),
  customer_name    text,
  customer_phone   text,
  customer_email   text,
  purpose          text,
  beneficiary_id   uuid,
  status           text NOT NULL DEFAULT 'CREATED'
                   CHECK (status IN ('CREATED','VALIDATED','QUEUED','ASSIGNED','ACCEPTED','PROCESSING',
                                     'PROOF_UPLOADED','COMPLETED','SETTLED','REJECTED','FAILED','HOLD','DISPUTE','REFUND','CANCELLED')),
  risk_score       numeric,
  risk_decision    text,
  txn_ref          text,                            -- TXN-...
  utr              text,
  tx_hash          text,                            -- USDT settlement
  device_ip        text,
  device_fingerprint text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  validated_at     timestamptz,
  queued_at        timestamptz,
  completed_at     timestamptz
);
CREATE INDEX IF NOT EXISTS fifo_orders_merchant_idx ON fifo_orders (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS fifo_orders_status_idx   ON fifo_orders (status, created_at);

-- The queue entry + assignment lifecycle. enqueued_at is the FIFO key.
CREATE TABLE IF NOT EXISTS fifo_queue (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      text NOT NULL DEFAULT 'tenant-default',
  order_id       uuid NOT NULL REFERENCES fifo_orders(id) ON DELETE CASCADE,
  priority       integer NOT NULL DEFAULT 0,        -- higher dequeues first (priority override)
  enqueued_at    timestamptz NOT NULL DEFAULT now(),
  status         text NOT NULL DEFAULT 'QUEUED'
                 CHECK (status IN ('QUEUED','ASSIGNED','ACCEPTED','DONE','CANCELLED')),
  assigned_to    uuid,                              -- fifo_operators.id
  assigned_at    timestamptz,
  accepted_at    timestamptz,
  sla_due_at     timestamptz,                       -- accept-by deadline
  reassign_count integer NOT NULL DEFAULT 0,
  UNIQUE (order_id)
);
-- FIFO dequeue order: highest priority, then oldest enqueue time.
CREATE INDEX IF NOT EXISTS fifo_queue_dequeue_idx ON fifo_queue (status, priority DESC, enqueued_at ASC);
CREATE INDEX IF NOT EXISTS fifo_queue_operator_idx ON fifo_queue (assigned_to, status);

-- Append-only status history per order (forensic timeline).
CREATE TABLE IF NOT EXISTS fifo_order_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL,
  from_status text,
  to_status   text NOT NULL,
  actor       text,
  actor_kind  text,                                 -- system | operator | admin | merchant
  reason      text,
  payload     jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fifo_order_events_order_idx ON fifo_order_events (order_id, at);

-- Uploaded proof + evidence hash (BRD §23 evidence hashing, FR-005, SEC-007).
CREATE TABLE IF NOT EXISTS fifo_order_proofs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL,
  kind         text,                                -- screenshot | receipt | utr_ref | bank_slip
  filename     text,
  content_type text,
  size_bytes   integer,
  sha256       text NOT NULL,                       -- evidence hash
  storage_ref  text,                                -- path outside public root
  uploaded_by  text,
  uploaded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fifo_order_proofs_order_idx ON fifo_order_proofs (order_id, uploaded_at);
