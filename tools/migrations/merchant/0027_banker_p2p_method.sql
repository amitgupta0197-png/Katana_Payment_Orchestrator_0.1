-- merchantservice_db: ONE P2P METHOD PER BANKER.
--
-- A banker on P2P is paid in exactly one way, chosen by staff (lib/p2p-method):
--
--   merchants.p2p_method  NULL      not chosen: routed as before (a P2P processor account if its
--                                   first account is one, else its UPI ID). Every banker, so
--                                   applying this changes nothing.
--                         UPI_ID    the banker's own UPI ID; a capture phone confirms payments
--                         BHARATPE  the banker's BharatPe QR; the agent reads BharatPe and posts
--                                   each payment signed with the BharatPe MID key
--                         PAYATOM   PayAtom issues the payment and confirms it
--
-- Only the chosen one takes P2P orders: with UPI_ID or BHARATPE a P2P processor account is never
-- used, with PAYATOM a P2P order is never sent to the bare UPI ID.

ALTER TABLE merchants ADD COLUMN IF NOT EXISTS p2p_method        text;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS p2p_method_set_by text;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS p2p_method_set_at timestamptz;

DO $$ BEGIN
  ALTER TABLE merchants ADD CONSTRAINT merchants_p2p_method_ck
    CHECK (p2p_method IS NULL OR p2p_method IN ('UPI_ID', 'BHARATPE', 'PAYATOM'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Every change, append-only. NULL = back to "not chosen".
CREATE TABLE IF NOT EXISTS merchant_p2p_method_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_code text NOT NULL,
  from_method   text,
  to_method     text,
  changed_by    text,
  note          text,
  changed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS merchant_p2p_method_history_code_idx ON merchant_p2p_method_history (merchant_code, changed_at DESC);
