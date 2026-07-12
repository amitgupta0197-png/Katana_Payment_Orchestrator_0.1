-- vendorgatewayservice_db: record which public domain each forwarder device last
-- contacted (from the heartbeat Host header). Used to track the glhouse.shop ->
-- katanapay.co domain migration: a device whose last_host is still 'glhouse.shop' is
-- running a pre-cutover build (or a hand-typed custom URL) and must be updated before
-- glhouse.shop can be safely retired. Reported implicitly on every heartbeat.
ALTER TABLE vendor_devices ADD COLUMN IF NOT EXISTS last_host text;
