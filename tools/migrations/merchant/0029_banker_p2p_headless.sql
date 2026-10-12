-- merchantservice_db: QUASI-HEADLESS, a fourth P2P method (lib/p2p-method, lib/headless).
--
--   merchants.p2p_method  HEADLESS  the banker's own PhonePe and / or Paytm PG account, saved for
--                                   P2P, takes the payment. The customer pays from Katana's hosted
--                                   checkout (/pay/{id}/checkout), opened by the merchant's app in a
--                                   WebView with no browser chrome; the PSP's webhook confirms it.
--
-- Additive: the CHECK only gains a value. Re-runnable.

ALTER TABLE merchants DROP CONSTRAINT IF EXISTS merchants_p2p_method_ck;
ALTER TABLE merchants ADD CONSTRAINT merchants_p2p_method_ck
  CHECK (p2p_method IS NULL OR p2p_method IN ('UPI_ID', 'BHARATPE', 'PAYATOM', 'HEADLESS'));
