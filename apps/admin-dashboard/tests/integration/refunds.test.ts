// Refunds against a real database: who may refund what, and how much. Run with `pnpm test:integration`.
//
// IT WRITES ROWS, so it only runs against a local database (PG_HOST localhost / 127.0.0.1). It
// removes its orders and refunds; the ledger is append-only, so the journals it posts stay,
// under merchant codes no real merchant has.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rows } from "@/lib/pg";
import { createRefund, RefundError } from "@/lib/refunds";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };
const A = "ITEST-RF-A", B = "ITEST-RF-B";
const RUN = Date.now();
let n = 0;

async function paidOrder(merchant: string, amountMinor: number, livemode = true): Promise<string> {
  const txn = `ITEST-RF-${RUN}-${n++}`;
  await rows("checkout", `
    INSERT INTO checkout_orders (tenant_id, merchant_id, client_ref, txn_id, amount, amount_minor, currency, method, status, idempotency_key, selected_rail, livemode)
    VALUES ('tenant-default', $1, 'itest', $2, $3, $4, 'INR', 'UPI_INTENT', 'SUCCESS', $2, 'itest', $5)
  `, [merchant, txn, amountMinor / 100, amountMinor, livemode]);
  return txn;
}
const refund = (txnId: string, amountMinor: number | string, merchantScope: string[] | null = null) =>
  createRefund({ txnId, amountMinor, reason: "itest", requestedBy: "itest@local", merchantScope })
    .then((r) => ({ ok: true as const, ...r }), (e: Error) => ({ ok: false as const, error: e.message, known: e instanceof RefundError }));
const orderStatus = async (txn: string) => (await rows<{ status: string }>("checkout", "SELECT status FROM checkout_orders WHERE txn_id = $1", [txn]))[0].status;

async function cleanup() {
  const ids = `(SELECT id FROM checkout_orders WHERE merchant_id IN ('${A}','${B}'))`;
  await rows("checkout", `DELETE FROM refunds WHERE merchant_id IN ('${A}','${B}')`);
  await rows("checkout", `DELETE FROM order_state_transitions WHERE order_id IN ${ids}`).catch(() => {});
  await rows("checkout", `DELETE FROM checkout_orders WHERE merchant_id IN ('${A}','${B}')`);
}
before(async () => { if (LOCAL) await cleanup(); });
after(async () => { if (LOCAL) await cleanup(); setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref(); });

test("a banker cannot refund another merchant's order, and is not told it exists", opts, async () => {
  const theirs = await paidOrder(B, 10_000);
  const r = await refund(theirs, 1_000, [A]);
  assert.deepEqual([r.ok, !r.ok && r.error, !r.ok && r.known], [false, "order not found", true]);
  assert.equal(await orderStatus(theirs), "SUCCESS");
  assert.equal((await rows("checkout", "SELECT 1 FROM refunds WHERE txn_id = $1", [theirs])).length, 0);
  // Its own order, and Katana staff (no scope) on any order, go through.
  assert.equal((await refund(await paidOrder(A, 10_000), 1_000, [A])).ok, true);
  assert.equal((await refund(theirs, 1_000)).ok, true);
});

test("partial refunds add up, and cannot pass what was paid", opts, async () => {
  const txn = await paidOrder(A, 10_000);
  const first = await refund(txn, 6_000);
  assert.deepEqual([first.ok, first.ok && first.new_order_state], [true, "PARTIALLY_REFUNDED"]);
  const over = await refund(txn, 5_000);
  assert.equal(over.ok, false);
  assert.match(!over.ok ? over.error : "", /exceeds what is left of the order: ₹60.00 of ₹100.00 is already refunded/);
  const rest = await refund(txn, 4_000);
  assert.deepEqual([rest.ok, rest.ok && rest.new_order_state], [true, "REFUNDED"]);
  const again = await refund(txn, 1);
  assert.match(!again.ok ? again.error : "", /cannot refund from status REFUNDED/);
});

test("two refunds of the same amount are two refunds, each with its own journal", opts, async () => {
  const txn = await paidOrder(A, 10_000);
  const a = await refund(txn, 2_500), b = await refund(txn, 2_500);
  assert.equal(a.ok && b.ok, true);
  assert.notEqual(a.ok && a.journal_id, b.ok && b.journal_id);
  const sum = await rows<{ s: string }>("checkout", "SELECT SUM(amount_minor)::text AS s FROM refunds WHERE txn_id = $1 AND status = 'POSTED'", [txn]);
  assert.equal(sum[0].s, "5000");
});

test("refunds arriving together cannot pass the order amount between them", opts, async () => {
  const txn = await paidOrder(A, 10_000);
  const got = await Promise.all(Array.from({ length: 6 }, () => refund(txn, 3_000)));
  assert.equal(got.filter((g) => g.ok).length, 3);                      // 9,000 of 10,000; a fourth would pass it
  const sum = await rows<{ s: string }>("checkout", "SELECT SUM(amount_minor)::text AS s FROM refunds WHERE txn_id = $1 AND status IN ('PENDING','POSTED')", [txn]);
  assert.equal(sum[0].s, "9000");
});

test("a refund must be a positive whole number of paise, on a live paid order", opts, async () => {
  const txn = await paidOrder(A, 10_000);
  for (const bad of [0, -500, "12.5", "abc", "-1"]) {
    const r = await refund(txn, bad);
    assert.deepEqual([r.ok, !r.ok && r.known], [false, true], String(bad));
  }
  assert.equal(await orderStatus(txn), "SUCCESS");
  const test = await refund(await paidOrder(A, 10_000, false), 1_000);
  assert.match(!test.ok ? test.error : "", /test orders cannot be refunded/);
  assert.deepEqual(await refund("ITEST-RF-no-such-order", 100), { ok: false, error: "order not found", known: true });
});
