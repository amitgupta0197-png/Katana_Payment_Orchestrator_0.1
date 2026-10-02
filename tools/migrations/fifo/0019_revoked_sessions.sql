-- fifoservice_db: a session ended by its own logout.
--
-- A session is a signed cookie, valid until it expires. The per-user epoch (0014 / 0018) ends
-- every session a user has; this ends one. Logout writes the session's id here, and a cookie
-- carrying that id is refused from then on, so a copy of the cookie taken before the logout
-- is worth nothing. A row is only needed until the cookie would have expired anyway.

CREATE TABLE IF NOT EXISTS fifo_revoked_sessions (
  sid         text PRIMARY KEY,
  email       text NOT NULL,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_revoked_sessions_expires ON fifo_revoked_sessions (expires_at);
