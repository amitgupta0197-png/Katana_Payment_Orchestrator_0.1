-- vendorGateway 0044: PARTNERS — payment aggregators that onboard their own merchants on Katana
-- (lib/partner). A separate module: nothing here changes an existing table's behaviour.
--
--   partners                  one row per partner. A partner IS a Katana merchant (providers row,
--                             provider_id); its bankers are where the money lands and it is
--                             settled as any merchant is. `exclusive`: its bankers take partner
--                             orders only. `own_gateway`: the connector that is the partner's own
--                             company, which partner orders never use (no loop back to it).
--   partner_sub_merchants     the partner's merchants. They hold no money and have no banker;
--                             each order names one. Status, flows and limits are Katana's to enforce.
--   partner_api_keys          pk_live_… / pk_test_… keys (only the SHA-256 is kept).
--   partner_events            every change, APPEND-ONLY; sub-merchant status changes are written
--                             by a trigger, never by the application.
--   vendor_payin_orders       partner_id + partner_sub_merchant_id on a partner's order, set once.

CREATE TABLE IF NOT EXISTS partners (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id     text NOT NULL UNIQUE,
  code            text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_-]{2,20}$'),
  name            text NOT NULL,
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
  exclusive       boolean NOT NULL DEFAULT true,
  auto_approve    boolean NOT NULL DEFAULT false,
  own_gateway     text,
  webhook_url     text,
  webhook_secret  text,                -- sealed (lib/sealed-text)
  webhook_events  text NOT NULL DEFAULT 'ALL' CHECK (webhook_events IN ('ALL','PAID_ONLY')),
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS partner_sub_merchants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id      uuid NOT NULL REFERENCES partners(id),
  sub_code        text NOT NULL UNIQUE,      -- Katana's id for it: SM_…
  external_id     text NOT NULL,             -- the partner's own id for it
  legal_name      text NOT NULL,
  display_name    text,
  business_type   text,
  category        text,
  pan             text,
  gstin           text,
  email           text,
  phone           text,
  website         text,
  address         text,
  flows           text NOT NULL DEFAULT 'BOTH' CHECK (flows IN ('P2P','INTENT','BOTH')),
  min_amount      numeric(14,2) CHECK (min_amount IS NULL OR min_amount > 0),
  max_amount      numeric(14,2) CHECK (max_amount IS NULL OR max_amount > 0),
  daily_amount    numeric(14,2) CHECK (daily_amount IS NULL OR daily_amount > 0),
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','REJECTED','SUSPENDED')),
  status_reason   text,
  created_via     text NOT NULL CHECK (created_via IN ('API','PORTAL','STAFF')),
  created_by      text NOT NULL,
  updated_by      text,
  reviewed_by     text,
  reviewed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (partner_id, external_id),
  CHECK (min_amount IS NULL OR max_amount IS NULL OR min_amount <= max_amount)
);
CREATE INDEX IF NOT EXISTS partner_sub_merchants_partner_idx ON partner_sub_merchants (partner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS partner_api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id    uuid NOT NULL REFERENCES partners(id),
  label         text NOT NULL,
  prefix        text NOT NULL,
  secret_hash   text NOT NULL UNIQUE,
  livemode      boolean NOT NULL,
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  issued_by     text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX IF NOT EXISTS partner_api_keys_partner_idx ON partner_api_keys (partner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS partner_events (
  id               bigserial PRIMARY KEY,
  partner_id       uuid NOT NULL,
  sub_merchant_id  uuid,
  action           text NOT NULL,   -- CREATED, STATUS, UPDATED, PARTNER, KEY_ISSUED, KEY_REVOKED, WEBHOOK, NONE_AVAILABLE
  from_status      text,
  to_status        text,
  detail           jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor            text NOT NULL,
  at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS partner_events_partner_idx ON partner_events (partner_id, at DESC);
CREATE INDEX IF NOT EXISTS partner_events_sub_idx ON partner_events (sub_merchant_id, at DESC) WHERE sub_merchant_id IS NOT NULL;

CREATE OR REPLACE FUNCTION partner_events_locked() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'partner_events is append-only' USING ERRCODE = 'insufficient_privilege';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS partner_events_locked_trg ON partner_events;
CREATE TRIGGER partner_events_locked_trg BEFORE UPDATE OR DELETE ON partner_events
  FOR EACH ROW EXECUTE FUNCTION partner_events_locked();

-- A sub-merchant's creation and every status change, written here and nowhere else.
CREATE OR REPLACE FUNCTION partner_sub_merchant_status_log() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO partner_events (partner_id, sub_merchant_id, action, to_status, detail, actor)
    VALUES (NEW.partner_id, NEW.id, 'CREATED', NEW.status,
            jsonb_build_object('via', NEW.created_via, 'external_id', NEW.external_id, 'reason', NEW.status_reason),
            NEW.created_by);
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO partner_events (partner_id, sub_merchant_id, action, from_status, to_status, detail, actor)
    VALUES (NEW.partner_id, NEW.id, 'STATUS', OLD.status, NEW.status,
            jsonb_build_object('reason', NEW.status_reason), COALESCE(NEW.updated_by, 'system'));
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS partner_sub_merchant_status_trg ON partner_sub_merchants;
CREATE TRIGGER partner_sub_merchant_status_trg AFTER INSERT OR UPDATE OF status ON partner_sub_merchants
  FOR EACH ROW EXECUTE FUNCTION partner_sub_merchant_status_log();

-- The partner and sub-merchant of an order, set when it is created and never changed.
ALTER TABLE vendor_payin_orders ADD COLUMN IF NOT EXISTS partner_id uuid;
ALTER TABLE vendor_payin_orders ADD COLUMN IF NOT EXISTS partner_sub_merchant_id uuid;
CREATE INDEX IF NOT EXISTS vendor_payin_orders_partner_idx
  ON vendor_payin_orders (partner_id, created_at DESC) WHERE partner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS vendor_payin_orders_partner_sub_idx
  ON vendor_payin_orders (partner_sub_merchant_id, created_at DESC) WHERE partner_sub_merchant_id IS NOT NULL;

CREATE OR REPLACE FUNCTION vendor_payin_orders_partner_locked() RETURNS trigger AS $$
BEGIN
  IF (OLD.partner_id IS NOT NULL AND NEW.partner_id IS DISTINCT FROM OLD.partner_id)
     OR (OLD.partner_sub_merchant_id IS NOT NULL AND NEW.partner_sub_merchant_id IS DISTINCT FROM OLD.partner_sub_merchant_id) THEN
    RAISE EXCEPTION 'the partner of an order cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS vendor_payin_orders_partner_locked_trg ON vendor_payin_orders;
CREATE TRIGGER vendor_payin_orders_partner_locked_trg BEFORE UPDATE OF partner_id, partner_sub_merchant_id ON vendor_payin_orders
  FOR EACH ROW EXECUTE FUNCTION vendor_payin_orders_partner_locked();
