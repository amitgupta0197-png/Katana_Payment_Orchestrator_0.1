-- Gateway payment detail — everything the gateway told us about one payment.
--
-- checkout_orders holds our own view of an order (amount, status, who it belongs
-- to). It deliberately says nothing about HOW the money moved: which UPI handle,
-- which bank reference, what the acquirer called it, what it cost. All of that
-- arrived in the callback payload and was being thrown away — only four fields
-- survived, inside a state-transition row nobody can query usefully.
--
-- This table is that missing half, so a merchant can be shown the same picture the
-- gateway's own dashboard shows. One row per order, upserted by whichever channel
-- reports first (webhook / browser return / verify sweep) and enriched by the rest.
--
-- `raw` keeps the untouched payload: gateways add fields without notice, and a
-- column we did not think to create must never mean data we cannot recover.

CREATE TABLE IF NOT EXISTS payment_details (
  order_id            uuid PRIMARY KEY REFERENCES checkout_orders(id) ON DELETE CASCADE,
  provider            text NOT NULL,               -- PAYU, PAYTECH, …
  provider_payment_id text,                        -- PayU: mihpayid
  bank_ref_num        text,                        -- acquirer / bank reference (UPI: the RRN)
  payment_type        text,                        -- UPI, CC, DC, NB, …
  bank_name           text,
  card_masked         text,                        -- already masked by the gateway
  card_network        text,
  name_on_card        text,
  vpa                 text,                        -- payer UPI handle when present

  -- Money. NULL means "the gateway did not tell us", which is NOT the same as zero —
  -- charges usually only arrive at settlement, and showing 0 would be a lie.
  amount              numeric(20,2),
  net_amount_debit    numeric(20,2),
  gateway_fee         numeric(20,2),
  gateway_tax         numeric(20,2),
  settlement_amount   numeric(20,2),
  discount            numeric(20,2),

  customer_name       text,
  customer_email      text,
  customer_phone      text,

  gateway_status      text,                        -- the gateway's own word: success/failure/pending
  error_code          text,
  error_message       text,
  udf                 jsonb,                       -- udf1..5 / field0..9 as the gateway sent them
  raw                 jsonb NOT NULL DEFAULT '{}'::jsonb,

  source              text NOT NULL,               -- webhook | return | verify_api
  hash_verified       boolean,
  captured_at         timestamptz,                 -- when the gateway says it captured
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payment_details_provider_payment_idx
  ON payment_details (provider, provider_payment_id);
CREATE INDEX IF NOT EXISTS payment_details_bank_ref_idx
  ON payment_details (bank_ref_num);
