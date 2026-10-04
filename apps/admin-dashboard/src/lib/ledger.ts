// Double-entry ledger posting (BRD §10 P6) — the system of record for settlement.
//
// postJournal({ journal_type, narration, currency, ref, lines, idempotency_key })
//   - every line positive, debits = credits PER CURRENCY (and the database checks the same at
//     commit: ledger 0004's deferred constraint trigger)
//   - ONE transaction: the header, every line and the hash-chain head commit together or not at all
//   - posts are serialised per tenant (an advisory lock), so the hash chain never forks and an
//     idempotency key is checked and claimed under the lock: a replay returns the first journal
//   - accounts are (tenant, code, currency) and created on first use (ledger 0004)
//   - posted rows are append-only (ledger 0004): a correction is a new, reversing journal
//
// `idempotency_key` is required for anything posted by a job that may run twice (ledger-sync,
// the settlement engine): the same key always means the same journal.

import { createHash } from "crypto";
import type { PoolClient } from "pg";
import { db, rows } from "@/lib/pg";

export type JournalType =
  | "payment.success"
  | "reserve.release"
  | "reserve.forfeit"
  | "dispute.open"
  | "dispute.won"
  | "dispute.lost"
  | "settlement.batch"
  | "refund.posted"
  | "commission.payout"
  | "payout.disbursed"
  // Settlement Engine (phase 1): money held by bankers for their merchants.
  | "payin.collected"
  | "chargeback.debit"
  | "chargeback.reversal"
  | "settlement.initiated"
  | "settlement.settled"
  | "settlement.reversed"
  | "settlement.manual"
  | "reserve.held";

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
  metadata?: Record<string, unknown>;
  /** When the money moved (a pay-in's paid time); default: now. Settlement cut-offs read it. */
  value_at?: Date | string | null;
  lines: JournalLine[];
}

const TENANT = "tenant-default";

// Default normal-balance for each type (used when auto-creating accounts).
const NORMAL: Record<AccountType, Side> = {
  ASSET: "D", LIABILITY: "C", INCOME: "C", EXPENSE: "D", EQUITY: "C",
};

function toBig(x: bigint | string | number): bigint {
  return typeof x === "bigint" ? x : BigInt(String(x));
}

/** The account type a dot-namespaced code implies. */
export function accountTypeOf(code: string): AccountType {
  return code.startsWith("ASSETS.") ? "ASSET"
    : code.startsWith("LIABILITIES.") ? "LIABILITY"
    : code.startsWith("INCOME.") ? "INCOME"
    : code.startsWith("EXPENSE.") ? "EXPENSE"
    : code.startsWith("EQUITY.") ? "EQUITY"
    : "ASSET";
}

/**
 * Why a set of lines cannot be posted, or null. Pure: every amount positive, and debits equal
 * credits in EACH currency (a journal that moves two currencies balances in both).
 */
export function journalProblem(lines: JournalLine[]): string | null {
  if (!lines.length) return "no lines";
  const net = new Map<string, bigint>();
  for (const l of lines) {
    const a = toBig(l.amount_minor);
    if (a <= 0n) return `line amount must be > 0 (got ${a} on ${l.account_code})`;
    if (l.side !== "D" && l.side !== "C") return `side must be D or C (got ${l.side})`;
    net.set(l.currency, (net.get(l.currency) ?? 0n) + (l.side === "D" ? a : -a));
  }
  for (const [cur, diff] of net) if (diff !== 0n) return `unbalanced in ${cur} (debits - credits = ${diff})`;
  return null;
}

async function ensureAccount(c: PoolClient, code: string, type: AccountType, currency: string): Promise<number> {
  const r = await c.query<{ id: number }>(`
    INSERT INTO accounts (tenant_id, code, type, currency, normal_balance)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (tenant_id, code, currency) DO UPDATE SET code = EXCLUDED.code
    RETURNING id
  `, [TENANT, code, type, currency, NORMAL[type]]);
  return r.rows[0].id;
}

export interface JournalResult {
  journal_id: string;
  total_minor: string;
  balanced: true;
  idempotent_replay?: boolean;
}

export async function postJournal(input: PostJournalInput): Promise<JournalResult> {
  const problem = journalProblem(input.lines);
  if (problem) throw new Error(`postJournal: ${problem}`);
  let totalDebit = 0n;
  for (const l of input.lines) if (l.side === "D") totalDebit += toBig(l.amount_minor);

  const c = await db("ledger").connect();
  try {
    await c.query("BEGIN");
    // One post at a time per tenant: the chain head is read and moved under this lock, and an
    // idempotency key is looked up and claimed under it, so neither can race.
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`ledger-post:${TENANT}`]);

    if (input.idempotency_key) {
      const dupe = await c.query<{ id: string; total: string }>(
        `SELECT id::text, total_debit_minor::text AS total FROM journal_entries WHERE tenant_id = $1 AND idempotency_key = $2`,
        [TENANT, input.idempotency_key]);
      if (dupe.rows.length) {
        await c.query("ROLLBACK");
        return { journal_id: dupe.rows[0].id, total_minor: dupe.rows[0].total, balanced: true, idempotent_replay: true };
      }
    }

    const head = await c.query<{ last_entry_hash: string }>(
      `SELECT last_entry_hash FROM hash_chain_head WHERE tenant_id = $1`, [TENANT]);
    const prev = head.rows[0]?.last_entry_hash ?? "0".repeat(64);
    const canonical = JSON.stringify({
      t: input.journal_type, n: input.narration, c: input.currency,
      r: input.ref ?? null, m: input.merchant_id ?? null, k: input.idempotency_key ?? null,
      lines: input.lines.map((l) => ({ a: l.account_code, s: l.side, amt: toBig(l.amount_minor).toString(), c: l.currency })),
    });
    const hash = createHash("sha256").update(prev + "|" + canonical).digest("hex");

    const j = await c.query<{ id: string }>(`
      INSERT INTO journal_entries
        (tenant_id, narration, currency, ref_type, ref_id,
         idempotency_key, prev_hash, entry_hash, journal_type, merchant_id,
         total_debit_minor, total_credit_minor, metadata, value_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::bigint, $11::bigint, $12::jsonb, COALESCE($13::timestamptz, now()))
      RETURNING id::text
    `, [
      TENANT, input.narration, input.currency,
      input.ref?.type ?? null, input.ref?.id ?? null,
      input.idempotency_key ?? null, prev, hash,
      input.journal_type, input.merchant_id ?? null,
      totalDebit.toString(),
      JSON.stringify({ source: "lib/ledger.ts", ...(input.metadata ?? {}) }),
      input.value_at ? new Date(input.value_at).toISOString() : null,
    ]);
    const journalId = j.rows[0].id;

    for (const l of input.lines) {
      const accountId = await ensureAccount(c, l.account_code, l.account_type ?? accountTypeOf(l.account_code), l.currency);
      const amt = toBig(l.amount_minor).toString();
      await c.query(`
        INSERT INTO ledger_lines (journal_id, tenant_id, account_id, side, amount, amount_minor, currency)
        VALUES ($1::uuid, $2, $3, $4, $5::numeric, $6::bigint, $7)
      `, [journalId, TENANT, accountId, l.side, amt, amt, l.currency]);
    }

    await c.query(`
      INSERT INTO hash_chain_head (tenant_id, last_entry_hash, last_entry_id, updated_at)
      VALUES ($1, $2, $3::uuid, now())
      ON CONFLICT (tenant_id) DO UPDATE
        SET last_entry_hash = EXCLUDED.last_entry_hash, last_entry_id = EXCLUDED.last_entry_id, updated_at = now()
    `, [TENANT, hash, journalId]);

    await c.query("COMMIT");   // the deferred balance check (ledger 0004) runs here
    return { journal_id: journalId, total_minor: totalDebit.toString(), balanced: true };
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

/** Balance of each account whose code starts with `prefix`, debits positive, per currency. */
export async function balancesByPrefix(prefix: string): Promise<{ code: string; currency: string; balance_minor: bigint }[]> {
  const r = await rows<{ code: string; currency: string; balance_minor: string }>("ledger", `
    SELECT code, currency, balance_minor::text FROM account_balances
     WHERE tenant_id = $1 AND code LIKE $2 ESCAPE '\\'
  `, [TENANT, prefix.replace(/[\\%_]/g, (m) => "\\" + m) + "%"]);
  return r.map((x) => ({ code: x.code, currency: x.currency, balance_minor: BigInt(x.balance_minor) }));
}

/** One account's balance (debits positive), 0 when it has no lines yet. */
export async function accountBalance(code: string, currency = "INR"): Promise<bigint> {
  const r = await rows<{ b: string }>("ledger",
    `SELECT balance_minor::text AS b FROM account_balances WHERE tenant_id = $1 AND code = $2 AND currency = $3`,
    [TENANT, code, currency]);
  return r[0] ? BigInt(r[0].b) : 0n;
}

/** Whether a journal with this idempotency key has been posted. */
export async function journalPosted(key: string): Promise<boolean> {
  const r = await rows("ledger", `SELECT 1 FROM journal_entries WHERE tenant_id = $1 AND idempotency_key = $2`, [TENANT, key]);
  return r.length > 0;
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
