-- merchantservice_db: the support bot in the merchant and banker portals, with screenshots
-- (lib/support-bot).
--
-- A conversation now belongs to a scope, not only to one banker:
--   scope_key  'banker:<merchant_code>'  one banker (a banker login, or staff testing one)
--              'merchant:<provider id>'  a merchant and every banker under it
--   channel    'STAFF' (a staff test) or 'PORTAL' (asked by the merchant or banker itself).
-- A portal user sees only PORTAL conversations of its own scope. The bankers a conversation can
-- read are resolved from the scope on every question, never stored, so a banker removed from a
-- merchant drops out of its conversations at once.
--
-- Screenshots a person attaches are kept in support_bot_attachments; the stored message carries
-- a reference to the row in place of the image bytes, and is filled back in when the
-- conversation is continued.
--
-- Re-runnable. Additive only.

ALTER TABLE support_bot_conversations ALTER COLUMN merchant_code DROP NOT NULL;
ALTER TABLE support_bot_conversations ADD COLUMN IF NOT EXISTS scope_key text;
ALTER TABLE support_bot_conversations ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'STAFF';
UPDATE support_bot_conversations SET scope_key = 'banker:' || merchant_code WHERE scope_key IS NULL AND merchant_code IS NOT NULL;
DO $$ BEGIN
  ALTER TABLE support_bot_conversations ADD CONSTRAINT support_bot_conversations_channel_chk CHECK (channel IN ('STAFF', 'PORTAL'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS support_bot_conversations_scope_idx
  ON support_bot_conversations (scope_key, channel, updated_at DESC);

ALTER TABLE support_bot_messages ADD COLUMN IF NOT EXISTS attachments uuid[];

CREATE TABLE IF NOT EXISTS support_bot_attachments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES support_bot_conversations(id) ON DELETE CASCADE,
  media_type       text NOT NULL CHECK (media_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif')),
  bytes            integer NOT NULL,
  data             bytea NOT NULL,
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_bot_attachments_conversation_idx ON support_bot_attachments (conversation_id);
