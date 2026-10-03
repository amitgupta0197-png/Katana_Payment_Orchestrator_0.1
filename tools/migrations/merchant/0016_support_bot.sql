-- merchantservice_db: the merchant support bot (lib/support-bot), phase 1: staff only.
--
-- A conversation is one staff member asking questions on behalf of one banker. Each row of
-- support_bot_messages is one message exactly as it was sent to or received from the model
-- (`content`), so a conversation can be continued without editing its history. Rows a person
-- reads carry `display`: the question, or the answer with what the bot looked up (`trace`).
-- Staff rate answers (`feedback`); those rows become the bot's test set.
--
-- Re-runnable. Additive only.

CREATE TABLE IF NOT EXISTS support_bot_conversations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_code  text NOT NULL,                 -- the banker the questions are about
  title          text,
  started_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_bot_conversations_merchant_idx
  ON support_bot_conversations (merchant_code, updated_at DESC);

CREATE TABLE IF NOT EXISTS support_bot_messages (
  id               bigserial PRIMARY KEY,
  conversation_id  uuid NOT NULL REFERENCES support_bot_conversations(id) ON DELETE CASCADE,
  seq              integer NOT NULL,
  role             text NOT NULL CHECK (role IN ('user', 'assistant')),
  content          jsonb NOT NULL,              -- the message as the API takes it, unedited
  display          text,                        -- the question, or the answer shown to staff
  trace            jsonb,                       -- answer rows: each lookup and what it returned
  usage            jsonb,                       -- answer rows: tokens, cost estimate, model, time
  feedback         smallint CHECK (feedback IN (-1, 1)),
  feedback_note    text,
  feedback_by      text,
  feedback_at      timestamptz,
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq)
);
CREATE INDEX IF NOT EXISTS support_bot_messages_feedback_idx
  ON support_bot_messages (feedback_at DESC) WHERE feedback IS NOT NULL;
