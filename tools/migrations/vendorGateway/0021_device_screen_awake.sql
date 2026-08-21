-- Can this capture phone's screen go dark?
--
-- On-screen RRN capture cannot work without a live display: takeScreenshot() returns nothing,
-- dispatchGesture() has no screen to tap, and the clipboard reader can never take foreground
-- focus. So a phone whose display sleeps captures NOTHING — it does not degrade, it stops.
--
-- Until 2026-08-21 this was invisible from the server. The agent's keep-awake overlay defaulted
-- to off, which meant capture silently depended on the USB cable: plugged in, Android's "stay
-- awake while charging" held the display on and everything worked; unplugged, the screen timed
-- out and every capture failed — while the device card still read "online · ready", because
-- heartbeat, notification access and auto-capture were all genuinely fine.
--
-- Two columns, because either one alone is a false negative:
--   keep_awake  — the merchant asked for the screen to stay on (Prefs.keepAwake).
--   overlay_ok  — "Display over other apps" is granted, so the FLAG_KEEP_SCREEN_ON overlay
--                 that implements it can actually be shown. Without it keep_awake is a wish.
--
-- Both true = the phone will stay awake on its own. Anything else = capture depends on the
-- phone being poked or plugged in, which is what the dashboard now says out loud.

ALTER TABLE vendor_devices ADD COLUMN IF NOT EXISTS keep_awake boolean;
ALTER TABLE vendor_devices ADD COLUMN IF NOT EXISTS overlay_ok boolean;
-- Whether the phone was on a charger at the last heartbeat. The overlay is only held while
-- charging (holding a screen on all day flattens a battery in hours), so an unplugged phone
-- with keep-awake enabled is still going to sleep — a different message to the merchant than
-- "you never turned it on", and only this column can tell the two apart.
ALTER TABLE vendor_devices ADD COLUMN IF NOT EXISTS charging boolean;

-- "Which capture phones can fall asleep" is the question the device screen asks. Deliberately
-- indexes the not-safe state only: the healthy majority costs nothing to keep out of the index.
CREATE INDEX IF NOT EXISTS vendor_devices_may_sleep_idx
  ON vendor_devices (merchant_id)
  WHERE keep_awake IS NOT TRUE OR overlay_ok IS NOT TRUE;
