-- Is this capture phone's accessibility service actually switched on?
--
-- The RRN engines ARE the accessibility service — handlePaytm, handleAirtel, handleGpay and
-- handlePhonePe are all branches of RrnAccessibilityService.onAccessibilityEvent. Without the
-- grant the phone still forwards notification credits, so it keeps heartbeating and keeps
-- looking healthy, but it can never read an RRN off a screen again.
--
-- And it is revoked ROUTINELY, without anybody choosing it: OxygenOS and ColorOS clear the
-- Accessibility grant whenever the app's versionCode changes. Confirmed 2026-09-06 on the
-- OnePlus 8 — installing v3.06 over v3.05 emptied enabled_accessibility_services, while a
-- same-versionCode reinstall left it alone. So EVERY agent release silently switches capture
-- off on every phone that takes it, until a human re-enables it by hand. adb cannot put it
-- back (ColorOS denies WRITE_SECURE_SETTINGS); only a person tapping Settings can.
--
-- Until now the server could not see any of it. The heartbeat reported notif_access,
-- auto_capture, keep_awake and overlay_ok — every permission EXCEPT the one the RRN engines
-- depend on — so a post-update phone read "online · ready" while capturing nothing, and the
-- only downstream signal was the capture-health cron noticing stalled RRNs hours later, after
-- the money had already been missed.
--
-- NULL is not false. Agents older than v3.08 do not send the field, and a phone we cannot ask
-- about must never be drawn as broken — same rule as keep_awake/overlay_ok in 0021.

ALTER TABLE vendor_devices ADD COLUMN IF NOT EXISTS access_ok boolean;

-- "Which capture phones lost the grant" is the question ops asks after every release, so the
-- index covers only the not-granted state; the healthy majority costs nothing to leave out.
-- IS NOT TRUE deliberately includes NULL here: on the day of a rollout the phones that have
-- gone quiet and the phones too old to answer are the same worklist.
CREATE INDEX IF NOT EXISTS vendor_devices_access_off_idx
  ON vendor_devices (merchant_id)
  WHERE access_ok IS NOT TRUE;
