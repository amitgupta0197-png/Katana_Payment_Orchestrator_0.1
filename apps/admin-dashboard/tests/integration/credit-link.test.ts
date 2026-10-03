// Linking a captured payment to one of two open orders of its amount, by hand (lib/credit-link-store).
// Run with `pnpm test:integration`. IT WRITES ROWS, so it only runs against a local database and
// removes the orders and credits it created.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rows } from "@/lib/pg";
import { createKatanaOrder } from "@/lib/katana-order";
import { setProviderFlow } from "@/lib/payin-flow-store";
import { ingestTxnAlert } from "@/lib/txn-reconcile";
import { possibleOrders } from "@/lib/credit-link";
import { LinkError, linkCreditToOrder, openOrdersForLinking } from "@/lib/credit-link-store";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };
const PROVIDER = process.env.TEST_PROVIDER_ID ?? "a0000000-0000-0000-0000-000000000001";
const BANKER = process.env.TEST_BANKER ?? "M10001";
const BY = "integration-test@local";
const R = String(Date.now()).slice(-9);
const AMOUNT = Number(`6${R.slice(-3)}.37`);   // an amount no other order uses
const RRN = `905${R}`;

async function cleanup() {
  await rows("vendorGateway", "DELETE FROM vendor_recon_audit WHERE actor = $1", [BY]).catch(() => {});
  await rows("vendorGateway", "DELETE FROM vendor_manual_cases WHERE alert_id IN (SELECT id FROM vendor_txn_alerts WHERE merchant_id = $1 AND amount = $2)", [BANKER, AMOUNT]).catch(() => {});
  await rows("vendorGateway", "DELETE FROM vendor_txn_alerts WHERE merchant_id = $1 AND amount = $2", [BANKER, AMOUNT]);
  await rows("vendorGateway", "DELETE FROM vendor_payin_orders WHERE order_id LIKE 'ITEST-LINK-%'");
}
before(async () => { if (LOCAL) { await cleanup(); await setProviderFlow(PROVIDER, { flow: "P2P", by: BY }); } });
after(async () => {
  if (LOCAL) {
    await cleanup();
    await setProviderFlow(PROVIDER, { flow: "UNSET", by: BY });
    await rows("provider", "DELETE FROM provider_payin_flow_history WHERE changed_by = $1", [BY]);
    await rows("provider", "UPDATE providers SET payin_flow_set_by = NULL, payin_flow_set_at = NULL WHERE payin_flow_set_by = $1", [BY]);
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
});

test("a payment two open orders could take is linked by hand to the one chosen", opts, async () => {
  const a = (await createKatanaOrder({ orderId: `ITEST-LINK-A-${R}`, amount: AMOUNT, currency: "INR", merchantId: BANKER, livemode: true, flow: "P2P" })).order!;
  const b = (await createKatanaOrder({ orderId: `ITEST-LINK-B-${R}`, amount: AMOUNT, currency: "INR", merchantId: BANKER, livemode: true, flow: "P2P" })).order!;

  // The reconciler does not choose between two orders of the same amount.
  const res = await ingestTxnAlert({ source: "DEVICE", merchant_id: BANKER, amount: AMOUNT, utr: RRN, bank: "PAYTM", raw: `RRN ${RRN}`, nonce: `n-link-${R}` });
  assert.notEqual(res.outcome, "CONFIRMED");
  const alertId = res.alert_id!;
  const credit = (await rows<{ received_at: string }>("vendorGateway", "SELECT COALESCE(event_time, created_at) AS received_at FROM vendor_txn_alerts WHERE id = $1::uuid", [alertId]))[0];

  const offered = possibleOrders({ amount: AMOUNT, received_at: credit.received_at }, await openOrdersForLinking(BANKER)).map((o) => o.id);
  assert.deepEqual(offered.sort(), [a.id, b.id].sort());

  // An order of another amount is refused.
  await assert.rejects(linkCreditToOrder({ code: BANKER, alertId, orderId: "00000000-0000-0000-0000-000000000000", actor: BY }), (e) => e instanceof LinkError && e.status === 409);

  const linked = await linkCreditToOrder({ code: BANKER, alertId, orderId: b.id, actor: BY });
  assert.equal(linked.order_id, b.order_id);
  const [ob] = await rows<{ status: string; rrn: string }>("vendorGateway", "SELECT status, COALESCE(rrn,'') AS rrn FROM vendor_payin_orders WHERE id = $1::uuid", [b.id]);
  assert.deepEqual([ob.status, ob.rrn], ["SUCCESS", RRN]);
  const [oa] = await rows<{ status: string }>("vendorGateway", "SELECT status FROM vendor_payin_orders WHERE id = $1::uuid", [a.id]);
  assert.equal(oa.status, "PENDING", "the other order is untouched");
  const [al] = await rows<{ outcome: string; ref: string }>("vendorGateway", "SELECT outcome, matched_order_ref AS ref FROM vendor_txn_alerts WHERE id = $1::uuid", [alertId]);
  assert.deepEqual([al.outcome, al.ref], ["CONFIRMED", b.order_id]);

  // Once linked it cannot be linked again, and the paid order is no longer offered.
  await assert.rejects(linkCreditToOrder({ code: BANKER, alertId, orderId: a.id, actor: BY }), (e) => e instanceof LinkError && e.status === 409);
  assert.ok(!(await openOrdersForLinking(BANKER)).some((o) => o.id === b.id));
});
