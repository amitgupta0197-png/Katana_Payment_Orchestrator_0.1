-- vendorgatewayservice_db: device-reported permission/enrolment state, surfaced on
-- the merchant dashboard so an admin can see whether a merchant's forwarder device
-- has actually granted the permissions the agent needs (notification access) and is
-- online (heartbeat). Reported by the agent in its heartbeat.
ALTER TABLE vendor_devices ADD COLUMN IF NOT EXISTS notif_access  boolean;
ALTER TABLE vendor_devices ADD COLUMN IF NOT EXISTS agent_enabled boolean;
ALTER TABLE vendor_devices ADD COLUMN IF NOT EXISTS app_version   text;
