-- vendorgatewayservice_db: per-merchant email inboxes for the EMAIL capture channel.
-- The Katana agent app lets a merchant connect the Gmail that receives Paytm/PhonePe
-- payment emails (Gmail address + App Password). The server's email poller
-- (lib/email-ingest, cron /api/v1/cron/email-poll) reads each enabled inbox over IMAP
-- and feeds payment-received emails into the reconciler. One inbox → one merchant.
--
-- NOTE: app_password is a Google App Password (not the login password). It is stored
-- to allow server-side IMAP polling; treat this table as secret (same posture as
-- .env.local). Encryption-at-rest is a recommended follow-up.
CREATE TABLE IF NOT EXISTS vendor_email_inboxes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      text NOT NULL DEFAULT 'tenant-default',
  merchant_id    text,
  email          text NOT NULL,
  app_password   text NOT NULL,
  host           text NOT NULL DEFAULT 'imap.gmail.com',
  port           int  NOT NULL DEFAULT 993,
  enabled        boolean NOT NULL DEFAULT true,
  status         text,                 -- OK | ERROR: <msg> (last poll/connect result)
  last_polled_at timestamptz,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email)
);
CREATE INDEX IF NOT EXISTS vendor_email_inboxes_enabled_idx ON vendor_email_inboxes (enabled);
CREATE INDEX IF NOT EXISTS vendor_email_inboxes_merchant_idx ON vendor_email_inboxes (merchant_id);
