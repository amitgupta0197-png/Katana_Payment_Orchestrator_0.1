-- vendorgatewayservice_db: TEST / LIVE MODE, PHASE 1 OF 2 (see 0027).
--
-- Every pay-in order and every captured credit is permanently TEST or LIVE. Razorpay and
-- Stripe call the flag `livemode`; we use the same name because the obvious alternatives
-- are already taken here: meta.mode means QR vs app deeplink, merchants.stage = 'LIVE'
-- means onboarding finished, and `env` is the gateway's SANDBOX / PROD setting.
--
-- DEFAULT true: every existing row is live, so nothing already running changes meaning.
-- NOT NULL: money queries filter on `livemode = true`, and a NULL could otherwise leak in
-- or out of real numbers depending on how a query was written.
--
-- SAFE TO APPLY BEFORE THE CODE THAT USES IT. Adding a column with a constant default is a
-- metadata-only change in Postgres 11+, and the current code neither reads nor writes it.

ALTER TABLE vendor_payin_orders ADD COLUMN IF NOT EXISTS livemode boolean NOT NULL DEFAULT true;
ALTER TABLE vendor_txn_alerts   ADD COLUMN IF NOT EXISTS livemode boolean NOT NULL DEFAULT true;

-- ORDER REFS ARE UNIQUE PER (merchant, mode). A merchant testing with ORDER-1001 must not
-- collide with — or be handed back — its live ORDER-1001. The new index is added alongside
-- the old one (0024); 0027 drops the old one once the code names the new conflict target:
--   ON CONFLICT (vendor, COALESCE(merchant_id, ''), livemode, order_id)
-- While both exist a test order reusing a live ref raises a unique violation instead of
-- silently replaying the live order — noisy, but the safe direction to fail.
CREATE UNIQUE INDEX IF NOT EXISTS vendor_payin_orders_merchant_mode_order_uk
  ON vendor_payin_orders (vendor, COALESCE(merchant_id, ''), livemode, order_id);

-- Bank-credit matching (lib/txn-reconcile.ts) looks for open live orders by amount and age.
CREATE INDEX IF NOT EXISTS vendor_payin_orders_match_idx
  ON vendor_payin_orders (livemode, status, amount, created_at DESC);

-- Existing test traffic, so it stops counting as live the moment the filters ship. These
-- orders were created by the webhook tester and the payee-binding / deeplink checks; none
-- was ever a real customer payment.
UPDATE vendor_payin_orders SET livemode = false
 WHERE livemode = true
   AND (order_id LIKE 'WEBHOOK-TEST-%' OR order_id LIKE 'VERIFY-%'
        OR order_id LIKE 'PAYEEBIND-VERIFY-%' OR order_id LIKE 'DEEPLINK-TEST-%');
