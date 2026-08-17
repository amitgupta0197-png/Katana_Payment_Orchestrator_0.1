-- Which UPI ID does this phone receive on?
--
-- A banker can collect on several UPI IDs (PRVZS23 has four) and several phones capture for
-- one banker code — in prod, PRVZS23 has two devices and PRIMESX four. Each phone runs its own
-- GPay for Business login, so the receiving UPI ID is a property of the PHONE, while the
-- payment itself never names it: GPay reports payer, method, amounts and its two transaction
-- ids, and nothing about the destination.
--
-- So the destination is recorded where it actually lives. An operator states, once, which of
-- the banker's configured VPAs a device receives on, and every credit that device captures
-- carries it. That is an assertion about a phone rather than a guess about a payment: one
-- phone holds one GPay account, and the agent only ever sees its own phone's notifications.
--
-- `payee_vpa_source` keeps the two kinds of knowledge apart, because they are not equally
-- strong and the UI must not present them as if they were:
--   STATED — the capture itself named the payee VPA (some email-sourced credits do).
--   DEVICE — derived from the capturing device's mapping.
--   NULL   — no VPA known; the UI shows the banker's settlement account.
-- The previous config-derived default was removed in 0018 precisely because it had no such
-- marker and was displayed as fact.

ALTER TABLE vendor_devices   ADD COLUMN IF NOT EXISTS receiving_vpa text;
ALTER TABLE vendor_txn_alerts ADD COLUMN IF NOT EXISTS payee_vpa_source text;

-- Any payee VPA already stored came from the capture itself (0018 cleared every guess), so
-- mark those STATED. Idempotent: rows with a source set are left alone.
UPDATE vendor_txn_alerts
   SET payee_vpa_source = 'STATED'
 WHERE payee_vpa IS NOT NULL AND payee_vpa <> '' AND payee_vpa_source IS NULL;

-- "Which devices still need a receiving VPA" is the question the device screen asks.
CREATE INDEX IF NOT EXISTS vendor_devices_needs_vpa_idx
  ON vendor_devices (merchant_id)
  WHERE receiving_vpa IS NULL;
