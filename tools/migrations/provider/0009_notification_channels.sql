-- External settlement notification channels (BRD §7). Per provider (upline): where to
-- push settlement status changes beyond the dashboard. WEBHOOK is live (signed POST);
-- EMAIL rows can be stored but only fire once SMTP is configured.

CREATE TABLE IF NOT EXISTS provider_notification_channels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('WEBHOOK','EMAIL')),
  target      text NOT NULL,                 -- URL for WEBHOOK, address for EMAIL
  enabled     boolean NOT NULL DEFAULT true,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, kind, target)
);
CREATE INDEX IF NOT EXISTS idx_pnc_provider ON provider_notification_channels (provider_id) WHERE enabled;
