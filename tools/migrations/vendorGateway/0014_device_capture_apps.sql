-- Persist the payment-app capture engines a phone actually has selected (2026-08-05).
--
-- The agent already sends `capture_apps` on every heartbeat — "which payment-app capture
-- engines this phone runs (merchant-selected)" — but the heartbeat route dropped it on the
-- floor. That made the most important RRN diagnostic invisible: on-screen RRN capture is
-- PAUSED when no payment app is selected, so a phone can look perfectly healthy (TRUSTED,
-- notification access granted, heartbeating, polling for capture requests) while being
-- structurally incapable of ever returning an RRN.
--
-- Storing it lets the device card say "no payment app selected" instead of leaving the
-- operator to guess why capture requests expire unfulfilled.

ALTER TABLE vendor_devices ADD COLUMN IF NOT EXISTS capture_apps text;

COMMENT ON COLUMN vendor_devices.capture_apps IS
  'Comma-separated payment apps the agent has capture engines enabled for (device-reported). Empty/NULL = on-screen RRN capture is paused.';

-- Whether hands-free (auto) capture is armed on the device. The on-demand "Get RRN" path
-- is a no-op without it — CommandPoller only re-sweeps when auto-capture is on — so a phone
-- with this false will accept capture requests and never answer them.
ALTER TABLE vendor_devices ADD COLUMN IF NOT EXISTS auto_capture boolean;

COMMENT ON COLUMN vendor_devices.auto_capture IS
  'Device-reported: hands-free RRN capture armed. False/NULL = "Get RRN" requests will expire unanswered.';
