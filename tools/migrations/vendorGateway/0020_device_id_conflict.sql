-- Two phones, one device_id — the failure that hid a banker for a day.
--
-- `device_id` is user-editable in the agent (Prefs.deviceId: generated from ANDROID_ID on
-- first run, then overridable in the UI). On 2026-08-19 two different phones were both set
-- to "author 😎": one enrolled to AVTS23, one to ASGP1. Since device_id is the primary key
-- they share ONE row, and the heartbeat's `merchant_id = COALESCE($2, …)` means whichever
-- phone checked in last owned the binding.
--
-- The result was silent. On 2026-08-20 all 418 capture polls from that id asked for ASGP1,
-- so AVTS23's capture queue was never read: two "Get RRN" requests raised from the dashboard
-- expired undelivered, and AVTS23's card still showed the device "online · ready" — because
-- it WAS online, just working for someone else. Nothing anywhere said so.
--
-- Re-pointing a phone from one banker to another is a legitimate operation (the same OnePlus
-- was deliberately moved from PRVZS23 to AVTS23 on 2026-08-19), so the binding is still
-- allowed to move. What is NOT legitimate is a binding that moves BACK: one phone changes
-- banker once and stays; only two phones sharing an id make it oscillate. That oscillation is
-- what these columns record, and it is the signal the heartbeat raises an alert on.
--
--   prev_merchant_id   — the banker code this device reported BEFORE the current one.
--   merchant_changed_at — when that change happened, so a rapid re-point is distinguishable
--                         from a phone that was moved months ago.

ALTER TABLE vendor_devices ADD COLUMN IF NOT EXISTS prev_merchant_id text;
ALTER TABLE vendor_devices ADD COLUMN IF NOT EXISTS merchant_changed_at timestamptz;

-- "Which device ids are being fought over" is the question the device screen asks, and it is
-- asked on every heartbeat — so it must not be a sequential scan of the whole fleet.
CREATE INDEX IF NOT EXISTS vendor_devices_contested_idx
  ON vendor_devices (merchant_changed_at DESC)
  WHERE prev_merchant_id IS NOT NULL;
