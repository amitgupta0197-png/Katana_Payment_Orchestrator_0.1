-- vendorgatewayservice_db: Transaction Intelligence — raw bank-credit alerts and
-- their reconciliation result (MTIP Modules 3–4, scoped to PoolPay pay-ins).
--
-- A company-managed device (Android agent) or a bank/SMS parser posts the parsed
-- transaction alert for a UPI credit landing in the receiver/settlement account.
-- The reconciler matches it to a PENDING pay-in (by UTR, then amount + payee VPA +
-- recency) and, on a confident unique match, auto-confirms the order SUCCESS — which
-- is what flips the customer pay page from the QR to "Payment received".
--
-- Append-only / immutable raw event store (BRD §11 audit): one row per alert, with
-- the parse inputs and the match outcome kept for forensics.
CREATE TABLE IF NOT EXISTS vendor_txn_alerts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         text NOT NULL DEFAULT 'tenant-default',
  source            text NOT NULL DEFAULT 'DEVICE',   -- DEVICE | SMS | BANK_API | SIMULATED
  device_id         text,
  bank              text,
  direction         text NOT NULL DEFAULT 'CREDIT',
  amount            numeric(18,2),
  utr               text,
  payer_vpa         text,                              -- sender (payer)
  payee_vpa         text,                              -- receiver / settlement VPA credited
  narration         text,
  raw               text,                              -- raw SMS / payload (immutable)
  event_time        timestamptz,
  -- Reconciliation result (Module 4).
  matched_order_id  uuid,
  matched_order_ref text,
  match_confidence  int NOT NULL DEFAULT 0,            -- 0-100
  outcome           text NOT NULL DEFAULT 'UNMATCHED'  -- CONFIRMED | UNMATCHED | AMBIGUOUS | DUPLICATE
                    CHECK (outcome IN ('CONFIRMED','UNMATCHED','AMBIGUOUS','DUPLICATE')),
  detail            text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vendor_txn_alerts_created_idx ON vendor_txn_alerts (created_at DESC);
CREATE INDEX IF NOT EXISTS vendor_txn_alerts_utr_idx     ON vendor_txn_alerts (utr) WHERE utr IS NOT NULL;
CREATE INDEX IF NOT EXISTS vendor_txn_alerts_outcome_idx ON vendor_txn_alerts (outcome, created_at DESC);
