-- fifoservice_db: richer device/forensic capture (BRD §23). device_ip and
-- device_fingerprint already exist (0001); add user agent + geolocation approx.

ALTER TABLE fifo_orders ADD COLUMN IF NOT EXISTS device_user_agent text;
ALTER TABLE fifo_orders ADD COLUMN IF NOT EXISTS device_geo        text;   -- approx country/region from edge headers
