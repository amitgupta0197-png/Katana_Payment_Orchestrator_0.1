-- ledgerservice_db: the ledger becomes the system of record for settlement (Settlement Engine,
-- phase 1). Additive and re-runnable; existing rows are left as they are.
--
--   1. An account is (tenant, code, CURRENCY): the same code in two currencies is two accounts.
--   2. Posted rows are append-only: journal_entries and ledger_lines refuse UPDATE and DELETE. A
--      correction is a new, reversing journal. Local test cleanup may set
--      `SET LOCAL ledger.maintenance = 'on'` inside its own transaction.
--   3. Every journal posted from now on balances PER CURRENCY, checked by the database at commit
--      (a deferred constraint trigger), not only by lib/ledger.ts. Rows from before are not
--      re-checked (one local legacy journal is known not to balance).
--   4. Line sanity: side is D or C; a new line's amount_minor is positive.

-- 1. Accounts per currency ----------------------------------------------------------------------
DO $$
DECLARE c text;
BEGIN
  -- the original UNIQUE (tenant_id, code), whatever it was named when the table was rebuilt
  FOR c IN
    SELECT con.conname FROM pg_constraint con
      JOIN pg_class t ON t.oid = con.conrelid
     WHERE t.relname = 'accounts' AND con.contype = 'u'
       AND (SELECT array_agg(a.attname ORDER BY a.attname) FROM unnest(con.conkey) k
              JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k) = ARRAY['code','tenant_id']::name[]
  LOOP
    EXECUTE format('ALTER TABLE accounts DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_tenant_code_currency_uk ON accounts (tenant_id, code, currency);

-- Value date: when the money moved (a pay-in's paid time), as opposed to posted_at, when the
-- journal was written. Settlement cut-offs (T+1 etc.) read it. Rows from before = posted_at.
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS value_at timestamptz;
CREATE INDEX IF NOT EXISTS journal_entries_value_idx ON journal_entries (journal_type, value_at);

-- 4. Line sanity (new rows only: NOT VALID skips the check on existing ones) ---------------------
DO $$ BEGIN
  ALTER TABLE ledger_lines ADD CONSTRAINT ledger_lines_side_ck CHECK (side IN ('D','C')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE ledger_lines ADD CONSTRAINT ledger_lines_amount_positive_ck CHECK (amount_minor IS NULL OR amount_minor > 0) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS ledger_lines_account_currency_idx ON ledger_lines (account_id, currency);
CREATE INDEX IF NOT EXISTS journal_entries_type_ref_idx ON journal_entries (journal_type, ref_type, ref_id);

-- 2. Append-only ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ledger_append_only() RETURNS trigger AS $$
BEGIN
  IF current_setting('ledger.maintenance', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'ledger % rows are append-only: post a reversing journal instead', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_entries_append_only_trg ON journal_entries;
CREATE TRIGGER journal_entries_append_only_trg BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
DROP TRIGGER IF EXISTS ledger_lines_append_only_trg ON ledger_lines;
CREATE TRIGGER ledger_lines_append_only_trg BEFORE UPDATE OR DELETE ON ledger_lines
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();

-- 3. Balanced per currency, at commit ------------------------------------------------------------
CREATE OR REPLACE FUNCTION ledger_journal_balanced() RETURNS trigger AS $$
DECLARE bad record;
BEGIN
  SELECT currency,
         SUM(CASE side WHEN 'D' THEN COALESCE(amount_minor, amount) ELSE -COALESCE(amount_minor, amount) END) AS diff
    INTO bad
    FROM ledger_lines
   WHERE journal_id = NEW.journal_id
   GROUP BY currency
  HAVING SUM(CASE side WHEN 'D' THEN COALESCE(amount_minor, amount) ELSE -COALESCE(amount_minor, amount) END) <> 0
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'journal % does not balance in % (debits - credits = %)', NEW.journal_id, bad.currency, bad.diff
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_lines_balanced_trg ON ledger_lines;
CREATE CONSTRAINT TRIGGER ledger_lines_balanced_trg AFTER INSERT ON ledger_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_journal_balanced();

-- Balances: one row per account and currency, debits positive.
CREATE OR REPLACE VIEW account_balances AS
SELECT a.tenant_id, a.id AS account_id, a.code, a.type, a.currency,
       COALESCE(SUM(CASE l.side WHEN 'D' THEN COALESCE(l.amount_minor, l.amount) ELSE 0 END), 0)::bigint AS debit_minor,
       COALESCE(SUM(CASE l.side WHEN 'C' THEN COALESCE(l.amount_minor, l.amount) ELSE 0 END), 0)::bigint AS credit_minor,
       COALESCE(SUM(CASE l.side WHEN 'D' THEN COALESCE(l.amount_minor, l.amount) ELSE -COALESCE(l.amount_minor, l.amount) END), 0)::bigint AS balance_minor
  FROM accounts a
  LEFT JOIN ledger_lines l ON l.account_id = a.id AND l.currency = a.currency
 GROUP BY a.tenant_id, a.id, a.code, a.type, a.currency;

-- Where ledger-sync has read up to in a source that cannot be stamped (an append-only table).
CREATE TABLE IF NOT EXISTS ledger_sync_cursors (
  name       text PRIMARY KEY,
  last_id    bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
