-- Agent capture counters + real app version (2026-08-05).
--
-- A phone that hears nothing and a phone that hears everything and understands none of it
-- looked identical from the server. On 2026-08-05 a real ₹250 credit was dropped by the
-- notification parser and NOTHING recorded that it had even been seen — the agent posted
-- no alert, and "no alert" is exactly what a quiet shop looks like.
--
-- The agent now reports running counters on each heartbeat:
--   seen        notifications from non-noise apps
--   parsed      successfully understood as a credit
--   dropped     LOOKED LIKE MONEY AND COULD NOT BE PARSED   <-- the number that matters
--   uploaded    forwarded to the orchestrator
--   capture_try / capture_ok / capture_fail   on-screen RRN capture attempts
--
-- seen > 0 with parsed = 0, or a climbing `dropped`, means the phone is deaf and the
-- parser needs a new format. Stored as jsonb so new counters need no migration.

ALTER TABLE vendor_devices ADD COLUMN IF NOT EXISTS counters jsonb;

COMMENT ON COLUMN vendor_devices.counters IS
  'Device-reported capture counters. counters->>''dropped'' > 0 means payments are being seen and lost.';

-- app_version used to carry PARSER_VERSION ("1.0"), so a phone running 2.37 reported 1.0
-- and sent us chasing a phantom stale build. The agent now sends its real version in
-- app_version and the parser version separately.
ALTER TABLE vendor_devices ADD COLUMN IF NOT EXISTS parser_version text;

COMMENT ON COLUMN vendor_devices.parser_version IS
  'Notification/SMS parser version, reported separately from the app version.';
