-- merchantservice_db: the support bot in merchants' Telegram groups (lib/support-bot/telegram).
--
-- A Telegram group is linked to one scope (lib/support-bot/scope: `merchant:<provider id>` or
-- `banker:<code>`) with a one-time code staff make on /support-bot; the bot then answers the
-- group's questions about that scope only, in a TELEGRAM conversation (one per group per India
-- day, so the model keeps the day's context). Katana staff's own Telegram users are listed so
-- the bot never answers them. Every message the bot considered and every answer or escalation
-- it made is kept, for review.
--
-- Re-runnable. Additive only.

DO $$ BEGIN
  ALTER TABLE support_bot_conversations DROP CONSTRAINT IF EXISTS support_bot_conversations_channel_chk;
  ALTER TABLE support_bot_conversations ADD CONSTRAINT support_bot_conversations_channel_chk
    CHECK (channel IN ('STAFF', 'PORTAL', 'TELEGRAM'));
END $$;

-- One row per Telegram group the bot is in. scope_key NULL: not linked yet.
CREATE TABLE IF NOT EXISTS support_bot_tg_groups (
  chat_id            bigint PRIMARY KEY,
  title              text,
  username           text,                       -- a public group's @name, for message links
  scope_key          text,
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED')),
  linked_by          text,
  linked_at          timestamptz,
  unlinked_notice_at timestamptz,                -- when it was told it isn't set up (once)
  conversation_id    uuid REFERENCES support_bot_conversations(id) ON DELETE SET NULL,
  conversation_day   date,                       -- India date of conversation_id
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_bot_tg_groups_scope_idx ON support_bot_tg_groups (scope_key);

-- One-time codes staff make to link a group: `/link CODE` in the group.
CREATE TABLE IF NOT EXISTS support_bot_tg_link_codes (
  code        text PRIMARY KEY,
  scope_key   text NOT NULL,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  used_chat   bigint
);

-- Katana staff on Telegram: the bot never answers them. (TELEGRAM_SUPPORT_STAFF_IDS adds more.)
CREATE TABLE IF NOT EXISTS support_bot_tg_staff (
  user_id    bigint PRIMARY KEY,
  name       text,
  added_by   text NOT NULL,
  added_at   timestamptz NOT NULL DEFAULT now()
);

-- Telegram's update ids already taken in: a retried delivery is not answered twice.
CREATE TABLE IF NOT EXISTS support_bot_tg_updates (
  update_id   bigint PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- Messages the bot is to answer. Several in a burst are answered once, together: the newest
-- one's handler claims them all (handled_at).
CREATE TABLE IF NOT EXISTS support_bot_tg_inbox (
  id           bigserial PRIMARY KEY,
  chat_id      bigint NOT NULL,
  message_id   bigint NOT NULL,
  user_id      bigint,
  user_name    text,
  text         text,
  photo_file   text,                             -- Telegram file_id of the largest photo
  received_at  timestamptz NOT NULL DEFAULT now(),
  handled_at   timestamptz,
  UNIQUE (chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS support_bot_tg_inbox_open_idx ON support_bot_tg_inbox (chat_id, id) WHERE handled_at IS NULL;

-- What the bot did with each question: ANSWERED, ESCALATED, SILENT (nothing to say), LIMIT.
CREATE TABLE IF NOT EXISTS support_bot_tg_answers (
  id               bigserial PRIMARY KEY,
  chat_id          bigint NOT NULL,
  message_id       bigint,
  scope_key        text,
  outcome          text NOT NULL CHECK (outcome IN ('ANSWERED', 'ESCALATED', 'SILENT', 'LIMIT', 'ERROR')),
  reason           text,
  question         text,
  reply            text,
  conversation_id  uuid,
  model            text,
  cost_usd         numeric(10, 5),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_bot_tg_answers_chat_idx ON support_bot_tg_answers (chat_id, created_at DESC);

-- Switches staff set on /support-bot (`paused_all`).
CREATE TABLE IF NOT EXISTS support_bot_tg_settings (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
