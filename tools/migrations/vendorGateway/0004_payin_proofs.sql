-- vendorgatewayservice_db: sender-submitted payment proofs (screenshots) for
-- PoolPay pay-in orders. A pay-in created via the S2S flow stays PENDING until the
-- money is verified in the receiver/settlement account. Verification arrives over
-- one of two channels:
--   1) the SENDER uploads a screenshot of the payment they made (this table), or
--   2) a gateway WEBHOOK confirms the credit (POST /api/vendors/poolpay/callback).
-- A sender screenshot is low-trust self-asserted evidence, so it only flips the
-- order to a PROOF_SUBMITTED review state — ops verifies and confirms it paid.
--
-- Mirrors fifo_order_proofs / merchant_kyb_documents hardening: only metadata + the
-- SHA-256 content hash live here; the file bytes are stored outside the public root.
CREATE TABLE IF NOT EXISTS vendor_payin_proofs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL DEFAULT 'tenant-default',
  order_id      uuid NOT NULL,                        -- vendor_payin_orders.id
  order_ref     text,                                 -- denormalised order reference
  kind          text NOT NULL DEFAULT 'SCREENSHOT',   -- SCREENSHOT | RECEIPT | BANK_SLIP
  utr           text,                                 -- UTR/RRN the sender typed in (optional)
  filename      text,
  content_type  text NOT NULL,
  size_bytes    bigint NOT NULL,
  sha256        text NOT NULL,                        -- evidence integrity hash
  storage_ref   text NOT NULL,                        -- on-disk path, outside public root
  review_status text NOT NULL DEFAULT 'SUBMITTED'     -- SUBMITTED | VERIFIED | REJECTED
                CHECK (review_status IN ('SUBMITTED','VERIFIED','REJECTED')),
  uploaded_by   text,                                 -- 'sender' (public page) or ops email
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vendor_payin_proofs_order_idx ON vendor_payin_proofs (order_id, created_at DESC);
