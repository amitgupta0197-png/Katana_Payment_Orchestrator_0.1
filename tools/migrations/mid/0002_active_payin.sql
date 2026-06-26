-- midservice_db: mark one sub-MID per merchant as the active pay-in target.
-- New pay-in orders for the merchant are stamped with the active sub-MID's code
-- so we can attribute payin volume per sub-MID.
ALTER TABLE sub_mids ADD COLUMN IF NOT EXISTS active_payin boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS sub_mids_one_active_per_merchant
  ON sub_mids (merchant_id) WHERE active_payin;
