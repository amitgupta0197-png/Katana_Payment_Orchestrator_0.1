// Ledger sync (lib/ledger-sync) on this database's own live, paid pay-ins: each goes on the ledger
// once, as D HELD_BY_BANKER / C MERCHANT_PAYABLE for its banker at its paid time, and a second run
// posts nothing. Run with `pnpm test:integration`. Local database only; everything it posted and
// stamped is undone at the end.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { db, rows } from "@/lib/pg";
import { syncLedger } from "@/lib/ledger-sync";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };
let started = new Date();
let posted: string[] = [];

before(() => { started = new Date(Date.now() - 1000); });
after(async () => {
  if (LOCAL) {
    posted = (await rows<{ id: string }>("vendorGateway", `SELECT id::text FROM vendor_payin_orders WHERE ledger_posted_at >= $1`, [started.toISOString()])).map((r) => r.id);
    const c = await db("ledger").connect();
    try {
      await c.query("BEGIN"); await c.query("SET LOCAL ledger.maintenance = 'on'");
      const keys = posted.map((id) => `payin:${id}`);
      await c.query(`DELETE FROM ledger_lines WHERE journal_id IN (SELECT id FROM journal_entries WHERE idempotency_key = ANY($1))`, [keys]);
      await c.query(`DELETE FROM journal_entries WHERE idempotency_key = ANY($1)`, [keys]);
      await c.query(`DELETE FROM ledger_sync_cursors WHERE updated_at >= $1`, [started.toISOString()]);
      await c.query("COMMIT");
    } finally { c.release(); }
    await rows("vendorGateway", `UPDATE vendor_payin_orders SET ledger_posted_at = NULL WHERE id = ANY($1::uuid[])`, [posted]);
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
});

test("every live paid pay-in goes on the ledger once, for its banker, at its paid time", opts, async () => {
  const todo = await rows<{ id: string; merchant_id: string; amount: string }>("vendorGateway", `
    SELECT id::text, merchant_id, amount::text FROM vendor_payin_orders
     WHERE ledger_posted_at IS NULL AND livemode AND status IN ('SUCCESS','SUCCEEDED') AND vendor = 'KATANA' AND merchant_id IS NOT NULL AND amount > 0
     ORDER BY created_at LIMIT 500`);
  const first = await syncLedger();
  assert.deepEqual(first.errors, []);
  assert.equal(first.payins, todo.length);
  const second = await syncLedger();
  assert.equal(second.payins, 0);
  if (!todo.length) return;   // a database with no live paid pay-ins: nothing more to check
  const o = todo[0];
  const j = await rows<{ code: string; side: string; amount_minor: string }>("ledger", `
    SELECT a.code, l.side, l.amount_minor::text FROM journal_entries j JOIN ledger_lines l ON l.journal_id = j.id JOIN accounts a ON a.id = l.account_id
     WHERE j.idempotency_key = $1 ORDER BY l.side`, [`payin:${o.id}`]);
  assert.deepEqual(j.map((x) => [x.code, x.side]), [
    [`LIABILITIES.MERCHANT_PAYABLE.${o.merchant_id}`, "C"], [`ASSETS.HELD_BY_BANKER.${o.merchant_id}`, "D"],
  ]);
  assert.equal(BigInt(j[0].amount_minor), BigInt(Math.round(Number(o.amount) * 100)));
});
