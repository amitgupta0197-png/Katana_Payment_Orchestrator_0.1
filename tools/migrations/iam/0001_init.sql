-- iamservice_db: user_personas table.
-- A user can hold multiple personas (multi-persona switching is in PRODUCT_VISION §8 Q1).

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS user_personas (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL,
  persona_kind    text NOT NULL CHECK (persona_kind IN ('SUPER_ADMIN','PROVIDER','MERCHANT')),
  scope_id        text,
  scope_label     text NOT NULL DEFAULT '',
  is_primary      boolean NOT NULL DEFAULT false,
  granted_by      text,
  granted_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_personas_user_idx ON user_personas (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS user_personas_one_primary
  ON user_personas (user_id) WHERE is_primary;
