-- fifoservice_db: Status Intelligence Engine (BRD Layer 2) + Smart Matching Engine
-- (BRD Layer 3). The recon engine (§21 / migration 0007) classifies *completed*
-- orders into mismatch buckets after the fact. This adds the missing piece: a
-- universal, multi-source status engine that ingests signals from every channel
-- (gateway/webhook/bank/statement/SMS/email/UTR-API/NPCI/settlement/pool/trader),
-- matches each to an order with a confidence score, and resolves one canonical
-- transaction status (Initiated → Processing → Pending → Success / Failed /
-- Reversed / Chargeback / Duplicate / Mismatch / Under Review / Settled).

-- Raw status signal as reported by ONE source about ONE transaction. Append-only:
-- many signals accrue per order over its life; the resolver collapses them.
CREATE TABLE IF NOT EXISTS fifo_status_signals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid,                              -- NULL until smart-matching attaches it
  order_ref       text,                              -- denormalised for fast lookup / display
  source          text NOT NULL CHECK (source IN (
                    'GATEWAY_API','GATEWAY_WEBHOOK','BANK_API','BANK_STATEMENT',
                    'EMAIL_PARSER','SMS_PARSER','TRADER_UPLOAD','UTR_VERIFICATION',
                    'NPCI_REPORT','SETTLEMENT_REPORT','POOL_MONITOR')),
  reported_status text NOT NULL CHECK (reported_status IN (
                    'INITIATED','PROCESSING','PENDING','SUCCESS','FAILED',
                    'REVERSED','CHARGEBACK','SETTLED','DUPLICATE')),
  -- Matching inputs the source carried (any subset; richer = higher confidence).
  utr             text,
  rrn             text,
  amount_minor    bigint,
  customer_vpa    text,
  customer_name   text,
  narration       text,
  pool_account    text,
  signal_time     timestamptz NOT NULL DEFAULT now(),
  -- Smart-matching result (Layer 3).
  confidence      numeric NOT NULL DEFAULT 0,        -- 0-100
  match_method    text NOT NULL DEFAULT 'UNMATCHED'  -- UTR_RRN | AMOUNT_TIME | VPA_NAME | NARRATION_POOL | MANUAL | UNMATCHED
                  CHECK (match_method IN ('UTR_RRN','AMOUNT_TIME','VPA_NAME','NARRATION_POOL','MANUAL','UNMATCHED')),
  review_status   text NOT NULL DEFAULT 'AUTO'       -- AUTO (>=75 auto-attached) | NEEDS_REVIEW (<75) | RESOLVED (manual)
                  CHECK (review_status IN ('AUTO','NEEDS_REVIEW','RESOLVED')),
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,-- raw source payload for forensics
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fifo_status_signals_order_idx  ON fifo_status_signals (order_id, signal_time DESC);
CREATE INDEX IF NOT EXISTS fifo_status_signals_ref_idx    ON fifo_status_signals (order_ref);
CREATE INDEX IF NOT EXISTS fifo_status_signals_utr_idx    ON fifo_status_signals (utr) WHERE utr IS NOT NULL;
-- Manual-review work queue: low-confidence / unmatched signals.
CREATE INDEX IF NOT EXISTS fifo_status_signals_review_idx ON fifo_status_signals (review_status, created_at DESC)
                  WHERE review_status = 'NEEDS_REVIEW';

-- Resolved canonical status per order (one row, upserted by the resolver). This is
-- the authoritative "what is the real status" the merchant dashboard reads.
CREATE TABLE IF NOT EXISTS fifo_txn_status (
  order_id         uuid PRIMARY KEY,
  order_ref        text NOT NULL,
  merchant_id      text,
  canonical_status text NOT NULL CHECK (canonical_status IN (
                     'INITIATED','PROCESSING','PENDING','SUCCESS','FAILED',
                     'REVERSED','CHARGEBACK','DUPLICATE','MISMATCH','UNDER_REVIEW','SETTLED')),
  confidence       numeric NOT NULL DEFAULT 0,
  resolved_from    text,                             -- winning source
  signal_count     int NOT NULL DEFAULT 0,
  reason           text,                             -- human-readable why
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fifo_txn_status_canonical_idx ON fifo_txn_status (canonical_status, updated_at DESC);
CREATE INDEX IF NOT EXISTS fifo_txn_status_merchant_idx  ON fifo_txn_status (merchant_id);
