// "Unmatched payments" (lib/unmatched-store) against the local database: a banker login sees only its
// own payments, asks for a link that waits for staff, staff approve it through the existing link path
// (the order is paid with the payment's reference), and a payment is linked only once.
// Run with `pnpm test:integration`. IT WRITES ROWS, so it only runs against a local database and
// removes the orders, payments and reviews it created.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { db, rows } from "@/lib/pg";
import type { Session } from "@/lib/auth";
import { createKatanaOrder } from "@/lib/katana-order";
import { setProviderFlow } from "@/lib/payin-flow-store";
import { ingestTxnAlert } from "@/lib/txn-reconcile";
import { actOnUnmatched, listUnmatched, UnmatchedError } from "@/lib/unmatched-store";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };
const PROVIDER = process.env.TEST_PROVIDER_ID ?? "a0000000-0000-0000-0000-000000000001";
const BANKER = process.env.TEST_BANKER ?? "M10001";
const BY = "integration-test@local";
const R = String(Date.now()).slice(-9);
const AMOUNT = Number(`8${R.slice(-3)}.53`);
const AMOUNT2 = Number(`8${R.slice(-3)}.59`);   // no open order has it, so it stays unmatched
const UTR = `907${R}`;

const session = (persona: Session["persona"], scope_id: string | null, email = BY): Session =>
  ({ user_id: `itest-${persona}`, email, full_name: "Integration test", persona, scope_id, scope_label: "" } as Session);

async function cleanup() {
  await rows("vendorGateway", "DELETE FROM unmatched_credit_reviews WHERE merchant_id = $1 AND alert_id IN (SELECT id FROM vendor_txn_alerts WHERE merchant_id = $1 AND amount = $2)", [BANKER, AMOUNT]).catch(() => {});
  await rows("vendorGateway", "DELETE FROM vendor_recon_audit WHERE actor LIKE 'integration-test%'").catch(() => {});
  await rows("vendorGateway", "DELETE FROM vendor_manual_cases WHERE alert_id IN (SELECT id FROM vendor_txn_alerts WHERE merchant_id = $1 AND amount = $2)", [BANKER, AMOUNT]).catch(() => {});
  for (const amt of [AMOUNT, AMOUNT2]) {
    await rows("vendorGateway", "DELETE FROM unmatched_credit_reviews WHERE alert_id IN (SELECT id FROM vendor_txn_alerts WHERE merchant_id = $1 AND amount = $2)", [BANKER, amt]).catch(() => {});
    await rows("vendorGateway", "DELETE FROM vendor_manual_cases WHERE alert_id IN (SELECT id FROM vendor_txn_alerts WHERE merchant_id = $1 AND amount = $2)", [BANKER, amt]).catch(() => {});
    await rows("vendorGateway", "DELETE FROM vendor_txn_alerts WHERE merchant_id = $1 AND amount = $2", [BANKER, amt]);
  }
  await rows("vendorGateway", "DELETE FROM vendor_payin_orders WHERE order_id LIKE 'ITEST-UNM-%'");
}
before(async () => {
  if (!LOCAL) return;
  const c = await db("vendorGateway").connect();
  try { await c.query(readFileSync("../../tools/migrations/vendorGateway/0045_unmatched_reviews.sql", "utf8")); } finally { c.release(); }
  await cleanup();
  await setProviderFlow(PROVIDER, { flow: "P2P", by: BY });
});
after(async () => {
  if (LOCAL) {
    await cleanup();
    await setProviderFlow(PROVIDER, { flow: "UNSET", by: BY });
    await rows("provider", "DELETE FROM provider_payin_flow_history WHERE changed_by = $1", [BY]);
    await rows("provider", "UPDATE providers SET payin_flow_set_by = NULL, payin_flow_set_at = NULL WHERE payin_flow_set_by = $1", [BY]);
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
});

test("a banker asks for a link, staff approve it, and the order is paid once", opts, async () => {
  const a = (await createKatanaOrder({ orderId: `ITEST-UNM-A-${R}`, amount: AMOUNT, currency: "INR", merchantId: BANKER, livemode: true, flow: "P2P" })).order!;
  const b = (await createKatanaOrder({ orderId: `ITEST-UNM-B-${R}`, amount: AMOUNT, currency: "INR", merchantId: BANKER, livemode: true, flow: "P2P" })).order!;
  const res = await ingestTxnAlert({ source: "DEVICE", merchant_id: BANKER, amount: AMOUNT, utr: UTR, bank: "PAYTM", raw: `RRN ${UTR}`, nonce: `n-unm-${R}`, payer_vpa: "ankit.kumar@okaxis" } as never);
  assert.notEqual(res.outcome, "CONFIRMED", "two orders of the amount: the reconciler doesn't choose");
  const alertId = res.alert_id!;

  // The banker's own login sees it, masked, with both orders offered.
  const own = await listUnmatched(session("MERCHANT", BANKER, `${BY}-banker`));
  const p = own.payments.find((x) => x.id === alertId);
  assert.ok(p, "the banker sees its own unmatched payment");
  assert.deepEqual(p!.candidates.map((o) => o.id).sort(), [a.id, b.id].sort());
  assert.ok(!p!.payer || p!.payer.includes("***"), "the payer's UPI ID is masked");
  assert.equal(own.canLink, false);

  // Another banker's login can't see or touch it.
  const other = (await rows<{ code: string }>("merchant", "SELECT merchant_code AS code FROM merchants WHERE merchant_code <> $1 LIMIT 1", [BANKER]))[0];
  assert.ok(!(await listUnmatched(session("MERCHANT", other.code))).payments.some((x) => x.id === alertId));
  await assert.rejects(actOnUnmatched(session("MERCHANT", other.code), alertId, "not_order"), (e) => e instanceof UnmatchedError && e.status === 404);

  // The banker asks; nothing is paid yet; a second request waits behind the first.
  const asked = await actOnUnmatched(session("MERCHANT", BANKER, `${BY}-banker`), alertId, "link", { orderId: b.id });
  assert.match(asked.state, /Waiting for Katana/);
  assert.equal((await rows<{ status: string }>("vendorGateway", "SELECT status FROM vendor_payin_orders WHERE id = $1::uuid", [b.id]))[0].status, "PENDING");
  await assert.rejects(actOnUnmatched(session("MERCHANT", BANKER, `${BY}-banker`), alertId, "link", { orderId: a.id }), (e) => e instanceof UnmatchedError && e.status === 409);

  // Staff approve: the order is paid with the payment's reference, through the existing link path.
  const done = await actOnUnmatched(session("FINANCE", null, `${BY}-staff`), alertId, "approve");
  assert.match(done.state, /Linked to/);
  const [ob] = await rows<{ status: string; rrn: string }>("vendorGateway", "SELECT status, COALESCE(rrn,'') AS rrn FROM vendor_payin_orders WHERE id = $1::uuid", [b.id]);
  assert.deepEqual([ob.status, ob.rrn], ["SUCCESS", UTR]);
  assert.equal((await rows<{ status: string }>("vendorGateway", "SELECT status FROM vendor_payin_orders WHERE id = $1::uuid", [a.id]))[0].status, "PENDING");

  // Linked once: it leaves the queue and can't be linked again.
  assert.ok(!(await listUnmatched(session("SUPER_ADMIN", null), { banker: BANKER })).payments.some((x) => x.id === alertId));
  await assert.rejects(actOnUnmatched(session("SUPER_ADMIN", null), alertId, "link", { orderId: a.id }), (e) => e instanceof UnmatchedError && e.status === 409);
});

test("'not an order payment' takes it off the queue; staff can undo it", opts, async () => {
  const res = await ingestTxnAlert({ source: "DEVICE", merchant_id: BANKER, amount: AMOUNT2, utr: `${UTR}9`, bank: "PAYTM", raw: `RRN ${UTR}9`, nonce: `n-unm2-${R}` });
  const alertId = res.alert_id!;
  await actOnUnmatched(session("MERCHANT", BANKER), alertId, "not_order");
  assert.ok(!(await listUnmatched(session("MERCHANT", BANKER))).payments.some((x) => x.id === alertId));
  assert.ok((await listUnmatched(session("SUPER_ADMIN", null), { banker: BANKER, showMarked: true })).payments.some((x) => x.id === alertId));
  await assert.rejects(actOnUnmatched(session("MERCHANT", BANKER), alertId, "undo"), (e) => e instanceof UnmatchedError && e.status === 409);
  await actOnUnmatched(session("SUPER_ADMIN", null), alertId, "undo");
  assert.ok((await listUnmatched(session("MERCHANT", BANKER))).payments.some((x) => x.id === alertId));
});
