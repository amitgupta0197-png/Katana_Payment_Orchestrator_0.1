-- An identity the merchant cannot type.
--
-- device_id is user-editable in the agent, and on 2026-08-21 two different phones were both
-- named "author 😎" — one enrolled to AVTS23, one to ASGP1. Because device_id is the primary
-- key they shared a single row, and whichever heartbeat landed last owned the banker binding.
-- All 418 capture polls that day went to ASGP1; AVTS23 was never served and its dashboard still
-- read "online · ready".
--
-- Migration 0020 detects that by watching the binding oscillate, which works but is a heuristic:
-- it cannot fire until a phone has flipped back, and it cannot tell a genuine re-enrolment from
-- a collision on the first move. install_id is the exact signal — derived from ANDROID_ID on
-- first run and never shown in the UI, so two phones can share a device_id but never an
-- install_id. Same device_id + different install_id = definitively two phones.
--
-- Deliberately NOT the primary key: renaming a phone must not re-enrol it, and existing devices
-- must keep their identity and approval. This only qualifies who is speaking.

ALTER TABLE vendor_devices ADD COLUMN IF NOT EXISTS install_id text;

-- Populated on the next heartbeat from an agent that reports it; older builds send nothing and
-- must keep working, so the column stays nullable and a NULL is never treated as a conflict.
CREATE INDEX IF NOT EXISTS vendor_devices_install_idx ON vendor_devices (install_id)
  WHERE install_id IS NOT NULL;
