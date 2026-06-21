-- fifoservice_db: merchant status callback URL (BRD §19, AC-006). On final status
-- the module POSTs a signed (HMAC-SHA256) payload to this URL.

ALTER TABLE fifo_orders ADD COLUMN IF NOT EXISTS callback_url text;
