-- providerservice_db: DT module double-entry SHADOW ledger (BRD §13 + Migration §23
-- "run shadow calculations"). We do NOT post to the production hash-chained
-- ledgerservice_db.journal_entries yet — BRD §13 requires Finance+Legal to approve the
-- final GL names and the treatment of traffic allocation first. Until then the DT engine
-- accrues balanced entries here so the numbers can be validated in shadow.
CREATE TABLE IF NOT EXISTS dt_journal_entries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event          text NOT NULL,                 -- advance_confirmed / reserve_created / merchant_fee / banker_commission
  debit_account  text NOT NULL,
  credit_account text,                          -- null for memorandum/sub-ledger (e.g. traffic allocation)
  amount         numeric(18,2) NOT NULL,
  currency       text NOT NULL DEFAULT 'INR',
  banker_id      text,
  branch         text,
  purchase_lot   uuid,
  transaction_ref text,
  correlation_id text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dt_journal_entries_ref_idx ON dt_journal_entries (transaction_ref, created_at);
CREATE INDEX IF NOT EXISTS dt_journal_entries_corr_idx ON dt_journal_entries (correlation_id);
