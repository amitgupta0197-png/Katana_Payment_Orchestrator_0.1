-- notificationservice_db: TEST / LIVE MODE (see vendorGateway 0026).
--
-- Marks each queued merchant callback TEST or LIVE, so test callbacks can be filtered,
-- retried and reported separately from real ones. NOT NULL DEFAULT true: everything already
-- queued or delivered is live. Safe to apply before the code that writes it.

ALTER TABLE webhook_outbox ADD COLUMN IF NOT EXISTS livemode boolean NOT NULL DEFAULT true;
