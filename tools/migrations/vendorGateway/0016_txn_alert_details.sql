-- Full payment detail for a captured credit.
--
-- The GPay Business transaction screen carries considerably more than the RRN: the
-- Google transaction id, "Customer paid" vs "Amount you get" (they differ once fees
-- apply), the payer's name, and the payment timestamp. The agent already reads that
-- whole block to find the RRN and then discards the rest, so the dashboard can only
-- ever show an amount and a reference -- not who actually paid.
--
-- Stored as jsonb rather than columns because the field set differs per source (a GPay
-- detail screen, a Paytm receipt and a bank SMS do not describe a payment the same way)
-- and will keep changing as each app's layout does. Anything that turns out to be
-- universal and queried often can be promoted to a real column later.
--
-- Additive and nullable: every existing row and every older agent build keeps working
-- unchanged, they simply carry no details.

ALTER TABLE vendor_txn_alerts ADD COLUMN IF NOT EXISTS details jsonb;

-- Partial index: "which captures actually have full detail" is the question asked when
-- reporting coverage, and it is a small subset of the table.
CREATE INDEX IF NOT EXISTS vendor_txn_alerts_details_idx
  ON vendor_txn_alerts ((details IS NOT NULL))
  WHERE details IS NOT NULL;
