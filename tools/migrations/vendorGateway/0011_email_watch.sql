-- vendorgatewayservice_db: Gmail push (Cloud Pub/Sub "watch") support — Google
-- notifies us the instant a payment email arrives, instead of us polling. Tracks when
-- the current watch expires (Gmail caps it at 7 days, so we renew on a schedule).
ALTER TABLE vendor_email_inboxes ADD COLUMN IF NOT EXISTS watch_expiration timestamptz;
