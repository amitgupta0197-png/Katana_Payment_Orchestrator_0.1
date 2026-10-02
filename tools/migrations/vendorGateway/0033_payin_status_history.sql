-- vendorgatewayservice_db: PAY-IN STATUS HISTORY — every status a pay-in order has had.
--
-- Until now an order's status lived only on its row: what it was before, who changed it and
-- when was kept (at best) inside `meta`, and written over by the next change. This table keeps
-- one row per status change, from the order's creation onward.
--
-- Maintained by a trigger on vendor_payin_orders, not by application code, for the same reason
-- as the flow tables (0030): the status is written from many code paths (confirmation, gateway
-- results, the expiry sweep, operator actions) and a trigger records every one of them. The
-- trigger NEVER fails the order write.
--
-- APPEND-ONLY. A second trigger refuses UPDATE and DELETE, and there is no foreign key to the
-- order, so the history outlives an order that is removed.

CREATE TABLE IF NOT EXISTS vendor_payin_status_history (
  id           bigserial PRIMARY KEY,
  order_id     uuid NOT NULL,          -- vendor_payin_orders.id
  order_ref    text,                   -- the merchant's reference (order_id on the order)
  merchant_id  text,
  livemode     boolean,
  from_status  text,                   -- NULL on the row written when the order is created
  to_status    text NOT NULL,
  actor        text,                   -- who or what made the change, when the order records it
  evidence     text,                   -- how a confirmation was evidenced (DEVICE, WEBHOOK, MANUAL …)
  request_id   text,                   -- the request id the order was created under
  changed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vendor_payin_status_history_order_idx    ON vendor_payin_status_history (order_id, changed_at);
CREATE INDEX IF NOT EXISTS vendor_payin_status_history_merchant_idx ON vendor_payin_status_history (merchant_id, changed_at DESC);

CREATE OR REPLACE FUNCTION vendor_payin_status_log() RETURNS trigger AS $$
DECLARE
  c        jsonb := COALESCE(NEW.meta->'confirmation', '{}'::jsonb);
  -- The confirmation block describes THIS change only when this write set it.
  confirmed boolean := TG_OP = 'UPDATE' AND (NEW.meta->'confirmation') IS DISTINCT FROM (OLD.meta->'confirmation');
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NULL; END IF;
  BEGIN
    INSERT INTO vendor_payin_status_history
      (order_id, order_ref, merchant_id, livemode, from_status, to_status, actor, evidence, request_id)
    VALUES
      (NEW.id, NEW.order_id, NEW.merchant_id, NEW.livemode,
       CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status,
       CASE WHEN TG_OP = 'INSERT' THEN 'order:create' WHEN confirmed THEN c->>'by' ELSE 'system' END,
       CASE WHEN confirmed THEN c->>'evidence' END,
       NEW.meta->>'request_id');
  EXCEPTION WHEN OTHERS THEN
    -- The order is the record of the payment; its history is a record about it. A history row
    -- that cannot be written must never lose the order.
    RAISE WARNING 'vendor_payin_status_log: order % not logged: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vendor_payin_status_log_trg ON vendor_payin_orders;
CREATE TRIGGER vendor_payin_status_log_trg
  AFTER INSERT OR UPDATE ON vendor_payin_orders
  FOR EACH ROW EXECUTE FUNCTION vendor_payin_status_log();

CREATE OR REPLACE FUNCTION vendor_payin_status_history_locked() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'vendor_payin_status_history is append-only';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vendor_payin_status_history_locked_trg ON vendor_payin_status_history;
CREATE TRIGGER vendor_payin_status_history_locked_trg
  BEFORE UPDATE OR DELETE ON vendor_payin_status_history
  FOR EACH ROW EXECUTE FUNCTION vendor_payin_status_history_locked();

-- Orders that exist already get one row: the status they are in now. What they were before is
-- not known, and is not invented.
INSERT INTO vendor_payin_status_history (order_id, order_ref, merchant_id, livemode, from_status, to_status, actor, changed_at)
SELECT o.id, o.order_id, o.merchant_id, o.livemode, NULL, o.status, 'history:start', o.updated_at
  FROM vendor_payin_orders o
 WHERE NOT EXISTS (SELECT 1 FROM vendor_payin_status_history h WHERE h.order_id = o.id);
