// Quasi-headless checkout on real orders (lib/headless, lib/headless-store, createKatanaOrder), with
// PhonePe's API stubbed in this process: a HEADLESS banker's P2P order is created with no PSP and a
// checkout, the Pay tap asks the chosen PSP once and stamps it on the order, a second tap gets the
// same link, the other app is refused, and the PSP's status answer confirms the order. Run with
// `pnpm test:integration`. IT WRITES ROWS, so it only runs against a local database; the banker's
// P2P method, its merchant's flow and its accounts are put back as they were.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rows } from "@/lib/pg";
import { createKatanaOrder, PayinFlowError } from "@/lib/katana-order";
import { setProviderFlow } from "@/lib/payin-flow-store";
import { storeGatewayMid, type GatewayMid } from "@/lib/gateway-creds";
import { checkGatewayPayin } from "@/lib/gateway-payin";
import { flowReadiness } from "@/lib/payin-flow-api";
import { getP2pMethod, setP2pMethod } from "@/lib/p2p-method-store";
import { HeadlessStartError, startHeadlessPayment } from "@/lib/headless-store";
import { readOrderStatus } from "@/lib/pay-status";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };
const PROVIDER = process.env.TEST_PROVIDER_ID ?? "a0000000-0000-0000-0000-000000000001";
const A = process.env.TEST_BANKER ?? "M10001";
const BY = "integration-test-headless@local";
const PREFIX = "ITEST-HL-";
const R = String(Date.now()).slice(-7);
let n = 0;
const ref = () => `${PREFIX}${R}-${n++}`;
const LABEL = "gateway_mid:itest-headless";
const PAYEE = "banker-pg@ybl";
const CLIENT = { ip: "127.0.0.1", deviceInfo: "itest" };

process.env.PAYIN_CONNECTORS_PROD = `${process.env.PAYIN_CONNECTORS_PROD ?? "PAYU"},PHONEPE`;

// ── PhonePe, stubbed: token, UPI intent, order status ────────────────────────────────────────
const realFetch = globalThis.fetch;
let intents = 0;
const paid = new Set<string>();
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.includes("phonepe.com")) return realFetch(input, init);
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  if (url.endsWith("/v1/oauth/token")) return json({ access_token: "itest-token", expires_at: Math.floor(Date.now() / 1000) + 3600 });
  if (url.endsWith("/payments/v2/pay")) {
    intents++;
    const b = JSON.parse(String(init?.body ?? "{}"));
    return json({ orderId: `OMO-${b.merchantOrderId}`, state: "PENDING", intentUrl: `upi://pay?pa=${PAYEE}&pn=Banker&am=${b.amount / 100}&cu=INR&tr=${b.merchantOrderId}` });
  }
  const m = url.match(/\/payments\/v2\/order\/([^/]+)\/status$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    return json(paid.has(id)
      ? { orderId: `OMO-${id}`, state: "COMPLETED", amount: 49900, paymentDetails: [{ state: "COMPLETED", transactionId: "T-1", paymentMode: "UPI_INTENT", rail: { utr: "512345678901" } }] }
      : { orderId: `OMO-${id}`, state: "PENDING", amount: 49900, paymentDetails: [] });
  }
  return json({ code: "NOT_FOUND" }, 404);
}) as typeof fetch;

const phonepeMid: GatewayMid = {
  gateway: "PHONEPE", mid_code: "PP-ITEST", key: "pp-client", salt: "pp-secret", scheme: "HMAC_SHA256" as GatewayMid["scheme"], env: "PROD",
  extra: { client_version: "1", channel: "P2P" },
};

let priorMethod: Awaited<ReturnType<typeof getP2pMethod>> = null;
before(async () => {
  if (!LOCAL) return;
  priorMethod = await getP2pMethod(A);
  await storeGatewayMid(A, phonepeMid, LABEL);
  await setP2pMethod(A, { value: "HEADLESS", by: BY });
  await setProviderFlow(PROVIDER, { flow: "BOTH", active: "P2P", by: BY });
});
after(async () => {
  if (LOCAL) {
    await rows("checkout", `DELETE FROM credential_vault WHERE kind = 'mid_secret' AND owner_type = 'merchant' AND owner_id = $1 AND label = $2`, [A, LABEL]);
    await rows("vendorGateway", `DELETE FROM vendor_payin_orders WHERE order_id LIKE '${PREFIX}%'`).catch(() => {});
    await setP2pMethod(A, { value: priorMethod, by: BY });
    await rows("merchant", "DELETE FROM merchant_p2p_method_history WHERE changed_by = $1", [BY]);
    await setProviderFlow(PROVIDER, { flow: "UNSET", by: BY });
    await rows("provider", "DELETE FROM provider_payin_flow_history WHERE changed_by = $1", [BY]);
    await rows("provider", "UPDATE providers SET payin_flow_set_by = NULL, payin_flow_set_at = NULL WHERE payin_flow_set_by = $1", [BY]);
  }
  globalThis.fetch = realFetch;
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
});

const stored = async (id: string) => (await rows<{ channel_type: string; channel_id: string; status: string; rrn: string | null; vendor_txn_id: string; meta: any }>("vendorGateway",
  `SELECT channel_type, channel_id, status, rrn, vendor_txn_id, meta FROM vendor_payin_orders WHERE id = $1::uuid`, [id]))[0];

test("readiness: a live PhonePe P2P account makes a HEADLESS banker P2P-ready", opts, async () => {
  assert.equal((await flowReadiness([A])).get(A)!.p2p, true);
});

test("a malformed payer UPI ID is refused", opts, async () => {
  await assert.rejects(
    createKatanaOrder({ orderId: ref(), amount: 499, currency: "INR", merchantId: A, livemode: true, flow: "P2P", customerVpa: "not-a-vpa" }),
    (e: Error) => e instanceof PayinFlowError && (e as PayinFlowError).code === "INVALID_VPA");
});

test("order → checkout → Pay → PSP confirms: one intent, the other app refused, SUCCESS with the UTR", opts, async () => {
  const r = await createKatanaOrder({ orderId: ref(), amount: 499, currency: "INR", merchantId: A, livemode: true, flow: "P2P", customerVpa: "rahul@ybl" });
  assert.equal(r.headless, true);
  let s = await stored(r.order.id);
  assert.equal(s.channel_type, "P2P");
  assert.equal(s.channel_id, "HEADLESS");
  assert.equal(s.meta.gateway, null);                       // no PSP until the customer taps Pay
  assert.deepEqual(s.meta.headless.psps, ["PHONEPE"]);
  assert.equal(s.meta.headless.default, "PHONEPE");         // from @ybl

  const page = await readOrderStatus(r.order.id);
  assert.equal(page!.headless!.chosen, null);
  assert.deepEqual(page!.headless!.psps, ["PHONEPE"]);

  // Paytm is not connected for this banker.
  await assert.rejects(startHeadlessPayment(r.order.id, "PAYTM", CLIENT), (e: Error) => e instanceof HeadlessStartError && (e as HeadlessStartError).code === "PSP_UNAVAILABLE");

  const before = intents;
  const pay = await startHeadlessPayment(r.order.id, "PHONEPE", CLIENT);
  assert.match(pay.app, new RegExp(`^phonepe://pay\\?pa=${PAYEE}`));
  assert.match(pay.upi, /^upi:\/\/pay\?/);
  s = await stored(r.order.id);
  assert.equal(s.meta.gateway.provider, "PHONEPE");
  assert.equal(s.channel_id, "PHONEPE");
  assert.equal(s.vendor_txn_id, s.meta.gateway.txnid);
  assert.equal(s.meta.mid.vault_label, LABEL);              // every later call uses this account
  assert.equal(s.meta.headless.chosen, "PHONEPE");

  // A second tap: the same link, no second intent.
  assert.deepEqual(await startHeadlessPayment(r.order.id, "PHONEPE", CLIENT), pay);
  assert.equal(intents, before + 1);

  // The PSP says paid: the order is confirmed with its UTR.
  paid.add(s.vendor_txn_id);
  await checkGatewayPayin({ provider: "PHONEPE", txnid: s.vendor_txn_id, merchantCode: A, source: "itest" });
  s = await stored(r.order.id);
  assert.equal(s.status, "SUCCESS");
  assert.equal(s.rrn, "512345678901");
  await assert.rejects(startHeadlessPayment(r.order.id, "PHONEPE", CLIENT), (e: Error) => (e as HeadlessStartError).code === "NOT_PAYABLE");
});

test("a test order offers both apps and pays the sandbox in the chosen one, never a PSP", opts, async () => {
  const r = await createKatanaOrder({ orderId: ref(), amount: 10, currency: "INR", merchantId: A, livemode: false, flow: "P2P", customerVpa: "x@paytm" });
  const s = await stored(r.order.id);
  assert.deepEqual(s.meta.headless.psps, ["PHONEPE", "PAYTM"]);
  assert.equal(s.meta.headless.default, "PAYTM");
  const before = intents;
  const pay = await startHeadlessPayment(r.order.id, "PAYTM", CLIENT);
  assert.match(pay.app, /^paytmmp:\/\/pay\?/);
  assert.equal(intents, before);
});
