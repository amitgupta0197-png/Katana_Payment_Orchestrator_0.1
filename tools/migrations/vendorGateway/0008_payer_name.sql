-- vendorgatewayservice_db: capture the PAYER NAME carried by payment-app push
-- notifications (e.g. Paytm for Business "₹300.00 Received from Mr KUSH DESAI").
-- Business-merchant push/email alerts carry no UTR and no VPA, so the payer name is
-- often the only human-identifiable signal — surfaced on the recon console and
-- manual cases so ops can disambiguate a fixed-amount credit to the right customer.
ALTER TABLE vendor_txn_alerts ADD COLUMN IF NOT EXISTS payer_name text;
