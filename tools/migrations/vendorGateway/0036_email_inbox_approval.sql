-- vendorgatewayservice_db: A LINKED MAILBOX IS NOT TRUSTED UNTIL KATANA STAFF APPROVE IT.
--
-- A mailbox is linked from the phone app, through a page that needs no login and takes the
-- merchant code from its address. Mail from a linked mailbox can mark an order paid. So
-- anyone could link a mailbox of their own to any merchant and then send themselves
-- "payment received" mail. A mailbox now starts unapproved: it is stored, nothing reads it,
-- and staff approve it once they have checked it is the merchant's own.
--
-- The mailboxes that exist today were linked before this rule and are approved here, so
-- applying this changes nothing for them. They are told apart by linked_via: every mailbox
-- linked under the rule carries one, so running this file again never approves a new one.

ALTER TABLE vendor_email_inboxes ADD COLUMN IF NOT EXISTS approved     boolean NOT NULL DEFAULT false;
ALTER TABLE vendor_email_inboxes ADD COLUMN IF NOT EXISTS approved_by  text;
ALTER TABLE vendor_email_inboxes ADD COLUMN IF NOT EXISTS approved_at  timestamptz;
ALTER TABLE vendor_email_inboxes ADD COLUMN IF NOT EXISTS linked_via   text;   -- OAUTH_LINK | DEVICE | NULL (before this rule)

UPDATE vendor_email_inboxes
   SET approved = true, approved_by = 'migration:0036 (linked before approval was required)', approved_at = now()
 WHERE approved_by IS NULL AND approved = false AND linked_via IS NULL;
