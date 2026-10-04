-- vendorgatewayservice_db: CHANNEL ACCOUNTING — the channel of a pay-in is locked, and banker-side
-- chargebacks are matched, ruled on and debited inside that channel.
--
-- 1. CHANNEL LOCK. channel_type is the FINAL channel and accounting uses it (0029). It is written
--    when the order is created; nothing may change it afterwards, so a status update, a gateway
--    result or a settlement import can never move a pay-in to the other rail. The one change
--    allowed is resolving a legacy UNCLASSIFIED row. requested_channel is locked the same way.
--
-- 2. CHARGEBACKS. A chargeback reported by the bank, acquirer or gateway is a financial event
--    against the original pay-in, never a loose adjustment:
--
--      payin_chargebacks          the banker event, the pay-in it is matched to (its channel is
--                                 copied from the order and never chosen), the rule applied and
--                                 the state (CB_*).
--      payin_chargeback_rules     versioned debit rules: merchant, optionally one banker, one
--                                 channel, one reason code. Never edited in place.
--      payin_chargeback_postings  CHARGEBACK_DEBIT and CHARGEBACK_REVERSAL entries. APPEND-ONLY:
--                                 a reversal is a new linked entry, never a deleted debit.
--      payin_chargeback_events    every state change, written by a trigger. APPEND-ONLY.
--
--    No rule is created here. Until staff configure one, a matched chargeback is a
--    CB_RULE_EXCEPTION and nothing is debited: the debit ratio is a commercial decision.

-- ── 1. Channel lock ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION vendor_payin_channel_locked() RETURNS trigger AS $$
BEGIN
  IF OLD.channel_type <> 'UNCLASSIFIED' AND NEW.channel_type IS DISTINCT FROM OLD.channel_type THEN
    RAISE EXCEPTION 'vendor_payin_orders.channel_type is final: order % is %, not %', OLD.id, OLD.channel_type, NEW.channel_type
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.requested_channel IS NOT NULL AND NEW.requested_channel IS DISTINCT FROM OLD.requested_channel THEN
    RAISE EXCEPTION 'vendor_payin_orders.requested_channel is final on order %', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vendor_payin_channel_locked_trg ON vendor_payin_orders;
CREATE TRIGGER vendor_payin_channel_locked_trg
  BEFORE UPDATE OF channel_type, requested_channel ON vendor_payin_orders
  FOR EACH ROW EXECUTE FUNCTION vendor_payin_channel_locked();

-- ── 2. Chargeback rules ─────────────────────────────────────────────────────────────────────────
-- Most specific active rule wins: banker > merchant > every merchant, then channel, then reason.
CREATE TABLE IF NOT EXISTS payin_chargeback_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id     text,                    -- the merchant (providers.id); NULL = every merchant
  banker_code     text,                    -- one banker of it; NULL = all its bankers
  channel_type    text CHECK (channel_type IN ('INTENT','P2P')),   -- NULL = both channels
  reason_code     text,                    -- NULL = every reason
  debit_bps       int  NOT NULL CHECK (debit_bps BETWEEN 0 AND 10000),  -- 10000 = the full chargeback
  auto_debit      boolean NOT NULL DEFAULT true,   -- false: every chargeback under it goes to review
  auto_max_amount numeric CHECK (auto_max_amount IS NULL OR auto_max_amount > 0),  -- above: review
  version         int  NOT NULL DEFAULT 1,
  effective_from  timestamptz NOT NULL DEFAULT now(),
  effective_to    timestamptz,             -- NULL = in force
  note            text,                    -- why (the commercial agreement it reflects)
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payin_chargeback_rules_scope_idx
  ON payin_chargeback_rules (provider_id, banker_code, channel_type, reason_code, effective_from DESC);

-- ── 3. Chargebacks ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payin_chargebacks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cb_ref           text NOT NULL UNIQUE,    -- CB-… Katana's own reference
  -- What the banker side reported, kept as received.
  source           text NOT NULL,           -- BANK | ACQUIRER | GATEWAY | SETTLEMENT_FILE | OTHER
  source_name      text,                    -- who sent it; staff only (may name a gateway)
  bank_ref         text NOT NULL,           -- the banker's own chargeback reference
  original_ref     text,                    -- UTR / RRN / transaction reference of the pay-in
  stated_order     text,                    -- order id / KTN id, when the record carries one
  stated_banker    text,
  stated_channel   text CHECK (stated_channel IN ('INTENT','P2P')),
  amount           numeric NOT NULL CHECK (amount > 0),
  currency         text NOT NULL DEFAULT 'INR',
  reason_code      text,
  reason_text      text,
  event_date       date,
  livemode         boolean NOT NULL DEFAULT true,
  received_at      timestamptz NOT NULL DEFAULT now(),
  received_by      text,
  -- The original pay-in. channel_type is copied from that order and is never set otherwise.
  order_id         uuid,                    -- vendor_payin_orders.id
  merchant_id      text,                    -- the banker
  provider_id      text,                    -- its merchant
  channel_type     text CHECK (channel_type IN ('INTENT','P2P','UNCLASSIFIED')),
  order_amount     numeric,
  match_method     text,                    -- ORDER_ID | REFERENCE | MANUAL
  matched_at       timestamptz,
  matched_by       text,
  -- The rule, as applied. Kept on the row so a later rule change never rewrites history.
  rule_id          uuid,
  rule_version     int,
  debit_bps        int,
  calculated_debit numeric,
  debited          numeric NOT NULL DEFAULT 0,   -- sum of CHARGEBACK_DEBIT postings
  reversed         numeric NOT NULL DEFAULT 0,   -- sum of CHARGEBACK_REVERSAL postings
  state            text NOT NULL DEFAULT 'CB_PENDING_MATCH' CHECK (state IN (
                     'CB_PENDING_MATCH','CB_MATCHED','CB_MANUAL_REVIEW','CB_RULE_EXCEPTION',
                     'CB_DEBIT_POSTED','CB_PARTIAL_DEBIT','CB_REVERSED','CB_DISMISSED')),
  state_note       text,                    -- why it is in this state, in words
  updated_by       text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, bank_ref)
);
CREATE INDEX IF NOT EXISTS payin_chargebacks_merchant_idx ON payin_chargebacks (merchant_id, channel_type, received_at DESC);
CREATE INDEX IF NOT EXISTS payin_chargebacks_order_idx    ON payin_chargebacks (order_id);
CREATE INDEX IF NOT EXISTS payin_chargebacks_state_idx    ON payin_chargebacks (state, received_at DESC);

-- ── 4. Postings (the chargeback sub-ledger) ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payin_chargeback_postings (
  id             bigserial PRIMARY KEY,
  chargeback_id  uuid NOT NULL,
  order_id       uuid NOT NULL,
  merchant_id    text NOT NULL,
  provider_id    text,
  channel_type   text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('CHARGEBACK_DEBIT','CHARGEBACK_REVERSAL')),
  amount         numeric NOT NULL CHECK (amount > 0),
  reverses_id    bigint REFERENCES payin_chargeback_postings(id),
  rule_id        uuid,
  rule_version   int,
  debit_bps      int,
  basis          jsonb NOT NULL,           -- how the amount was reached
  actor          text NOT NULL,
  note           text,
  livemode       boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payin_chargeback_postings_cb_idx ON payin_chargeback_postings (chargeback_id, created_at);
CREATE INDEX IF NOT EXISTS payin_chargeback_postings_merchant_idx ON payin_chargeback_postings (merchant_id, channel_type, created_at DESC);

-- ── 5. State history, written by a trigger ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payin_chargeback_events (
  id             bigserial PRIMARY KEY,
  chargeback_id  uuid NOT NULL,
  from_state     text,
  to_state       text NOT NULL,
  actor          text,
  note           text,
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payin_chargeback_events_cb_idx ON payin_chargeback_events (chargeback_id, at);

CREATE OR REPLACE FUNCTION payin_chargeback_log() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.state IS NOT DISTINCT FROM OLD.state
     AND NEW.state_note IS NOT DISTINCT FROM OLD.state_note THEN RETURN NULL; END IF;
  INSERT INTO payin_chargeback_events (chargeback_id, from_state, to_state, actor, note)
  VALUES (NEW.id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.state END, NEW.state,
          COALESCE(NEW.updated_by, NEW.received_by), NEW.state_note);
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payin_chargeback_log_trg ON payin_chargebacks;
CREATE TRIGGER payin_chargeback_log_trg
  AFTER INSERT OR UPDATE ON payin_chargebacks
  FOR EACH ROW EXECUTE FUNCTION payin_chargeback_log();

-- Postings and events are append-only.
CREATE OR REPLACE FUNCTION payin_chargeback_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payin_chargeback_postings_locked_trg ON payin_chargeback_postings;
CREATE TRIGGER payin_chargeback_postings_locked_trg
  BEFORE UPDATE OR DELETE ON payin_chargeback_postings
  FOR EACH ROW EXECUTE FUNCTION payin_chargeback_append_only();

DROP TRIGGER IF EXISTS payin_chargeback_events_locked_trg ON payin_chargeback_events;
CREATE TRIGGER payin_chargeback_events_locked_trg
  BEFORE UPDATE OR DELETE ON payin_chargeback_events
  FOR EACH ROW EXECUTE FUNCTION payin_chargeback_append_only();
