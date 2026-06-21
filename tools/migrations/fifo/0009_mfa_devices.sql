-- fifoservice_db: MFA enrolment + device binding (BRD SEC-003, SEC-004). Kept in
-- the FIFO DB so the platform auth schema is untouched; keyed by user email.

CREATE TABLE IF NOT EXISTS fifo_user_mfa (
  email        text PRIMARY KEY,
  user_id      text,
  totp_secret  text NOT NULL,
  enabled      boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  verified_at  timestamptz
);

CREATE TABLE IF NOT EXISTS fifo_user_devices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text NOT NULL,
  device_hash  text NOT NULL,
  label        text,
  trusted      boolean NOT NULL DEFAULT true,
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email, device_hash)
);
CREATE INDEX IF NOT EXISTS fifo_user_devices_email_idx ON fifo_user_devices (email, last_seen DESC);
