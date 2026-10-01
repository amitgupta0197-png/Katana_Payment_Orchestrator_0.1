-- vendorgatewayservice_db: KATANA P2P ORDERS and KATANA INTENT ORDERS — one table per flow.
--
-- vendor_payin_orders stays the shared core of every pay-in (merchant, amount, status, mode,
-- timestamps). What belongs to one flow only moves out of its `meta` JSON into a table of its
-- own, with real columns and its own reference:
--
--   katana_p2p_orders     P2P-000000001   the banker's receiving UPI ID, the payer, the UTR
--                                         and how it was evidenced, payer proof, review hold
--   katana_intent_orders  INT-000000001   the gateway, its transaction and payment ids, its
--                                         payment page, the bank reference it reported, its
--                                         payout to the banker
--
-- An order is in exactly one of the two, decided by vendor_payin_orders.channel_type
-- (vendorGateway 0029), which is fixed when the order is created.
--
-- The flow tables are maintained by a trigger on vendor_payin_orders, not by application code:
-- more than a dozen code paths update an order (creation, confirmation, webhooks, sweeps,
-- operator actions), and a trigger keeps every one of them in step without a second write that
-- could be missed. The trigger NEVER fails the order write: a row it cannot project is logged
-- as a warning and the order is saved regardless.

CREATE SEQUENCE IF NOT EXISTS katana_p2p_ref_seq;
CREATE SEQUENCE IF NOT EXISTS katana_intent_ref_seq;

CREATE TABLE IF NOT EXISTS katana_p2p_orders (
  order_id       uuid PRIMARY KEY REFERENCES vendor_payin_orders(id) ON DELETE CASCADE,
  p2p_ref        text NOT NULL UNIQUE DEFAULT ('P2P-' || lpad(nextval('katana_p2p_ref_seq')::text, 9, '0')),
  merchant_id    text,
  livemode       boolean NOT NULL DEFAULT true,
  pay_mode       text,                 -- QR | INTENT: how the UPI link was presented
  payee_vpa      text,                 -- the banker's UPI ID the payer was sent to
  vpa_pool       jsonb,                -- backup receiving UPI IDs and their state
  payer_vpa      text,
  utr            text,                 -- the bank reference stated for the payment
  evidence       text,                 -- how it was evidenced: DEVICE | EMAIL | UTR | SCREENSHOT | MANUAL …
  confirmed_by   text,
  confirmed_at   timestamptz,
  proof_status   text,                 -- payer proof under review (PROOF_SUBMITTED), if any
  proof_utr      text,
  on_hold        boolean NOT NULL DEFAULT false,   -- held for a manual check (high amount)
  hold_reason    text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS katana_p2p_orders_merchant_idx ON katana_p2p_orders (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS katana_p2p_orders_utr_idx      ON katana_p2p_orders (utr);
CREATE INDEX IF NOT EXISTS katana_p2p_orders_payee_idx    ON katana_p2p_orders (payee_vpa);

CREATE TABLE IF NOT EXISTS katana_intent_orders (
  order_id           uuid PRIMARY KEY REFERENCES vendor_payin_orders(id) ON DELETE CASCADE,
  intent_ref         text NOT NULL UNIQUE DEFAULT ('INT-' || lpad(nextval('katana_intent_ref_seq')::text, 9, '0')),
  merchant_id        text,
  livemode           boolean NOT NULL DEFAULT true,
  gateway            text,             -- which gateway took the payment (internal; never shown to a merchant)
  gateway_env        text,             -- TEST | PROD
  gateway_auth       text,             -- how Katana signed in to the gateway, when not the default
  gateway_txn_id     text,             -- the transaction id Katana sent the gateway
  gateway_payment_id text,             -- the gateway's own id for the payment
  checkout_url       text,             -- the gateway's payment page, for hosted-page gateways
  payee_vpa          text,             -- the gateway's collection UPI ID
  bank_ref           text,             -- the bank reference the gateway reported
  evidence           text,
  confirmed_by       text,
  confirmed_at       timestamptz,
  payout_status      text,             -- the gateway's payout to the banker, when it reports one
  payout_at          timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS katana_intent_orders_merchant_idx ON katana_intent_orders (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS katana_intent_orders_gateway_idx  ON katana_intent_orders (gateway, created_at DESC);
CREATE INDEX IF NOT EXISTS katana_intent_orders_gwtxn_idx    ON katana_intent_orders (gateway_txn_id);

-- A timestamp from JSON text, or NULL when it is missing or unreadable.
CREATE OR REPLACE FUNCTION katana_ts(v text) RETURNS timestamptz AS $$
BEGIN
  IF v IS NULL OR v = '' THEN RETURN NULL; END IF;
  RETURN v::timestamptz;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$ LANGUAGE plpgsql IMMUTABLE;

-- Project one order into the table of its flow. Used by the trigger and by the backfill.
-- Update first, insert only when the order has no row yet: an upsert would draw a reference
-- from the sequence on every update and leave gaps in P2P-… / INT-….
CREATE OR REPLACE FUNCTION katana_flow_project(o vendor_payin_orders) RETURNS void AS $$
DECLARE
  m  jsonb := COALESCE(o.meta, '{}'::jsonb);
  c  jsonb := COALESCE(o.meta->'confirmation', '{}'::jsonb);
  g  jsonb := COALESCE(o.meta->'gateway', '{}'::jsonb);
BEGIN
  IF o.channel_type = 'P2P' THEN
    UPDATE katana_p2p_orders SET
      merchant_id = o.merchant_id, livemode = o.livemode, pay_mode = m->>'mode',
      payee_vpa = m->>'receiver_vpa', vpa_pool = m->'vpa_pool',
      payer_vpa = COALESCE(NULLIF(o.customer_vpa, ''), m->>'sender_vpa'),
      utr = NULLIF(c->>'utr', ''), evidence = c->>'evidence', confirmed_by = c->>'by',
      confirmed_at = katana_ts(c->>'at'), proof_status = m->>'review', proof_utr = m->'proof'->>'utr',
      on_hold = COALESCE(m->>'hold', 'false') = 'true', hold_reason = m->>'hold_reason',
      updated_at = o.updated_at
    WHERE order_id = o.id;
    IF NOT FOUND THEN
      INSERT INTO katana_p2p_orders
        (order_id, merchant_id, livemode, pay_mode, payee_vpa, vpa_pool, payer_vpa,
         utr, evidence, confirmed_by, confirmed_at, proof_status, proof_utr, on_hold, hold_reason,
         created_at, updated_at)
      VALUES
        (o.id, o.merchant_id, o.livemode, m->>'mode', m->>'receiver_vpa', m->'vpa_pool',
         COALESCE(NULLIF(o.customer_vpa, ''), m->>'sender_vpa'),
         NULLIF(c->>'utr', ''), c->>'evidence', c->>'by', katana_ts(c->>'at'),
         m->>'review', m->'proof'->>'utr', COALESCE(m->>'hold', 'false') = 'true', m->>'hold_reason',
         o.created_at, o.updated_at);
    END IF;
  ELSIF o.channel_type = 'INTENT' THEN
    UPDATE katana_intent_orders SET
      merchant_id = o.merchant_id, livemode = o.livemode,
      gateway = COALESCE(NULLIF(g->>'provider', ''), o.channel_id), gateway_env = g->>'env', gateway_auth = g->>'auth',
      gateway_txn_id = COALESCE(NULLIF(g->>'txnid', ''), o.vendor_txn_id), gateway_payment_id = g->>'payment_id',
      checkout_url = g->>'checkout_url', payee_vpa = g->>'payee_vpa',
      bank_ref = NULLIF(c->>'utr', ''), evidence = c->>'evidence', confirmed_by = c->>'by',
      confirmed_at = katana_ts(c->>'at'),
      payout_status = m->'settlement'->>'status', payout_at = katana_ts(m->'settlement'->>'at'),
      updated_at = o.updated_at
    WHERE order_id = o.id;
    IF NOT FOUND THEN
      INSERT INTO katana_intent_orders
        (order_id, merchant_id, livemode, gateway, gateway_env, gateway_auth, gateway_txn_id,
         gateway_payment_id, checkout_url, payee_vpa, bank_ref, evidence, confirmed_by, confirmed_at,
         payout_status, payout_at, created_at, updated_at)
      VALUES
        (o.id, o.merchant_id, o.livemode, COALESCE(NULLIF(g->>'provider', ''), o.channel_id), g->>'env', g->>'auth',
         COALESCE(NULLIF(g->>'txnid', ''), o.vendor_txn_id), g->>'payment_id', g->>'checkout_url', g->>'payee_vpa',
         NULLIF(c->>'utr', ''), c->>'evidence', c->>'by', katana_ts(c->>'at'),
         m->'settlement'->>'status', katana_ts(m->'settlement'->>'at'),
         o.created_at, o.updated_at);
    END IF;
  END IF;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION katana_flow_sync() RETURNS trigger AS $$
BEGIN
  BEGIN
    PERFORM katana_flow_project(NEW);
  EXCEPTION WHEN OTHERS THEN
    -- The order is the record of the payment; its flow row is a projection of it. A projection
    -- that fails must never lose the order.
    RAISE WARNING 'katana_flow_sync: order % not projected: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS katana_flow_sync_trg ON vendor_payin_orders;
CREATE TRIGGER katana_flow_sync_trg
  AFTER INSERT OR UPDATE ON vendor_payin_orders
  FOR EACH ROW EXECUTE FUNCTION katana_flow_sync();

-- Existing orders, oldest first so the references follow creation order. UNCLASSIFIED orders
-- (no flow recorded) are in neither table.
DO $$
DECLARE o vendor_payin_orders;
BEGIN
  FOR o IN SELECT * FROM vendor_payin_orders WHERE channel_type IN ('P2P','INTENT') ORDER BY created_at, id LOOP
    BEGIN
      PERFORM katana_flow_project(o);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'katana flow backfill: order % skipped: %', o.id, SQLERRM;
    END;
  END LOOP;
END $$;
