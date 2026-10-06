-- vendorgatewayservice_db: "Unmatched payments" (lib/unmatched). Money a banker's phone captured
-- that no order took (vendor_txn_alerts UNMATCHED / AMBIGUOUS) gets one review row when a person
-- acts on it:
--   LINK      "this payment is for order X". From a merchant or banker login it waits for staff
--             (PENDING); staff approving it links the payment through lib/credit-link-store
--             (confirmKatanaOrder, the one confirmation path). A staff link is DONE at once.
--   NOT_ORDER "not an order payment": the money stays as it is and leaves the queue.
-- vendor_txn_alerts.outcome is not changed by a review; only a link confirms anything.
--
-- Re-runnable. Additive only.

CREATE TABLE IF NOT EXISTS unmatched_credit_reviews (
  alert_id      uuid PRIMARY KEY,
  merchant_id   text NOT NULL,
  decision      text NOT NULL CHECK (decision IN ('LINK', 'NOT_ORDER')),
  order_id      uuid,
  order_ref     text,
  status        text NOT NULL CHECK (status IN ('PENDING', 'DONE', 'REJECTED')),
  note          text,
  requested_by  text NOT NULL,
  requested_as  text NOT NULL,
  decided_by    text,
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS unmatched_credit_reviews_merchant_idx ON unmatched_credit_reviews (merchant_id, status);
