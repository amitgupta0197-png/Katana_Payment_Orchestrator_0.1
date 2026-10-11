-- merchantservice_db: WHICH APP A SCAN-AND-PAY BANKER'S QR BELONGS TO.
--
-- A P2P banker on "scan and pay" (lib/p2p-method UPI_ID / BHARATPE) is paid on a static QR from
-- one payment app, which its capture phone reads (lib/p2p-method P2P_APPS):
--
--   merchants.p2p_app  NULL      not recorded (every banker from before; nothing changes)
--                      BHARATPE  BharatPe for Business
--                      GPAY      Google Pay for Business
--                      PHONEPE   PhonePe for Business
--                      PAYTM     Paytm for Business
--                      OTHER     another static QR (bank QR, Airtel, Pine Labs, …)
--
-- Recorded by the banker onboarding wizard and the "Pays UPI ID" tab; history in
-- merchant_p2p_method_history (note) like the method itself.

ALTER TABLE merchants ADD COLUMN IF NOT EXISTS p2p_app text;

DO $$ BEGIN
  ALTER TABLE merchants ADD CONSTRAINT merchants_p2p_app_ck
    CHECK (p2p_app IS NULL OR p2p_app IN ('BHARATPE', 'GPAY', 'PHONEPE', 'PAYTM', 'OTHER'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
