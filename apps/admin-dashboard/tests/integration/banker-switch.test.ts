// The banker switch on real orders (vendorGateway 0042, lib/banker-switch-store, createKatanaOrder):
// an order signed with one banker's Key is taken by the banker the merchant's switch picks, a
// banker that cannot take it is passed over, a replay finds the order wherever it went, and racing
// requests create one order. Run with `pnpm test:integration`. IT WRITES ROWS, so it only runs
// against a local database; the test merchant's switch and its banker's stage are put back as they were.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rows } from "@/lib/pg";
import { createKatanaOrder } from "@/lib/katana-order";
import { setProviderFlow } from "@/lib/payin-flow-store";
import { listSwitchEvents, pinBanker, saveMember, saveSwitchSettings } from "@/lib/banker-switch-store";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };
const PROVIDER = process.env.TEST_PROVIDER_ID ?? "a0000000-0000-0000-0000-000000000001";
const A = process.env.TEST_BANKER ?? "M10001";        // signs every order
const B = process.env.TEST_BANKER_2 ?? "M10002";      // the merchant's other banker
const BY = "integration-test-banker-switch@local";
const R = String(Date.now()).slice(-7);
const PREFIX = "ITEST-BSW-";
let n = 0;
const ref = () => `${PREFIX}${R}-${n++}`;
let savedStage: string | null = null;

async function cleanup() {
  await rows("vendorGateway", `ALTER TABLE payin_banker_switch_events DISABLE TRIGGER payin_banker_switch_events_locked_trg`);
  try { await rows("vendorGateway", `DELETE FROM payin_banker_switch_events WHERE provider_id = $1`, [PROVIDER]); }
  finally { await rows("vendorGateway", `ALTER TABLE payin_banker_switch_events ENABLE TRIGGER payin_banker_switch_events_locked_trg`); }
  await rows("vendorGateway", `DELETE FROM payin_banker_switch_members WHERE provider_id = $1`, [PROVIDER]);
  await rows("vendorGateway", `DELETE FROM payin_banker_switch WHERE provider_id = $1`, [PROVIDER]);
  await rows("vendorGateway", `DELETE FROM vendor_payin_orders WHERE order_id LIKE '${PREFIX}%'`);
}
const setStage = (stage: string | null) => rows("merchant", `UPDATE merchants SET stage = $2 WHERE merchant_code = $1`, [B, stage]);

before(async () => {
  if (!LOCAL) return;
  await cleanup();
  savedStage = (await rows<{ s: string | null }>("merchant", `SELECT stage AS s FROM merchants WHERE merchant_code = $1`, [B]))[0]?.s ?? null;
  await setProviderFlow(PROVIDER, { flow: "P2P", by: BY });
});
after(async () => {
  if (LOCAL) {
    await cleanup();
    await setStage(savedStage);
    await setProviderFlow(PROVIDER, { flow: "UNSET", by: BY });
    await rows("provider", "DELETE FROM provider_payin_flow_history WHERE changed_by = $1", [BY]);
    await rows("provider", "UPDATE providers SET payin_flow_set_by = NULL, payin_flow_set_at = NULL WHERE payin_flow_set_by = $1", [BY]);
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
});

// A test-mode order signed with A's Key, as the order APIs make it.
const signedByA = (orderId = ref(), amount = 101) => createKatanaOrder({
  orderId, amount, currency: "INR", merchantId: A, livemode: false, flow: "P2P", routeAcrossBankers: true,
});
const stored = async (id: string) => (await rows<{ merchant_id: string; signed_by: string | null; meta_signed_by: string | null }>("vendorGateway",
  `SELECT merchant_id, signed_by, meta->>'signed_by' AS meta_signed_by FROM vendor_payin_orders WHERE id = $1::uuid`, [id]))[0];

test("switch off: the order is the signer's, as before", opts, async () => {
  const r = await signedByA();
  assert.equal(r.banker, A);
  const s = await stored(r.order.id);
  assert.equal(s.merchant_id, A);
  assert.equal(s.signed_by, null);
});

test("switched to B by hand: B takes A's order, and a replay finds it there", opts, async () => {
  await saveSwitchSettings(PROVIDER, { enabled: true, mode: "PRIORITY" }, BY);
  await pinBanker(PROVIDER, B, null, "test", BY);
  const txn = ref();
  const r = await signedByA(txn);
  assert.equal(r.banker, B);
  assert.equal(r.reused, false);
  const s = await stored(r.order.id);
  assert.equal(s.merchant_id, B);
  assert.equal(s.signed_by, A);
  assert.equal(s.meta_signed_by, A);   // the callback is A's (lib/merchant-callback)

  const again = await signedByA(txn);
  assert.equal(again.reused, true);
  assert.equal(again.order.id, r.order.id);
  assert.equal(again.banker, B);
  const ev = await listSwitchEvents(PROVIDER);
  assert.ok(ev.some((e) => e.action === "AUTO_SWITCH" && e.banker_code === B));
});

test("a banker that cannot take the order is passed over", opts, async () => {
  await setStage("SUSPENDED");
  try {
    const r = await signedByA();
    assert.equal(r.banker, A);
    const ev = await listSwitchEvents(PROVIDER);
    const passed = ev.find((e) => e.action === "PASSED_OVER");
    assert.ok(passed, "logged");
    assert.deepEqual((passed!.detail.passed_over as { banker: string; code: string }[]).map((p) => [p.banker, p.code]), [[B, "MERCHANT_SUSPENDED"]]);
  } finally { await setStage(savedStage); }
});

test("a txnid B already has (signed by B itself) passes the order to the next banker", opts, async () => {
  const txn = ref();
  const own = await createKatanaOrder({ orderId: txn, amount: 101, currency: "INR", merchantId: B, livemode: false, flow: "P2P" });
  assert.equal(own.banker, B);
  const r = await signedByA(txn);
  assert.equal(r.banker, A);
  assert.notEqual(r.order.id, own.order.id);
});

test("PRIORITY without a pin: lowest number first", opts, async () => {
  await pinBanker(PROVIDER, null, null, null, BY);
  await saveMember(PROVIDER, A, { priority: 5 }, BY);
  await saveMember(PROVIDER, B, { priority: 1 }, BY);
  assert.equal((await signedByA()).banker, B);
  await saveMember(PROVIDER, B, { in_rotation: false }, BY);
  assert.equal((await signedByA()).banker, A);
});

test("requests racing with the same txnid make one order", opts, async () => {
  await saveMember(PROVIDER, B, { in_rotation: true }, BY);
  await pinBanker(PROVIDER, B, null, null, BY);
  const txn = ref();
  const all = await Promise.all([signedByA(txn), signedByA(txn), signedByA(txn)]);
  assert.equal(new Set(all.map((r) => r.order.id)).size, 1);
  assert.equal(all.filter((r) => !r.reused).length, 1);
  const count = (await rows<{ n: number }>("vendorGateway", `SELECT COUNT(*)::int n FROM vendor_payin_orders WHERE order_id = $1`, [txn]))[0].n;
  assert.equal(count, 1);
});

test("nobody in rotation and no pin: the signer keeps its order", opts, async () => {
  await pinBanker(PROVIDER, null, null, null, BY);
  await saveMember(PROVIDER, A, { in_rotation: false }, BY);
  await saveMember(PROVIDER, B, { in_rotation: false }, BY);
  const r = await signedByA();
  assert.equal(r.banker, A);
  assert.equal((await stored(r.order.id)).signed_by, null);
});
