-- Settlement legs are not collections.
--
-- The payment app posts a notification when it moves money it already holds into the
-- merchant's bank account ("₹40,006.00 deposited — ₹40,006.00 for transactions settled to
-- your bank account", GPay for Business). The phone's parser sees "deposited" and forwards
-- it, and because a settlement shares no identity with the payments it settles — no RRN, its
-- own wording, its own nonce, hours later — no duplicate check in the reconciler could catch
-- it. Each one landed as a fresh "awaiting RRN" credit and stated the same takings a second
-- time.
--
-- Ingestion now classifies these at the door (lib/settlement-credit.ts) and stores them with
-- txn_type = 'SETTLEMENT'. This migration backfills the rows already recorded and indexes the
-- new class so the "Settled to bank" list is cheap.
--
-- Nothing is deleted: a settlement leg is the evidence that collected money actually reached
-- the bank, and the alert store is append-only by design (forensics §4). It is reclassified,
-- not removed.

-- Backfill. Matched on the wording alone, and only for rows that name no payer and carry no
-- 12-digit RRN — the same fail-safe pair the TypeScript classifier applies, so a genuine
-- collection cannot be reclassified out of the totals by this UPDATE.
UPDATE vendor_txn_alerts
   SET txn_type = 'SETTLEMENT',
       detail   = COALESCE(NULLIF(detail,''), '')
                  || CASE WHEN COALESCE(detail,'') = '' THEN '' ELSE ' · ' END
                  || 'reclassified: settled to bank account by the payment app, not a customer payment (0017)'
 WHERE COALESCE(direction,'CREDIT') = 'CREDIT'
   AND COALESCE(txn_type,'') <> 'SETTLEMENT'
   AND ( COALESCE(raw,'') ILIKE '%settled to your bank%'
      OR COALESCE(raw,'') ILIKE '%transactions settled%'
      OR COALESCE(raw,'') ILIKE '%airtel-settlement%' )
   AND COALESCE(payer_name,'') = ''
   AND COALESCE(payer_vpa,'')  = ''
   AND (utr IS NULL OR utr !~ '^[0-9]{12}$');

-- Partial index: "show me the settlement legs, newest first" is the whole query the new list
-- runs, and settlements are a small minority of the table.
CREATE INDEX IF NOT EXISTS vendor_txn_alerts_settlement_idx
  ON vendor_txn_alerts (created_at DESC)
  WHERE txn_type = 'SETTLEMENT';
