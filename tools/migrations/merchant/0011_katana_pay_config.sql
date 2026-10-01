-- merchantservice_db: merchant_payment_config.poolpay becomes katana_pay.
--
-- The column holds a banker's Katana Pay settings — the settlement UPI ID(s) a P2P order is
-- paid on, the payee name, and the per-banker override of the upstream integration. "poolpay"
-- was a name carried over from the BRD; the product is Katana Pay.
--
-- DEPLOY ORDER. Apply together with the code that reads katana_pay (build first, then apply
-- and restart at once): code from before the rename fails on the missing column.
--
-- ROLLBACK: ALTER TABLE merchant_payment_config RENAME COLUMN katana_pay TO poolpay;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'merchant_payment_config' AND column_name = 'poolpay')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'merchant_payment_config' AND column_name = 'katana_pay') THEN
    ALTER TABLE merchant_payment_config RENAME COLUMN poolpay TO katana_pay;
  END IF;
END $$;
