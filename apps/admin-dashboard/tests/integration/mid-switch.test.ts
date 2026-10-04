// The MID switch on real orders (vendorGateway 0040, lib/mid-switch-store, createKatanaOrder):
// P2P orders of one banker spread over its own UPI IDs by priority, limits, hours, the manual
// switch and the weighted split; refused when none can take them; limits held when orders arrive
// together. Run with `pnpm test:integration`. IT WRITES ROWS, so it only runs against a local
// database, and it puts the banker's UPI IDs back as they were.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rows } from "@/lib/pg";
import { createKatanaOrder } from "@/lib/katana-order";
import { setProviderFlow } from "@/lib/payin-flow-store";
import { addMid, listMidEvents, pinMid, saveSettings, setMidStatus, updateMid } from "@/lib/mid-switch-store";
import { NoMidAvailableError } from "@/lib/mid-switch";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };
const PROVIDER = process.env.TEST_PROVIDER_ID ?? "a0000000-0000-0000-0000-000000000001";
const BANKER = process.env.TEST_BANKER ?? "M10001";
const BY = "integration-test-mid@local";
const R = String(Date.now()).slice(-7);
const PREFIX = "ITEST-MID-";
const UPI_A = `itest-a-${R}@upi`, UPI_B = `itest-b-${R}@upi`;
let n = 0;
let savedConfig: unknown = null;

async function cleanup() {
  await rows("vendorGateway", `ALTER TABLE payin_mid_events DISABLE TRIGGER payin_mid_events_locked_trg`);
  try { await rows("vendorGateway", `DELETE FROM payin_mid_events WHERE banker_code = $1`, [BANKER]); }
  finally { await rows("vendorGateway", `ALTER TABLE payin_mid_events ENABLE TRIGGER payin_mid_events_locked_trg`); }
  await rows("vendorGateway", `DELETE FROM payin_mid_settings WHERE banker_code = $1`, [BANKER]);
  await rows("vendorGateway", `DELETE FROM vendor_payin_orders WHERE order_id LIKE '${PREFIX}%'`);
  await rows("vendorGateway", `DELETE FROM payin_mids WHERE banker_code = $1`, [BANKER]);
}
before(async () => {
  if (!LOCAL) return;
  await cleanup();
  savedConfig = (await rows<{ k: unknown }>("merchant", `SELECT katana_pay AS k FROM merchant_payment_config WHERE merchant_code = $1`, [BANKER]))[0]?.k ?? null;
  // The banker's UPI IDs: two more beside its primary one.
  await rows("merchant", `UPDATE merchant_payment_config SET katana_pay = COALESCE(katana_pay, '{}'::jsonb) || jsonb_build_object('settlement_vpas', $2::jsonb)
                           WHERE merchant_code = $1`, [BANKER, JSON.stringify([UPI_A, UPI_B])]);
  await setProviderFlow(PROVIDER, { flow: "P2P", by: BY });
});
after(async () => {
  if (LOCAL) {
    await cleanup();
    await rows("merchant", `UPDATE merchant_payment_config SET katana_pay = $2::jsonb WHERE merchant_code = $1`, [BANKER, JSON.stringify(savedConfig)]);
    await setProviderFlow(PROVIDER, { flow: "UNSET", by: BY });
    await rows("provider", "DELETE FROM provider_payin_flow_history WHERE changed_by = $1", [BY]);
    await rows("provider", "UPDATE providers SET payin_flow_set_by = NULL, payin_flow_set_at = NULL WHERE payin_flow_set_by = $1", [BY]);
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
});

const order = (amount = 101) => createKatanaOrder({ orderId: `${PREFIX}${R}-${n++}`, amount, currency: "INR", merchantId: BANKER, livemode: true, flow: "P2P" });
const paidTo = async (id: string) => (await rows<{ v: string; mid: string | null }>("vendorGateway",
  `SELECT meta->>'receiver_vpa' AS v, payin_mid_id::text AS mid FROM vendor_payin_orders WHERE id = $1::uuid`, [id]))[0];

test("with no MIDs a banker is paid on its primary UPI ID, as before", opts, async () => {
  const o = await order();
  const p = await paidTo(o.order.id);
  assert.equal(p.mid, null);
  assert.notEqual(p.v, UPI_A);
});

test("only a UPI ID set up on the banker can be a MID", opts, async () => {
  await assert.rejects(addMid({ banker: BANKER, kind: "UPI", upi_id: "not-theirs@upi" }, BY), /not set up/);
});

test("priority, then the next when a limit is used, with the switch logged", opts, async () => {
  const a = await addMid({ banker: BANKER, kind: "UPI", upi_id: UPI_A, name: "A", priority: 1, daily_count: 2 }, BY);
  const b = await addMid({ banker: BANKER, kind: "UPI", upi_id: UPI_B, name: "B", priority: 2 }, BY);
  const o1 = await order(), o2 = await order(), o3 = await order();
  assert.deepEqual([(await paidTo(o1.order.id)).v, (await paidTo(o2.order.id)).v, (await paidTo(o3.order.id)).v], [UPI_A, UPI_A, UPI_B]);
  assert.equal((await paidTo(o3.order.id)).mid, b.id);
  const ev = await listMidEvents(BANKER);
  const sw = ev.find((e) => e.action === "AUTO_SWITCH");
  assert.ok(sw, "the automatic switch is logged");
  assert.deepEqual([sw!.detail.from, sw!.detail.to], ["A", "B"]);
  // The order keeps the other UPI IDs that could take it as backups.
  const pool = (await rows<{ p: { vpa: string }[] }>("vendorGateway", `SELECT meta->'vpa_pool' AS p FROM vendor_payin_orders WHERE id = $1::uuid`, [o1.order.id]))[0].p;
  assert.deepEqual(pool.map((x) => x.vpa), [UPI_A, UPI_B]);

  // The manual switch: B while it can take the order, even though A is first.
  await updateMid(a.id, { daily_count: null }, BY);
  await pinMid(BANKER, "UPI", b.id, 60, "test", BY);
  assert.equal((await paidTo((await order()).order.id)).v, UPI_B);
  await pinMid(BANKER, "UPI", null, null, null, BY);
  assert.equal((await paidTo((await order()).order.id)).v, UPI_A);

  // Outside A's hours, B takes it.
  const nowIst = new Date(Date.now() + 330 * 60_000);
  const hh = (h: number) => String((h + 24) % 24).padStart(2, "0") + ":00";
  await updateMid(a.id, { active_from: hh(nowIst.getUTCHours() + 2), active_to: hh(nowIst.getUTCHours() + 3) }, BY);
  assert.equal((await paidTo((await order()).order.id)).v, UPI_B);
  await updateMid(a.id, { active_from: null, active_to: null }, BY);

  // Weighted: all weight on B.
  await saveSettings(BANKER, "UPI", { mode: "WEIGHTED" }, BY);
  await updateMid(a.id, { weight: 0 }, BY);
  assert.equal((await paidTo((await order()).order.id)).v, UPI_B);
  await saveSettings(BANKER, "UPI", { mode: "PRIORITY" }, BY);

  // Both paused: refused, never sent to another banker or the primary UPI ID.
  await setMidStatus(a.id, "PAUSED", "test", BY);
  await setMidStatus(b.id, "PAUSED", "test", BY);
  await assert.rejects(order(), (e) => e instanceof NoMidAvailableError && e.code === "NO_ACCOUNT_AVAILABLE");
  assert.ok((await listMidEvents(BANKER)).some((e) => e.action === "NONE_AVAILABLE"));

  // Switched off: routed as before.
  await saveSettings(BANKER, "UPI", { enabled: false }, BY);
  assert.equal((await paidTo((await order()).order.id)).mid, null);
  await saveSettings(BANKER, "UPI", { enabled: true }, BY);
  await setMidStatus(a.id, "ACTIVE", null, BY);
  await setMidStatus(b.id, "ACTIVE", null, BY);
});

test("a MID's day limit holds when orders arrive together", opts, async () => {
  await rows("vendorGateway", `UPDATE payin_mids SET status = 'PAUSED' WHERE banker_code = $1 AND upi_id = $2`, [BANKER, UPI_B]);
  await rows("vendorGateway", `UPDATE payin_mids SET daily_count = NULL, daily_amount = NULL, priority = 1 WHERE banker_code = $1 AND upi_id = $2`, [BANKER, UPI_A]);
  // Room for exactly two more 7.77 orders today.
  const used = (await rows<{ s: number }>("vendorGateway", `
    SELECT COALESCE(SUM(amount),0)::float AS s FROM vendor_payin_orders WHERE payin_mid_id = (SELECT id FROM payin_mids WHERE banker_code = $1 AND upi_id = $2)
       AND livemode AND status NOT IN ('FAILED','EXPIRED')
       AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`, [BANKER, UPI_A]))[0].s;
  await rows("vendorGateway", `UPDATE payin_mids SET daily_amount = $3 WHERE banker_code = $1 AND upi_id = $2`, [BANKER, UPI_A, used + 2 * 7.77 + 0.001]);
  const results = await Promise.allSettled([order(7.77), order(7.77), order(7.77), order(7.77)]);
  const ok = results.filter((r) => r.status === "fulfilled").length;
  assert.equal(ok, 2, JSON.stringify(results.map((r) => (r.status === "rejected" ? String((r.reason as Error).message) : "ok"))));
  assert.ok(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof NoMidAvailableError));
});
