// Pay-in flows against a real database: inheritance, order routing, the flow tables and the
// order APIs. Run with `pnpm test:integration`.
//
// IT WRITES ROWS, so it only runs against a local database (PG_HOST localhost / 127.0.0.1) and
// removes everything it created. It needs the seed merchant and banker below, live-activated,
// with a settlement UPI ID and no pay-in gateway; override them with TEST_PROVIDER_ID / TEST_BANKER.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { rows } from "@/lib/pg";
import { getEffectiveFlow, setBankerFlow, setProviderFlow } from "@/lib/payin-flow-store";
import { createKatanaOrder, confirmKatanaOrder } from "@/lib/katana-order";
import { katanaOrderPost } from "@/lib/katana-order-api";
import { flowOrderStatusGet } from "@/lib/flow-order-status";
import { getCheckoutCreds } from "@/lib/merchant-checkout";
import type { OrderFlow, PayinFlow } from "@/lib/payin-flow";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const PROVIDER = process.env.TEST_PROVIDER_ID ?? "a0000000-0000-0000-0000-000000000001";
const BANKER = process.env.TEST_BANKER ?? "M10001";
const BY = "integration-test@local";
const PREFIX = "ITEST-FLOW-";
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };
let n = 0;

const setFlow = (flow: PayinFlow | "UNSET", active?: OrderFlow) => setProviderFlow(PROVIDER, { flow, active, by: BY });

async function order(flow: OrderFlow | null): Promise<{ type?: string; id?: string; error?: string }> {
  try {
    const r = await createKatanaOrder({ orderId: `${PREFIX}${Date.now()}-${n++}`, amount: 101, currency: "INR", merchantId: BANKER, livemode: true, flow });
    return { type: r.order.channel_type, id: r.order.id };
  } catch (e) {
    return { error: (e as { code?: string }).code ?? (e as Error).constructor.name };
  }
}

async function cleanup() {
  await setProviderFlow(PROVIDER, { flow: "UNSET", by: BY });
  await setBankerFlow(BANKER, { flow: "UNSET", by: BY });
  await rows("provider", "DELETE FROM provider_payin_flow_history WHERE changed_by = $1", [BY]);
  await rows("merchant", "DELETE FROM merchant_payin_flow_history WHERE changed_by = $1", [BY]);
  await rows("provider", "UPDATE providers SET payin_flow_set_by = NULL, payin_flow_set_at = NULL WHERE payin_flow_set_by = $1", [BY]);
  await rows("vendorGateway", `DELETE FROM vendor_payin_orders WHERE order_id LIKE '${PREFIX}%'`);
}

before(async () => { if (LOCAL) await cleanup(); });
after(async () => { if (LOCAL) await cleanup(); setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref(); });

test("a banker inherits its merchant's flow, and its own flow wins", opts, async () => {
  await setFlow("INTENT");
  let e = await getEffectiveFlow(BANKER);
  assert.deepEqual([e.flow, e.source], ["INTENT", "MERCHANT"]);
  await setBankerFlow(BANKER, { flow: "P2P", by: BY });
  e = await getEffectiveFlow(BANKER);
  assert.deepEqual([e.flow, e.source, e.inherited.flow], ["P2P", "BANKER", "INTENT"]);
  await setBankerFlow(BANKER, { flow: "UNSET", by: BY });
  e = await getEffectiveFlow(BANKER);
  assert.deepEqual([e.flow, e.source], ["INTENT", "MERCHANT"]);
});

test("BOTH without a flow in use is rejected", opts, async () => {
  assert.equal((await setProviderFlow(PROVIDER, { flow: "BOTH", by: BY })).ok, false);
});

test("a P2P merchant's orders are P2P and the Intent API is refused", opts, async () => {
  await setFlow("P2P");
  assert.equal((await order(null)).type, "P2P");
  assert.equal((await order("P2P")).type, "P2P");
  assert.equal((await order("INTENT")).error, "FLOW_NOT_ENABLED");
});

test("an Intent merchant with no gateway is refused, never sent to a UPI ID", opts, async () => {
  await setFlow("INTENT");
  assert.equal((await order(null)).error, "FLOW_NOT_READY");
  assert.equal((await order("P2P")).error, "FLOW_NOT_ENABLED");
});

test("a BOTH merchant takes the flow in use, or the one asked for", opts, async () => {
  await setFlow("BOTH", "P2P");
  assert.equal((await order(null)).type, "P2P");
  assert.equal((await order("INTENT")).error, "FLOW_NOT_READY");
  await setFlow("BOTH", "INTENT");
  assert.equal((await order("P2P")).type, "P2P");
});

test("the P2P table follows the order through its confirmation, under one reference", opts, async () => {
  await setFlow("P2P");
  const o = await order(null);
  assert.ok(o.id);
  const read = async () => (await rows<{ p2p_ref: string; payee_vpa: string | null; utr: string | null; evidence: string | null; confirmed_by: string | null }>(
    "vendorGateway", "SELECT p2p_ref, payee_vpa, utr, evidence, confirmed_by FROM katana_p2p_orders WHERE order_id = $1::uuid", [o.id]))[0];
  const first = await read();
  assert.match(first.p2p_ref, /^P2P-\d{9}$/);
  assert.ok(first.payee_vpa);
  assert.equal(first.utr, null);
  const c = await confirmKatanaOrder({ id: o.id, outcome: "SUCCESS", utr: `ITESTUTR${Date.now()}`, evidence: "UTR", actor: BY, livemode: true });
  assert.equal(c.ok, true);
  const then = await read();
  assert.deepEqual([then.p2p_ref, !!then.utr, then.evidence, then.confirmed_by], [first.p2p_ref, true, "UTR", BY]);
  assert.equal((await rows("vendorGateway", "SELECT 1 FROM katana_intent_orders WHERE order_id = $1::uuid", [o.id])).length, 0);
});

test("the three order APIs share one contract and obey the flow", opts, async (t) => {
  const creds = await getCheckoutCreds(BANKER, false).catch(() => null) as { key: string; salt: string; scheme: string } | null;
  if (!creds?.key || !creds.salt) return t.skip("the test banker has no test Key + Salt");
  const call = async (flow: OrderFlow | null) => {
    const o = { txnid: `${PREFIX}API-${Date.now()}-${n++}`, amount: "25.00", productinfo: "t", email: "a@b.co" };
    const hash = creds.scheme === "PAYU_SHA512"
      ? crypto.createHash("sha512").update(`${creds.key}|${o.txnid}|${o.amount}|${o.productinfo}||${o.email}|||||||||||${creds.salt}`).digest("hex")
      : crypto.createHmac("sha256", creds.key + creds.salt).update([o.txnid, o.amount, o.productinfo, o.email].join("|")).digest("hex");
    const res = await katanaOrderPost(new Request("http://test/api", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: creds.key, ...o, hash }),
    }), { flow, where: "test" });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };

  await setFlow("UNSET");
  let r = await call(null);
  assert.deepEqual([r.status, r.body.verified, typeof r.body.pay_url, "gateway" in r.body], [201, true, "string", false]);
  for (const k of ["verified", "merchant", "livemode", "reused", "flow", "order", "deeplinks", "upi_intent", "qr_payload", "pay_url"]) assert.ok(k in r.body, k);
  assert.equal("channel_id" in r.body.order, false);
  r = await call("P2P");
  assert.deepEqual([r.status, r.body.code], [409, "FLOW_NOT_SELECTED"]);

  await setFlow("P2P");
  r = await call("P2P");
  assert.deepEqual([r.status, r.body.flow], [201, "P2P"]);
  const id = r.body.order.id as string;
  r = await call("INTENT");
  assert.deepEqual([r.status, r.body.code], [409, "FLOW_NOT_ENABLED"]);

  let s = await flowOrderStatusGet(id, "P2P");
  const b = await s.json() as Record<string, any>;
  assert.deepEqual([s.status, b.flow, /^P2P-/.test(b.p2p_ref), b.status], [200, "P2P", true, "PENDING"]);
  s = await flowOrderStatusGet(b.p2p_ref, "P2P");
  assert.equal((await s.json() as Record<string, any>).id, id);
  assert.equal((await flowOrderStatusGet(id, "INTENT")).status, 404);
  assert.equal((await flowOrderStatusGet("not-an-id", "P2P")).status, 404);
});

test("a bad key is refused on every order API", opts, async () => {
  for (const flow of [null, "P2P", "INTENT"] as const) {
    const res = await katanaOrderPost(new Request("http://test/api", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "mk_test_bad", txnid: "X", amount: "1.00", hash: "00" }),
    }), { flow, where: "test" });
    assert.equal(res.status, 401);
  }
});
