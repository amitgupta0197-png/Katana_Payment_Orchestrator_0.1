-- merchantservice_db: when the support bot answers in a Telegram group (lib/support-bot/telegram).
--
-- COMMAND_ONLY (the default, cheapest): only messages starting with /ask (or "/ "), /ask sent as
-- a reply to a message, and replies to the bot's own answers. Everything else costs nothing.
-- EVERY_QUESTION: every message that looks like a question, through a cheap first check.
--
-- Additive; every group, including the ones linked before, starts on COMMAND_ONLY.

ALTER TABLE support_bot_tg_groups ADD COLUMN IF NOT EXISTS answer_mode text NOT NULL DEFAULT 'COMMAND_ONLY';
DO $$ BEGIN
  ALTER TABLE support_bot_tg_groups ADD CONSTRAINT support_bot_tg_groups_answer_mode_chk
    CHECK (answer_mode IN ('COMMAND_ONLY', 'EVERY_QUESTION'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
