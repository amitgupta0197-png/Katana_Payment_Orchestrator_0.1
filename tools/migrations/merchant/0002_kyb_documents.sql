-- merchantservice_db: KYB documents uploaded during the DOCS_PENDING onboarding
-- step. Files are stored outside the public web root; only metadata + the SHA-256
-- content hash live here (same hardening as fifo_order_proofs).

CREATE TABLE IF NOT EXISTS merchant_kyb_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL DEFAULT 'tenant-default',
  merchant_id   uuid NOT NULL,
  doc_type      text NOT NULL,            -- PAN | GST | CIN | MOA | AOA | BOARD_RESOLUTION | BANK_STATEMENT | MCC_DECLARATION | OTHER
  filename      text,
  content_type  text NOT NULL,
  size_bytes    bigint NOT NULL,
  sha256        text NOT NULL,            -- content hash (forensic integrity)
  storage_ref   text NOT NULL,            -- on-disk path, outside public root
  scan_status   text NOT NULL DEFAULT 'CLEAN',
  uploaded_by   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS merchant_kyb_documents_merchant_idx
  ON merchant_kyb_documents (merchant_id, created_at DESC);
