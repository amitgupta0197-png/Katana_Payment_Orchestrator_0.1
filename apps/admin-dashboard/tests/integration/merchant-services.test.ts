// A merchant's services against a real database: a pay-out merchant takes no pay-in order, a
// pay-in merchant sends no payout, and the go-live gate checks what the merchant was onboarded
// for. Run with `pnpm test:integration`.
//
// IT WRITES ROWS, so it only runs against a local database (PG_HOST localhost / 127.0.0.1) and
// removes everything it created. Same seed merchant and banker as payin-flow.test.ts: the banker
// is live-activated, has a settlement UPI ID and no pay-in gateway.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rows } from "@/lib/pg";
import { setBankerFlow, setProviderFlow } from "@/lib/payin-flow-store";
import { getBankerServices, providerServicesHistory, setProviderServices } from "@/lib/merchant-services-store";
import { bankerSetup } from "@/lib/merchant-setup";
import { createKatanaOrder, confirmKatanaOrder } from "@/lib/katana-order";
import { v2CreateOrder } from "@/lib/v2-api";
import { issueV2Key } from "@/lib/v2-keys";
import { readOrderStatus } from "@/lib/pay-status";
import { flowOrderStatusGet } from "@/lib/flow-order-status";
import { createPayout } from "@/lib/fifo-payout";
import { gateSetup } from "@/lib/onboarding-gates";
import type { MerchantServicesSetting } from "@/lib/merchant-services";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const PROVIDER = process.env.TEST_PROVIDER_ID ?? "a0000000-0000-0000-0000-000000000001";
const BANKER = process.env.TEST_BANKER ?? "M10001";
const BY = "integration-test@local";
const PREFIX = "ITEST-SVC-";
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };
let n = 0;

const setServices = (services: MerchantServicesSetting) => setProviderServices(PROVIDER, { services, by: BY });

async function order(): Promise<{ id?: string; error?: string }> {
  try {
    const r = await createKatanaOrder({ orderId: `${PREFIX}${Date.now()}-${n++}`, amount: 101, currency: "INR", merchantId: BANKER, livemode: true });
    return { id: r.order.id };
  } catch (e) {
    return { error: (e as { code?: string }).code ?? (e as Error).constructor.name };
  }
}
// The beneficiary does not exist: a payout that gets past the services check stops there (404).
const payout = () => createPayout({
  merchantId: BANKER, beneficiaryId: "00000000-0000-0000-0000-000000000000", amountMinor: 10000n, currency: "INR", actor: BY,
} as Parameters<typeof createPayout>[0]);

async function cleanup() {
  await setServices("UNSET");
  await setProviderFlow(PROVIDER, { flow: "UNSET", by: BY });
  await setBankerFlow(BANKER, { flow: "UNSET", by: BY });
  await rows("provider", "DELETE FROM provider_services_history WHERE changed_by = $1", [BY]);
  await rows("provider", "DELETE FROM provider_payin_flow_history WHERE changed_by = $1", [BY]);
  await rows("merchant", "DELETE FROM merchant_payin_flow_history WHERE changed_by = $1", [BY]);
  await rows("provider", "UPDATE providers SET services_set_by = NULL, services_set_at = NULL, payin_flow_set_by = NULL, payin_flow_set_at = NULL WHERE services_set_by = $1 OR payin_flow_set_by = $1", [BY]);
  await rows("vendorGateway", `DELETE FROM vendor_payin_orders WHERE order_id LIKE '${PREFIX}%'`);
  await rows("auth", "DELETE FROM api_keys WHERE issued_by = $1", [BY]).catch(() => {});
}

before(async () => { if (LOCAL) await cleanup(); });
after(async () => { if (LOCAL) await cleanup(); setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref(); });

test("a banker obeys its merchant's services, and each change is recorded", opts, async () => {
  assert.equal(await getBankerServices(BANKER), "UNSET");
  await setServices("PAYOUT");
  assert.equal(await getBankerServices(BANKER), "PAYOUT");
  await setServices("PAYOUT");   // the same again is not a change
  const h = await providerServicesHistory(PROVIDER);
  assert.deepEqual([h.length, h[0].from_services, h[0].to_services, h[0].changed_by], [1, "UNSET", "PAYOUT", BY]);
});

test("a pay-out merchant's banker takes no pay-in order; pay-in and both do, and so does an unset one", opts, async () => {
  await setServices("PAYOUT");
  assert.equal((await order()).error, "PAYIN_NOT_ENABLED");
  for (const s of ["PAYIN", "BOTH", "UNSET"] as const) {
    await setServices(s);
    assert.ok((await order()).id, `${s} should take a pay-in order`);
  }
});

test("a pay-in merchant's banker sends no payout; the others get past that check", opts, async () => {
  await setServices("PAYIN");
  const refused = await payout();
  assert.deepEqual([refused.status, refused.code], [403, "PAYOUT_NOT_ENABLED"]);
  for (const s of ["PAYOUT", "BOTH", "UNSET"] as const) {
    await setServices(s);
    const r = await payout();
    assert.deepEqual([r.status, r.code], [404, undefined], `${s} should reach the beneficiary lookup`);
  }
});

test("go-live asks for what the merchant was onboarded for", opts, async () => {
  // P2P, and the seed banker has its UPI ID: nothing is missing.
  await setServices("PAYIN");
  await setProviderFlow(PROVIDER, { flow: "P2P", by: BY });
  let s = await bankerSetup(BANKER);
  assert.deepEqual([s.services, s.flow.flow, s.result, s.items.map((i) => `${i.key}:${i.state}`)], ["PAYIN", "P2P", "PASS", ["P2P_UPI_ID:DONE"]]);

  // Intent, and it has no pay-in gateway: go-live is refused.
  await setProviderFlow(PROVIDER, { flow: "INTENT", by: BY });
  s = await bankerSetup(BANKER);
  assert.deepEqual([s.result, s.items.map((i) => `${i.key}:${i.state}`)], ["FAIL", ["INTENT_GATEWAY:MISSING"]]);
  const gate = await gateSetup({ id: "x", merchant_code: BANKER } as Parameters<typeof gateSetup>[0]);
  assert.deepEqual([gate.gate, gate.result], ["SETUP", "FAIL"]);
  assert.match(gate.summary, /pay-in gateway connected/);

  // Pay-out only: no pay-in setup is asked for at all.
  await setServices("PAYOUT");
  s = await bankerSetup(BANKER);
  assert.ok(s.items.every((i) => i.key === "PAYOUT_GATEWAY"));
  assert.notEqual(s.result, "FAIL");
});

test("the v2 API refuses a pay-out only account with its own code", opts, async () => {
  await setProviderFlow(PROVIDER, { flow: "UNSET", by: BY });
  const key = (await issueV2Key(BANKER, false, "itest services", BY)).secret;
  const post = () => v2CreateOrder(new Request("http://localhost/v2/orders", {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ reference: `${PREFIX}V2-${Date.now()}-${n++}`, amount: 2500 }),
  }));
  await setServices("PAYOUT");
  const refused = await post();
  const body = await refused.json() as Record<string, unknown>;
  assert.deepEqual([refused.status, body.code, Object.keys(body).sort()], [403, "PAYIN_NOT_ENABLED", ["code", "message", "reference"]]);
  await setServices("BOTH");
  assert.equal((await post()).status, 201);
});

test("an order open when pay-ins are switched off can still be paid and reported", opts, async () => {
  await setServices("PAYIN");
  await setProviderFlow(PROVIDER, { flow: "P2P", by: BY });
  const open = await order();
  assert.ok(open.id);
  await setServices("PAYOUT");
  assert.equal((await order()).error, "PAYIN_NOT_ENABLED");          // nothing new
  assert.equal((await readOrderStatus(open.id!))?.status, "PENDING"); // the open one is untouched
  const paid = await confirmKatanaOrder({ id: open.id!, outcome: "SUCCESS", utr: `ITESTSVC${Date.now()}`, evidence: "UTR", actor: BY, livemode: true });
  assert.deepEqual([paid.ok, paid.order?.status], [true, "SUCCESS"]);
  assert.equal((await readOrderStatus(open.id!))?.status, "SUCCESS");
});

test("a test order on the Intent flow is an Intent order: its own status API finds it, the P2P one does not", opts, async () => {
  await setServices("PAYIN");
  await setProviderFlow(PROVIDER, { flow: "INTENT", by: BY });
  const r = await createKatanaOrder({ orderId: `${PREFIX}${Date.now()}-${n++}`, amount: 101, currency: "INR", merchantId: BANKER, livemode: false });
  assert.deepEqual([r.order.channel_type, r.order.channel_id], ["INTENT", "SANDBOX"]);
  const found = await flowOrderStatusGet(r.order.id, "INTENT");
  const b = await found.json() as Record<string, any>;
  assert.deepEqual([found.status, b.flow, /^INT-/.test(b.intent_ref), b.status], [200, "INTENT", true, "PENDING"]);
  assert.equal(JSON.stringify(b).includes("SANDBOX"), false);   // the rail is internal
  assert.equal((await flowOrderStatusGet(r.order.id, "P2P")).status, 404);
  // A live Intent order with no gateway is still refused: the sandbox takes test orders only.
  const live = await order();
  assert.equal(live.error, "FLOW_NOT_READY");
  // And a P2P merchant's test order is still P2P.
  await setProviderFlow(PROVIDER, { flow: "P2P", by: BY });
  const p = await createKatanaOrder({ orderId: `${PREFIX}${Date.now()}-${n++}`, amount: 101, currency: "INR", merchantId: BANKER, livemode: false });
  assert.equal(p.order.channel_type, "P2P");
});
