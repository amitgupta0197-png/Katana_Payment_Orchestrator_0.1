// BharatPe: a payment posted from its push (no UTR) confirms the order at once; the same
// payment posted again with its UTR (same bharatpe_txn_id) adds the UTR to that record and to
// the order instead of becoming a second credit (app/api/v1/bharatpe/credit). Test MID, test order.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "crypto";
import { rows } from "@/lib/pg";
import { createKatanaOrder } from "@/lib/katana-order";
import { saveBharatPeMid } from "@/lib/bharatpe-store";
import { genRrn } from "@/lib/katana-pay";
import { POST } from "@/app/api/v1/bharatpe/credit/route";

const HOST = process.env.PG_HOST ?? "127.0.0.1";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };
const A = process.env.TEST_BANKER ?? "M10001";
const BY = "integration-test-bharatpe@local";
const LABEL = "ITEST-BP-UTR";
const KEY = "bp-itest-" + Date.now();
const UTR = String(100000000000 + (Date.now() % 899999999999)).slice(0, 12);
let orderUuid = "";

async function post(apiKey: string, secret: string, body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  const ts = String(Date.now());
  const sig = createHmac("sha256", secret).update(`${apiKey}.${ts}.${raw}`).digest("hex");
  const res = await POST(new Request("http://localhost/api/v1/bharatpe/credit", {
    method: "POST", body: raw,
    headers: { "content-type": "application/json", "x-bharatpe-key": apiKey, "x-timestamp": ts, "x-signature": sig },
  }));
  return { status: res.status, body: await res.json() as any };
}

after(async () => {
  if (LOCAL) {
    await rows("vendorGateway", `DELETE FROM vendor_txn_alerts WHERE details->>'bharatpe_txn_id' = $1`, [KEY]).catch(() => {});
    if (orderUuid) await rows("vendorGateway", `DELETE FROM vendor_payin_orders WHERE id = $1::uuid`, [orderUuid]).catch(() => {});
    await rows("vendorGateway", `DELETE FROM bharatpe_mids WHERE merchant_code = $1 AND label = $2`, [A, LABEL]).catch(() => {});
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
});

test("push confirms the order; the UTR post adds the UTR to the same record and the order", opts, async () => {
  const vpa = (await rows<{ v: string }>("merchant",
    `SELECT katana_pay->>'settlement_vpa' AS v FROM merchant_payment_config WHERE merchant_code = $1`, [A]))[0]?.v;
  assert.ok(vpa, "test banker needs a settlement UPI ID");
  const mid = await saveBharatPeMid({ code: A, label: LABEL, bharatpeMerchantId: "", payeeVpa: vpa, env: "TEST", by: BY });
  assert.ok(mid.api_key && mid.secret);

  const amount = 17 + (Date.now() % 97) / 100;   // a unique amount among the banker's open test orders
  const o = await createKatanaOrder({ orderId: "ITEST-BPU-" + Date.now(), amount, currency: "INR", merchantId: A, livemode: false });
  orderUuid = o.order.id;

  // 1. The push: amount + payer, no UTR.
  const first = await post(mid.api_key!, mid.secret!, {
    amount: amount.toFixed(2), payer_name: "ITEST PAYER", bharatpe_txn_id: KEY, event_time: new Date().toISOString(),
    raw: `BharatPe push ${KEY}`, nonce: KEY + "-1",
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  let order = (await rows<{ status: string; rrn: string | null }>("vendorGateway",
    `SELECT status, rrn FROM vendor_payin_orders WHERE id = $1::uuid`, [orderUuid]))[0];
  assert.equal(order.status, "SUCCESS", JSON.stringify(first.body));
  assert.equal(order.rrn, genRrn(orderUuid), "confirmed with Katana's own reference until the UTR comes");

  // 2. The same payment with its UTR: added, not a second credit.
  const second = await post(mid.api_key!, mid.secret!, {
    amount: amount.toFixed(2), utr: UTR, payer_name: "Itest Payer", bharatpe_txn_id: KEY, nonce: KEY + "-2",
  });
  assert.equal(second.body.outcome, "UTR_ADDED", JSON.stringify(second.body));
  order = (await rows<{ status: string; rrn: string | null }>("vendorGateway",
    `SELECT status, rrn FROM vendor_payin_orders WHERE id = $1::uuid`, [orderUuid]))[0];
  assert.equal(order.rrn, UTR);
  const alerts = await rows<{ utr: string | null }>("vendorGateway",
    `SELECT utr FROM vendor_txn_alerts WHERE details->>'bharatpe_txn_id' = $1`, [KEY]);
  assert.equal(alerts.length, 1, "one record for the payment");
  assert.equal(alerts[0].utr, UTR);

  // 3. Sent again: nothing changes.
  const third = await post(mid.api_key!, mid.secret!, { amount: amount.toFixed(2), utr: UTR, bharatpe_txn_id: KEY, nonce: KEY + "-3" });
  assert.equal(third.body.outcome, "DUPLICATE");
});
