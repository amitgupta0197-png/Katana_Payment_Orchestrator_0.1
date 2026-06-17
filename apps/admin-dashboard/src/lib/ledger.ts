// Double-entry ledger posting (BRD §10 P6).
//
// BRD acceptance: "Total ledger debits must equal total credits for every
// transaction group."
//
// postJournal({ journal_type, narration, currency, ref, lines })
//   - validates sum(debit) === sum(credit) (in minor units)
//   - upserts any missing account rows under the dot-namespace convention
//   - inserts the journal_entries row + one ledger_lines row per line
//   - returns { journal_id, total_minor }
//
// Idempotency: callers pass an `idempotency_key`. The DB-level
// UNIQUE(tenant_id, idempotency_key) on journal_entries dedupes retries.

import { createHash } from "crypto";
import { rows } from "@/lib/pg";

export type JournalType =
  | "payment.success"
  | "reserve.release"
  | "reserve.forfeit"
  | "dispute.open"
  | "dispute.won"
  | "dispute.lost"
  | "settlement.batch"
  | "refund.posted"
  | "commission.payout";

export type AccountType = "ASSET" | "LIABILITY" | "INCOME" | "EXPENSE" | "EQUITY";
export type Side = "D" | "C";

export interface JournalLine {
  account_code: string;          // dot-namespaced: LIABILITIES.MERCHANT_PAYABLE.<mid>
  account_type?: AccountType;    // required if the account row needs to be auto-created
  side: Side;
  amount_minor: bigint | string | number;
  currency: string;
}

export interface PostJournalInput {
  journal_type: JournalType;
  narration: string;
  currency: string;
  ref?: { type: string; id: string };
  merchant_id?: string | null;
  idempotency_key?: string;
  lines: JournalLine[];
}

// Default normal-balance for each type (used when auto-creating accounts).
const NORMAL: Record<AccountType, Side> = {
  ASSET: "D", LIABILITY: "C", INCOME: "C", EXPENSE: "D", EQUITY: "C",
};

function toBig(x: bigint | string | number): bigint {
  return typeof x === "bigint" ? x : BigInt(String(x));
}

async function ensureAccount(code: string, type: AccountType, currency: string): Promise<number> {
  const found = await rows<{ id: number }>("ledger",
    `SELECT id FROM accounts WHERE tenant_id='tenant-default' AND code=$1 LIMIT 1`,
    [code]).catch(() => []);
  if (found.length) return found[0].id;
  const ins = await rows<{ id: number }>("ledger", `
    INSERT INTO accounts (tenant_id, code, type, currency, normal_balance)
    VALUES ('tenant-default', $1, $2, $3, $4)
    RETURNING id
  `, [code, type, currency, NORMAL[type]]);
  return ins[0].id;
}

export interface JournalResult {
  journal_id: string;
  total_minor: string;
  balanced: true;
  idempotent_replay?: boolean;
}

export async function postJournal(input: PostJournalInput): Promise<JournalResult> {
  if (!input.lines.length) throw new Error("postJournal: no lines");

  let totalDebit = 0n, totalCredit = 0n;
  for (const l of input.lines) {
    const a = toBig(l.amount_minor);
    if (a <= 0n) throw new Error(`postJournal: line amount must be > 0 (got ${a})`);
    if (l.side === "D") totalDebit += a; else totalCredit += a;
  }
  if (totalDebit !== totalCredit)
    throw new Error(`postJournal: unbalanced (debit=${totalDebit} credit=${totalCredit})`);

  // Idempotency: replay returns the original row.
  if (input.idempotency_key) {
    const dupe = await rows<any>("ledger",
      `SELECT id::text FROM journal_entries WHERE tenant_id='tenant-default' AND idempotency_key=$1`,
      [input.idempotency_key]).catch(() => []);
    if (dupe.length) {
      return { journal_id: dupe[0].id, total_minor: totalDebit.toString(), balanced: true, idempotent_replay: true };
    }
  }

  // Hash chain seed.
  const head = await rows<{ last_entry_hash: string }>("ledger",
    `SELECT last_entry_hash FROM hash_chain_head WHERE tenant_id='tenant-default'`)
    .catch(() => []);
  const prev = head[0]?.last_entry_hash ?? "0".repeat(64);

  const canonical = JSON.stringify({
    t: input.journal_type, n: input.narration, c: input.currency,
    r: input.ref ?? null, m: input.merchant_id ?? null,
    lines: input.lines.map(l => ({ a: l.account_code, s: l.side, amt: toBig(l.amount_minor).toString(), c: l.currency })),
  });
  const hash = createHash("sha256").update(prev + "|" + canonical).digest("hex");

  // Insert journal row.
  const j = await rows<{ id: string }>("ledger", `
    INSERT INTO journal_entries
      (tenant_id, narration, currency, ref_type, ref_id,
       idempotency_key, prev_hash, entry_hash, journal_type, merchant_id,
       total_debit_minor, total_credit_minor, metadata)
    VALUES ('tenant-default', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
    RETURNING id::text
  `, [
    input.narration, input.currency,
    input.ref?.type ?? null, input.ref?.id ?? null,
    input.idempotency_key ?? null, prev, hash,
    input.journal_type, input.merchant_id ?? null,
    totalDebit.toString(), totalCredit.toString(),
    JSON.stringify({ source: "lib/ledger.ts" }),
  ]);
  const journalId = j[0].id;

  // Insert lines.
  for (const l of input.lines) {
    const acctType: AccountType = l.account_type
      ?? (l.account_code.startsWith("ASSETS.") ? "ASSET"
        : l.account_code.startsWith("LIABILITIES.") ? "LIABILITY"
        : l.account_code.startsWith("INCOME.") ? "INCOME"
        : l.account_code.startsWith("EXPENSE.") ? "EXPENSE"
        : "ASSET");
    const accountId = await ensureAccount(l.account_code, acctType, l.currency);
    const amt = toBig(l.amount_minor);
    await rows("ledger", `
      INSERT INTO ledger_lines (journal_id, tenant_id, account_id, side, amount, amount_minor, currency)
      VALUES ($1::uuid, 'tenant-default', $2, $3, $4, $5, $6)
    `, [journalId, accountId, l.side, amt.toString(), amt.toString(), l.currency]);
  }

  // Update chain head.
  await rows("ledger", `
    INSERT INTO hash_chain_head (tenant_id, last_entry_hash, last_entry_id, updated_at)
    VALUES ('tenant-default', $1, $2::uuid, now())
    ON CONFLICT (tenant_id) DO UPDATE
      SET last_entry_hash=EXCLUDED.last_entry_hash,
          last_entry_id=EXCLUDED.last_entry_id, updated_at=now()
  `, [hash, journalId]).catch(() => null);

  return { journal_id: journalId, total_minor: totalDebit.toString(), balanced: true };
}

// Read helpers used by /ledger UI.
export async function getJournal(journalId: string) {
  const j = await rows<any>("ledger", `
    SELECT id::text, posted_at, narration, currency, ref_type, ref_id,
           journal_type, COALESCE(merchant_id,'') AS merchant_id,
           total_debit_minor::text, total_credit_minor::text,
           entry_hash, prev_hash
      FROM journal_entries WHERE id=$1::uuid
  `, [journalId]);
  if (!j.length) return null;
  const lines = await rows<any>("ledger", `
    SELECT l.id, a.code AS account_code, a.type AS account_type, l.side,
           COALESCE(l.amount_minor::text, l.amount::text) AS amount_minor,
           l.currency
      FROM ledger_lines l JOIN accounts a ON a.id = l.account_id
     WHERE l.journal_id = $1::uuid
     ORDER BY l.id
  `, [journalId]);
  return { ...j[0], lines };
}
