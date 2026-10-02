-- notificationservice_db: WEBHOOK v2, RESEND AND TEST EVENTS on the callback outbox.
--
--   version    'v1' (every row so far) or 'v2'. Decides the headers a delivery is sent with:
--              v2 rows carry X-Katana-Event / X-Katana-Signature / X-Katana-Event-ID.
--   event_id   the v2 event's id (evt_…). Fixed when the row is queued, so every retry of the
--              row is sent with the same id and the receiver can deduplicate.
--   resend_of  the row a "Resend" was copied from. A resend is a new row with a new event_id.
--   is_test    a sample event sent from the portal. It belongs to no order, is attempted once
--              and is never retried, alerted on or counted as a callback owed.
--
-- Safe to apply before the code that writes these, and safe to run again.

ALTER TABLE webhook_outbox ADD COLUMN IF NOT EXISTS version   text NOT NULL DEFAULT 'v1';
ALTER TABLE webhook_outbox ADD COLUMN IF NOT EXISTS event_id  text;
ALTER TABLE webhook_outbox ADD COLUMN IF NOT EXISTS resend_of uuid;
ALTER TABLE webhook_outbox ADD COLUMN IF NOT EXISTS is_test   boolean NOT NULL DEFAULT false;
ALTER TABLE webhook_outbox ADD COLUMN IF NOT EXISTS requested_by text;

CREATE UNIQUE INDEX IF NOT EXISTS webhook_outbox_event_id_uk ON webhook_outbox (event_id) WHERE event_id IS NOT NULL;
