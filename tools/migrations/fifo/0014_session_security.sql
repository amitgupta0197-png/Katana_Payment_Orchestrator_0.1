-- Session security: login rate-limiting (audit M4) and server-side session
-- revocation (audit M6). Additive; safe to run on a live DB.

-- Failed-login attempts, used to lock an account after too many failures in a window.
CREATE TABLE IF NOT EXISTS fifo_login_attempts (
  id          bigserial PRIMARY KEY,
  email       text NOT NULL,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_email_time
  ON fifo_login_attempts (email, created_at DESC);

-- Per-user session epoch. A signed session carries the epoch it was issued under;
-- bumping the epoch (on password change or an explicit "log out everywhere") makes
-- every previously-issued session fail validation. Stateless cookies become revocable.
CREATE TABLE IF NOT EXISTS fifo_user_security (
  email         text PRIMARY KEY,
  session_epoch integer NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
