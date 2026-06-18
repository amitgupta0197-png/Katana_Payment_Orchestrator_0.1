-- ledgerservice_db: double-entry accounting base tables (BRD §10 P6).
--
-- These CREATE statements were lost in the 2026-06-15 wipe; migration
-- 0002_minor_units_commission_fx.sql does `ALTER TABLE ledger_lines ...`,
-- `ALTER TABLE journal_entries ...` and `commission_ledger.journal_id uuid
-- REFERENCES journal_entries(id)`, so those base tables must already exist.
-- This file reconstructs them from the BFF query code:
--   apps/admin-dashboard/src/lib/ledger.ts          (postJournal INSERTs, getJournal SELECTs)
--   apps/admin-dashboard/src/app/api/ledger/journals/route.ts
--   apps/admin-dashboard/src/lib/settlement.ts       (JOIN accounts a ON a.id = l.account_id)
--   apps/admin-dashboard/src/lib/reconciliation.ts
--
-- IMPORTANT: this file contains ONLY the original columns. The minor-unit /
-- commission columns (journal_entries.total_debit_minor, total_credit_minor,
-- journal_type, merchant_id and ledger_lines.amount_minor) are added by 0002.
-- Runs first via the bootstrap glob (0000 < 0001 < 0002).

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Chart of accounts. ledger.ts auto-creates rows under the dot-namespace
-- convention (LIABILITIES.MERCHANT_PAYABLE.<mid>, INCOME.MDR_EARNED.%, …).
-- account_id on ledger_lines is an integer FK -> accounts.id (ledger.ts reads
-- `id` as a JS number and passes it back as account_id).
CREATE TABLE IF NOT EXISTS accounts (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      text NOT NULL DEFAULT 'tenant-default',
  code           text NOT NULL,                    -- dot-namespaced account code
  type           text NOT NULL,                    -- ASSET | LIABILITY | INCOME | EXPENSE | EQUITY
  currency       text NOT NULL DEFAULT 'INR',
  normal_balance text NOT NULL DEFAULT 'D',        -- D | C
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
CREATE INDEX IF NOT EXISTS accounts_code_idx ON accounts (tenant_id, code);

-- Journal header. One row per balanced transaction group. `id` MUST be uuid
-- because commission_ledger.journal_id (0002) references journal_entries(id),
-- and ledger_lines.journal_id casts to ::uuid in every query.
CREATE TABLE IF NOT EXISTS journal_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL DEFAULT 'tenant-default',
  posted_at       timestamptz NOT NULL DEFAULT now(),
  narration       text,
  currency        text NOT NULL DEFAULT 'INR',
  ref_type        text,
  ref_id          text,
  idempotency_key text,
  prev_hash       text,
  entry_hash      text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS journal_entries_posted_idx ON journal_entries (tenant_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS journal_entries_ref_idx    ON journal_entries (ref_id);

-- Journal lines. One row per debit/credit. side is 'D' | 'C' (ledger.ts).
CREATE TABLE IF NOT EXISTS ledger_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_id  uuid NOT NULL REFERENCES journal_entries(id),
  tenant_id   text NOT NULL DEFAULT 'tenant-default',
  account_id  bigint NOT NULL REFERENCES accounts(id),
  side        text NOT NULL,                        -- D | C
  amount      numeric(20,0) NOT NULL DEFAULT 0,     -- legacy minor-unit amount
  currency    text NOT NULL DEFAULT 'INR'
);
CREATE INDEX IF NOT EXISTS ledger_lines_journal_idx ON ledger_lines (journal_id);
CREATE INDEX IF NOT EXISTS ledger_lines_account_idx ON ledger_lines (account_id);

-- Hash-chain head pointer (one row per tenant). Updated by ledger.ts on every
-- post; ON CONFLICT (tenant_id) requires tenant_id to be the conflict target.
CREATE TABLE IF NOT EXISTS hash_chain_head (
  tenant_id       text PRIMARY KEY DEFAULT 'tenant-default',
  last_entry_hash text NOT NULL,
  last_entry_id   uuid,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
