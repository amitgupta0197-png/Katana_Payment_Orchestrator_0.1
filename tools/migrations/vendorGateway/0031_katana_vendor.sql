-- vendorgatewayservice_db: KATANA IS THE NAME OF KATANA'S OWN PAY-IN.
--
-- Every Katana pay-in was stored with vendor = 'POOLPAY', a name carried over from the BRD.
-- The product is Katana Pay, so the stored identity becomes 'KATANA'. (PoolPay the upstream
-- gateway is a different thing and keeps its name where it is one: channel_id on an order it
-- took, the gateway catalog, its own callback routes.)
--
-- DEPLOY ORDER. The code that reads vendor = 'KATANA' and this migration must go live together:
-- build the new code first, then apply this and restart at once. Code from before the rename
-- finds no orders after it. The trigger below covers the other direction — an order written by
-- code from before the rename (a request in flight during the restart) is stored as KATANA.
--
-- ROLLBACK, if the old code has to be restored:
--   DROP TRIGGER IF EXISTS katana_vendor_name_trg ON vendor_payin_orders;
--   UPDATE vendor_payin_orders SET vendor = 'POOLPAY' WHERE vendor = 'KATANA';
--   UPDATE vendor_credentials  SET vendor = 'POOLPAY' WHERE vendor = 'KATANA';

CREATE OR REPLACE FUNCTION katana_vendor_name() RETURNS trigger AS $$
BEGIN
  IF NEW.vendor = 'POOLPAY' THEN NEW.vendor := 'KATANA'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS katana_vendor_name_trg ON vendor_payin_orders;
CREATE TRIGGER katana_vendor_name_trg
  BEFORE INSERT OR UPDATE OF vendor ON vendor_payin_orders
  FOR EACH ROW EXECUTE FUNCTION katana_vendor_name();

-- The flow projection (0030) fires on every update; the rename changes nothing it projects, so
-- it is switched off for this one statement rather than rewriting every flow row.
ALTER TABLE vendor_payin_orders DISABLE TRIGGER katana_flow_sync_trg;
UPDATE vendor_payin_orders SET vendor = 'KATANA' WHERE vendor = 'POOLPAY';
ALTER TABLE vendor_payin_orders ENABLE TRIGGER katana_flow_sync_trg;

-- The cockpit's credential rows for the same product. A KATANA row for the environment may
-- already exist; the old one is then simply dropped.
DELETE FROM vendor_credentials o
 WHERE o.vendor = 'POOLPAY'
   AND EXISTS (SELECT 1 FROM vendor_credentials k WHERE k.vendor = 'KATANA' AND k.env = o.env);
UPDATE vendor_credentials SET vendor = 'KATANA' WHERE vendor = 'POOLPAY';
