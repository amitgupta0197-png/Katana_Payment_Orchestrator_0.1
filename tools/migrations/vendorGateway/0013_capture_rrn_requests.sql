-- On-demand RRN capture requests. The provider dashboard raises one against a
-- "no RRN" credit (vendor_txn_alerts row); the agent polls, prompts/executes the
-- Paytm Copy tap, and the request auto-closes when the 12-digit RRN lands on the
-- alert. Idempotent.
CREATE TABLE IF NOT EXISTS vendor_capture_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id     uuid NOT NULL,
  merchant_id  text,
  device_id    text,
  amount       numeric(18,2),
  payer_vpa    text,
  status       text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','DONE','EXPIRED')),
  requested_by text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz,
  fulfilled_at timestamptz
);

-- Agent poll: open requests for a merchant, newest first.
CREATE INDEX IF NOT EXISTS vendor_capture_requests_poll_idx
  ON vendor_capture_requests (merchant_id, status, created_at DESC);

-- At most one OPEN request per payment — a second button press is a no-op, not a dup.
CREATE UNIQUE INDEX IF NOT EXISTS vendor_capture_requests_open_uq
  ON vendor_capture_requests (alert_id) WHERE status IN ('PENDING','SENT');
