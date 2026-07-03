-- vendorgatewayservice_db: OAuth ("Sign in with Google") support for the email
-- capture channel, so a merchant connects Gmail with one tap instead of an app
-- password. An inbox row is now either IMAP (app_password) or OAUTH (refresh_token).
ALTER TABLE vendor_email_inboxes ALTER COLUMN app_password DROP NOT NULL;
ALTER TABLE vendor_email_inboxes ADD COLUMN IF NOT EXISTS auth_type    text NOT NULL DEFAULT 'IMAP'; -- IMAP | OAUTH
ALTER TABLE vendor_email_inboxes ADD COLUMN IF NOT EXISTS refresh_token text;

-- Idempotency for the Gmail-API path (readonly scope can't mark mail read), so each
-- message is processed exactly once.
CREATE TABLE IF NOT EXISTS vendor_email_seen (
  email      text NOT NULL,
  message_id text NOT NULL,
  seen_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (email, message_id)
);
CREATE INDEX IF NOT EXISTS vendor_email_seen_at_idx ON vendor_email_seen (seen_at);
