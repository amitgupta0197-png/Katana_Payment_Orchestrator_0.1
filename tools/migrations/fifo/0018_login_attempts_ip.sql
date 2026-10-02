-- fifoservice_db: failed logins are also counted per address, not only per email.
--
-- The lockout (0014) counts failures for one email, which stops guessing at one account and
-- does nothing about one address trying a few passwords against many accounts. This index
-- makes the per-address count cheap. 0014 must be applied first; on a database that never
-- got it, this file creates the same tables, so applying it alone is enough.

CREATE TABLE IF NOT EXISTS fifo_login_attempts (
  id          bigserial PRIMARY KEY,
  email       text NOT NULL,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_email_time ON fifo_login_attempts (email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time    ON fifo_login_attempts (ip, created_at DESC);

CREATE TABLE IF NOT EXISTS fifo_user_security (
  email         text PRIMARY KEY,
  session_epoch integer NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
