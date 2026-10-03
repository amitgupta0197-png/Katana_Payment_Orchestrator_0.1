// A pay-in's status against a real database: expiry, a late payment on an expired order, and
// confirmations that land together. Run with `pnpm test:integration`.
//
// IT WRITES ROWS, so it only runs against a local database (PG_HOST localhost / 127.0.0.1) and
// removes everything it created. Same seed merchant and banker as payin-flow.test.ts.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rows } from "@/lib/pg";
import { setProviderFlow } from "@/lib/payin-flow-store";
import { createKatanaOrder, confirmKatanaOrder } from "@/lib/katana-order";
import { readOrderStatus } from "@/lib/pay-status";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const PROVIDER = process.env.TEST_PROVIDER_ID ?? "a0000000-0000-0000-0000-000000000001";
const BANKER = process.env.TEST_BANKER ?? "M10001";
const BY = "integration-test@local";
const PREFIX = "ITEST-STATUS-";
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };
let n = 0;

async function order(): Promise<string> {
  const r = await createKatanaOrder({ orderId: `${PREFIX}${Date.now()}-${n++}`, amount: 101, currency: "INR", merchantId: BANKER, livemode: true, flow: "P2P" });
  return r.order.id as string;
}
const age = (id: string, minutes: number) =>
  rows("vendorGateway", `UPDATE vendor_payin_orders SET created_at = now() - make_interval(mins => $2::int) WHERE id = $1::uuid`, [id, minutes]);
const row = async (id: string) => (await rows<{ status: string; rrn: string | null; meta: Record<string, any> }>(
  "vendorGateway", "SELECT status, rrn, meta FROM vendor_payin_orders WHERE id = $1::uuid", [id]))[0];
const confirm = (id: string, utr: string) =>
  confirmKatanaOrder({ id, outcome: "SUCCESS", utr, evidence: "UTR", actor: BY, livemode: true });

async function cleanup() {
  await setProviderFlow(PROVIDER, { flow: "UNSET", by: BY });
  await rows("provider", "DELETE FROM provider_payin_flow_history WHERE changed_by = $1", [BY]);
  await rows("provider", "UPDATE providers SET payin_flow_set_by = NULL, payin_flow_set_at = NULL WHERE payin_flow_set_by = $1", [BY]);
  await rows("vendorGateway", `DELETE FROM vendor_payin_orders WHERE order_id LIKE '${PREFIX}%'`);
}

before(async () => { if (LOCAL) { await cleanup(); await setProviderFlow(PROVIDER, { flow: "P2P", by: BY }); } });
after(async () => { if (LOCAL) await cleanup(); setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref(); });

test("an order unpaid past the limit expires; a payment that lands later revives it", opts, async () => {
  const id = await order();
  assert.equal((await readOrderStatus(id))?.status, "PENDING");
  await age(id, 20);
  const expired = await readOrderStatus(id);
  assert.deepEqual([expired?.status, expired?.terminal], ["EXPIRED", true]);

  const utr = `ITESTUTR${Date.now()}`;
  const c = await confirm(id, utr);
  assert.deepEqual([c.ok, c.idempotent ?? false, c.order?.status], [true, false, "SUCCESS"]);

  const o = await row(id);
  assert.deepEqual([o.status, o.rrn, o.meta.review, o.meta.confirmation?.by], ["SUCCESS", utr, "CONFIRMED", BY]);
  assert.ok(o.meta.revived_from_expired?.at);
  // The confirmation is merged into the stored meta, not written over it.
  assert.ok(o.meta.upi_intent && o.meta.deeplinks);

  const paid = await readOrderStatus(id);
  assert.deepEqual([paid?.status, paid?.rrn, paid?.completed_at], ["SUCCESS", utr, o.meta.confirmation.at]);
});

test("a gateway order waits out its confirmation window before it expires; the customer's time stays 15 minutes", opts, async () => {
  // A gateway that exists nowhere: the status read asks it, gets no answer, and carries on.
  process.env.PAYIN_CONFIRM_WINDOW_SECONDS_ITESTGW = "1800";
  try {
    const id = await order();
    await rows("vendorGateway", `UPDATE vendor_payin_orders SET meta = COALESCE(meta,'{}'::jsonb) || '{"gateway":{"provider":"ITESTGW"}}'::jsonb WHERE id = $1::uuid`, [id]);
    const fresh = await readOrderStatus(id);
    assert.deepEqual([fresh?.status, fresh?.confirming, fresh?.confirm_until], ["PENDING", false, null]);

    await age(id, 20);   // past the customer's 15 minutes, inside the 30-minute window
    const waiting = await readOrderStatus(id);
    assert.deepEqual([waiting?.status, waiting?.terminal, waiting?.confirming], ["PENDING", false, true]);
    assert.ok(waiting?.confirm_until && new Date(waiting.confirm_until).getTime() > Date.now());
    assert.equal((await row(id)).status, "PENDING");

    await age(id, 46);   // past both
    const expired = await readOrderStatus(id);
    assert.deepEqual([expired?.status, expired?.confirming], ["EXPIRED", false]);

    // An order with no gateway has no window, whatever is set.
    const p2p = await order();
    await age(p2p, 20);
    assert.equal((await readOrderStatus(p2p))?.status, "EXPIRED");
  } finally { delete process.env.PAYIN_CONFIRM_WINDOW_SECONDS_ITESTGW; }
});

test("a paid order is never expired afterwards, however old it gets", opts, async () => {
  const id = await order();
  assert.equal((await confirm(id, `ITESTUTR${Date.now()}A`)).ok, true);
  await age(id, 60);
  assert.equal((await readOrderStatus(id))?.status, "SUCCESS");
  assert.equal((await row(id)).status, "SUCCESS");
});

test("confirmations that land together settle the order once", opts, async () => {
  const id = await order();
  const utr = `ITESTUTR${Date.now()}B`;
  const all = await Promise.all([confirm(id, utr), confirm(id, utr), confirm(id, utr)]);
  assert.ok(all.every((r) => r.ok));
  assert.equal(all.filter((r) => !r.idempotent).length, 1);
  assert.deepEqual([(await row(id)).status, (await row(id)).rrn], ["SUCCESS", utr]);
});

const fail = (id: string) => confirmKatanaOrder({ id, outcome: "FAILED", evidence: "MANUAL", actor: BY, livemode: true });

test("a failed order that is then paid is revived; a repeated failure changes nothing", opts, async () => {
  const id = await order();
  assert.equal((await fail(id)).ok, true);
  assert.deepEqual([(await fail(id)).idempotent, (await row(id)).status], [true, "FAILED"]);
  const utr = `ITESTUTR${Date.now()}C`;
  const late = await confirm(id, utr);
  assert.deepEqual([late.ok, late.order?.status], [true, "SUCCESS"]);
  const o = await row(id);
  assert.deepEqual([o.status, o.rrn, !!o.meta.revived_from_failed?.at], ["SUCCESS", utr, true]);
});

test("a paid order is final: it cannot be failed, and an expired one cannot be failed either", opts, async () => {
  const paid = await order();
  assert.equal((await confirm(paid, `ITESTUTR${Date.now()}D`)).ok, true);
  assert.deepEqual([(await fail(paid)).status, (await row(paid)).status], [409, "SUCCESS"]);

  const lapsed = await order();
  await age(lapsed, 20);
  assert.equal((await readOrderStatus(lapsed))?.status, "EXPIRED");
  assert.deepEqual([(await fail(lapsed)).status, (await row(lapsed)).status], [409, "EXPIRED"]);
});
