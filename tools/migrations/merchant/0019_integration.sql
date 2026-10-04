-- merchantservice_db: a banker's integration, tracked (lib/integration, lib/callback-verify).
--
-- 1. banker_callback_urls: an optional callback URL per flow (INTENT / P2P / PAYOUT). A row in
--    PENDING or VERIFIED is where that flow's callbacks go; with no row (or a FAILED one) they go
--    to merchants.webhook_url exactly as before. Set and cleared through Maker-Checker
--    (`callback.set` / `callback.clear`).
-- 2. callback_pings: every reachability check of a callback URL (a signed test event; any 2xx is
--    a pass). flow NULL = the banker's default webhook_url. Append-only.
-- 3. integration_events: the banker's integration log (keys made, callback URLs set, checks
--    passed or failed, test payments). Append-only.
--
-- Staff only. Additive and idempotent: new tables, nothing existing changes.

CREATE TABLE IF NOT EXISTS banker_callback_urls (
  merchant_id           uuid NOT NULL REFERENCES merchants(id),
  flow                  text NOT NULL CHECK (flow IN ('INTENT','P2P','PAYOUT')),
  url                   text,
  status                text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','VERIFIED','FAILED')),
  last_checked_at       timestamptz,
  last_http_status      integer,
  last_error            text,
  consecutive_failures  integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  verified_at           timestamptz,
  set_by                text,
  request_id            uuid,          -- the maker_checker_requests row (providerservice_db) that set it
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT banker_callback_urls_uk UNIQUE (merchant_id, flow),
  CONSTRAINT banker_callback_urls_url_chk CHECK (url IS NULL OR url ~* '^https?://')
);
-- The scheduled re-check picks the rows checked longest ago.
CREATE INDEX IF NOT EXISTS banker_callback_urls_checked_idx ON banker_callback_urls (last_checked_at NULLS FIRST) WHERE url IS NOT NULL;

CREATE TABLE IF NOT EXISTS callback_pings (
  id            bigserial PRIMARY KEY,
  merchant_id   uuid NOT NULL,
  flow          text CHECK (flow IS NULL OR flow IN ('INTENT','P2P','PAYOUT')),
  url           text NOT NULL,
  ok            boolean NOT NULL,
  http_status   integer,
  response_ms   integer,
  error         text,
  challenge     text,
  triggered_by  text NOT NULL CHECK (triggered_by IN ('MANUAL','SCHEDULED')),
  actor         text,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS callback_pings_merchant_idx ON callback_pings (merchant_id, flow, at DESC);
CREATE INDEX IF NOT EXISTS callback_pings_at_idx ON callback_pings (at DESC);

CREATE TABLE IF NOT EXISTS integration_events (
  id           bigserial PRIMARY KEY,
  merchant_id  uuid NOT NULL,
  event        text NOT NULL,     -- key_generated | key_rotated | callback_url_set | callback_url_cleared | callback_verified | callback_failed | test_txn_success …
  flow         text,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor        text,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS integration_events_merchant_idx ON integration_events (merchant_id, at DESC);

CREATE OR REPLACE FUNCTION integration_log_locked() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS callback_pings_locked_trg ON callback_pings;
CREATE TRIGGER callback_pings_locked_trg BEFORE UPDATE OR DELETE ON callback_pings
  FOR EACH ROW EXECUTE FUNCTION integration_log_locked();
DROP TRIGGER IF EXISTS integration_events_locked_trg ON integration_events;
CREATE TRIGGER integration_events_locked_trg BEFORE UPDATE OR DELETE ON integration_events
  FOR EACH ROW EXECUTE FUNCTION integration_log_locked();
