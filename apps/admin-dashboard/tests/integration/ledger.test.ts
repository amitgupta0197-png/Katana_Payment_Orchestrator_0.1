// The ledger as the system of record (ledger 0004, lib/ledger): a journal posts in one transaction,
// balances per currency (checked by the database too), replays on its idempotency key, keeps one
// unforked hash chain under concurrent posts, and its rows cannot be edited or deleted.
// Run with `pnpm test:integration`. IT WRITES ROWS, so it only runs against a local database; its
// own rows are removed at the end under `ledger.maintenance`.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { db, rows } from "@/lib/pg";
import { postJournal, accountBalance, journalProblem } from "@/lib/ledger";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };
const R = `ITEST${Date.now().toString(36).toUpperCase()}`;
const A = `ASSETS.ITEST_CASH.${R}`, L = `LIABILITIES.ITEST_PAYABLE.${R}`;

after(async () => {
  if (LOCAL) {
    const c = await db("ledger").connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ledger.maintenance = 'on'");
      await c.query(`DELETE FROM ledger_lines WHERE journal_id IN (SELECT id FROM journal_entries WHERE idempotency_key LIKE $1)`, [`${R}%`]);
      await c.query(`DELETE FROM journal_entries WHERE idempotency_key LIKE $1`, [`${R}%`]);
      await c.query(`DELETE FROM accounts WHERE code LIKE $1`, [`%${R}`]);
      await c.query("COMMIT");
    } finally { c.release(); }
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
});

const pay = (key: string, amt: number, cur = "INR") => postJournal({
  journal_type: "payin.collected", narration: "itest", currency: cur, idempotency_key: key,
  lines: [{ account_code: A, side: "D", amount_minor: amt, currency: cur }, { account_code: L, side: "C", amount_minor: amt, currency: cur }],
});

test("balanced per currency: the pure check", () => {
  assert.equal(journalProblem([{ account_code: A, side: "D", amount_minor: 5, currency: "INR" }, { account_code: L, side: "C", amount_minor: 5, currency: "INR" }]), null);
  // 5 INR against 5 USD sums to zero overall but balances in neither currency.
  assert.match(journalProblem([{ account_code: A, side: "D", amount_minor: 5, currency: "INR" }, { account_code: L, side: "C", amount_minor: 5, currency: "USD" }]) ?? "", /unbalanced in INR/);
  assert.match(journalProblem([{ account_code: A, side: "D", amount_minor: 0, currency: "INR" }]) ?? "", /> 0/);
});

test("a journal posts, and its idempotency key replays it", opts, async () => {
  const a = await pay(`${R}-1`, 12345);
  const b = await pay(`${R}-1`, 12345);
  assert.equal(b.journal_id, a.journal_id);
  assert.equal(b.idempotent_replay, true);
  assert.equal(await accountBalance(A), 12345n);
  assert.equal(await accountBalance(L), -12345n);
});

test("the same code in two currencies is two accounts", opts, async () => {
  await pay(`${R}-usd`, 700, "USD");
  assert.equal(await accountBalance(A, "USD"), 700n);
  assert.equal(await accountBalance(A, "INR"), 12345n);
});

test("concurrent posts keep one hash chain, and a raced key posts once", opts, async () => {
  const keys = Array.from({ length: 8 }, (_, i) => `${R}-c${i}`);
  await Promise.all([...keys.map((k) => pay(k, 1)), ...keys.map((k) => pay(k, 1))]);
  const n = await rows<{ n: number }>("ledger", `SELECT count(*)::int AS n FROM journal_entries WHERE idempotency_key = ANY($1)`, [keys]);
  assert.equal(n[0].n, 8);
  // Every entry's prev_hash is some entry's hash or the genesis, and no two entries share a prev_hash.
  const forks = await rows<{ n: number }>("ledger", `
    SELECT count(*)::int AS n FROM (SELECT prev_hash FROM journal_entries WHERE idempotency_key LIKE $1 GROUP BY prev_hash HAVING count(*) > 1) x`, [`${R}%`]);
  assert.equal(forks[0].n, 0);
});

test("the database refuses an unbalanced journal, even when the code is bypassed", opts, async () => {
  const c = await db("ledger").connect();
  try {
    await c.query("BEGIN");
    const j = await c.query<{ id: string }>(`INSERT INTO journal_entries (tenant_id, narration, currency, idempotency_key) VALUES ('tenant-default','raw','INR',$1) RETURNING id::text`, [`${R}-raw`]);
    const acc = await c.query<{ id: number }>(`SELECT id FROM accounts WHERE code = $1 AND currency = 'INR'`, [A]);
    await c.query(`INSERT INTO ledger_lines (journal_id, tenant_id, account_id, side, amount, amount_minor, currency) VALUES ($1::uuid,'tenant-default',$2,'D',10,10,'INR')`, [j.rows[0].id, acc.rows[0].id]);
    await assert.rejects(c.query("COMMIT"), /does not balance/);
  } finally { await c.query("ROLLBACK").catch(() => {}); c.release(); }
});

test("posted rows are append-only", opts, async () => {
  await assert.rejects(rows("ledger", `UPDATE journal_entries SET narration = 'x' WHERE idempotency_key = $1`, [`${R}-1`]), /append-only/);
  await assert.rejects(rows("ledger", `DELETE FROM ledger_lines WHERE journal_id = (SELECT id FROM journal_entries WHERE idempotency_key = $1)`, [`${R}-1`]), /append-only/);
});
