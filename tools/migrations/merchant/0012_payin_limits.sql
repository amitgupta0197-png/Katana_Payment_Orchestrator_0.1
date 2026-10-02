-- merchantservice_db: PAY-IN LIMITS of one banker — checked when a pay-in order is created.
--
--   payin_min_amount    smallest order taken (rupees)
--   payin_max_amount    largest order taken (rupees). Also replaces the platform's UPI ceiling
--                       for this banker, so a banker cleared for a higher UPI limit is given one here.
--   payin_daily_amount  the most a banker's live orders may add up to in one day (India time)
--   payin_max_tps       the most orders it may create in one second
--
-- Amounts are RUPEES, like vendor_payin_orders.amount. NULL is "no limit of its own": the
-- platform defaults apply (lib/payin-limits). Applying this migration therefore changes
-- nothing until a limit is set.

ALTER TABLE merchant_payment_config ADD COLUMN IF NOT EXISTS payin_min_amount     numeric(18,2);
ALTER TABLE merchant_payment_config ADD COLUMN IF NOT EXISTS payin_max_amount     numeric(18,2);
ALTER TABLE merchant_payment_config ADD COLUMN IF NOT EXISTS payin_daily_amount   numeric(18,2);
ALTER TABLE merchant_payment_config ADD COLUMN IF NOT EXISTS payin_max_tps        integer;
ALTER TABLE merchant_payment_config ADD COLUMN IF NOT EXISTS payin_limits_set_by  text;
ALTER TABLE merchant_payment_config ADD COLUMN IF NOT EXISTS payin_limits_set_at  timestamptz;

DO $$ BEGIN
  ALTER TABLE merchant_payment_config ADD CONSTRAINT merchant_payment_config_payin_limits_chk
    CHECK ((payin_min_amount   IS NULL OR payin_min_amount   > 0)
       AND (payin_max_amount   IS NULL OR payin_max_amount   > 0)
       AND (payin_daily_amount IS NULL OR payin_daily_amount > 0)
       AND (payin_max_tps      IS NULL OR payin_max_tps      > 0)
       AND (payin_min_amount IS NULL OR payin_max_amount IS NULL OR payin_min_amount <= payin_max_amount));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
