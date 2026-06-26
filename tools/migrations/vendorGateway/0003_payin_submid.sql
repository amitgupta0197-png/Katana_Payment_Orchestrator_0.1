-- vendorgatewayservice_db: attribute each pay-in to the sub-MID that routed it,
-- so we can report which sub-MID created how much payin.
ALTER TABLE vendor_payin_orders ADD COLUMN IF NOT EXISTS sub_mid_code text;
CREATE INDEX IF NOT EXISTS vendor_payin_orders_submid_idx
  ON vendor_payin_orders (sub_mid_code, created_at DESC);
