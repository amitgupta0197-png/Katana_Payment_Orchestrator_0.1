-- vendorgatewayservice_db: ONE BANK REFERENCE SETTLES ONE LIVE ORDER — enforced by the database.
--
-- A UTR / RRN is unique across the UPI network, so one payment can never be two orders'
-- proof. confirmKatanaOrder checks for a duplicate before it writes, but the check and the
-- write are two statements: two confirmations carrying the same reference at the same moment
-- could each see no duplicate. This index closes that gap. Test orders carry generated
-- references and are left out.
--
-- If duplicates already exist the index is NOT created and the migration says so: they are a
-- finding to look at, not something to resolve by deleting rows.

DO $$
DECLARE dup int;
BEGIN
  SELECT COUNT(*) INTO dup FROM (
    SELECT rrn FROM vendor_payin_orders
     WHERE livemode AND rrn IS NOT NULL AND rrn <> '' AND status IN ('SUCCESS','SUCCEEDED')
     GROUP BY rrn HAVING COUNT(*) > 1) d;
  IF dup > 0 THEN
    RAISE WARNING 'vendor_payin_orders: % bank references settle more than one live order; unique index NOT created', dup;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS vendor_payin_orders_live_rrn_uk
      ON vendor_payin_orders (rrn)
      WHERE livemode AND rrn IS NOT NULL AND rrn <> '' AND status IN ('SUCCESS','SUCCEEDED');
  END IF;
END $$;
