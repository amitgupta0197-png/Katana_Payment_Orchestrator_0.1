// The merchant's pay-in report API against a real database. Run with `pnpm test:integration`.
//
// IT WRITES ROWS, so it only runs against a local database (PG_HOST localhost / 127.0.0.1) and
// removes the orders it created. It uses the seed banker's TEST Key + Salt, so every order it
// makes is a test order.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rows } from "@/lib/pg";
import { createKatanaOrder, confirmKatanaOrder } from "@/lib/katana-order";
import { getCheckoutCreds, type CheckoutCreds } from "@/lib/merchant-checkout";
import { payoutSignature } from "@/lib/payout-api";
import { POST as reportPost } from "@/app/api/v1/reports/payins/route";
import { reportHash, validateReportRange } from "@/lib/payin-report";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const BANKER = process.env.TEST_BANKER ?? "M10001";
const PREFIX = "ITEST-RPT-";
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };
const TODAY = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);   // the day in India
let creds: CheckoutCreds | null = null;
let n = 0;

const removeOrders = () => rows("vendorGateway", `DELETE FROM vendor_payin_orders WHERE order_id LIKE '${PREFIX}%'`);
const call = (body: Record<string, unknown>) => reportPost(new Request("http://test/api/v1/reports/payins", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}));
const signed = (from: string, to: string, extra: Record<string, unknown> = {}) =>
  call({ key: creds!.key, from, to, hash: payoutSignature(creds!, [from, to]), ...extra });

before(async () => {
  if (!LOCAL) return;
  await removeOrders();
  creds = await getCheckoutCreds(BANKER, false).catch(() => null);
});
after(async () => {
  if (LOCAL) await removeOrders();
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
});

test("a date range is refused when it is not dates, is backwards or is too long", () => {
  assert.equal(validateReportRange("2026-10-01", "2026-10-31"), null);
  assert.match(validateReportRange("2026-10-01", "2026-11-01")!, /at most 31 days/);
  assert.match(validateReportRange("2026-10-02", "2026-10-01")!, /from is after to/);
  assert.match(validateReportRange("01-10-2026", "2026-10-01")!, /YYYY-MM-DD/);
  assert.match(validateReportRange("2026-13-40", "2026-13-41")!, /YYYY-MM-DD/);
});

test("the report totals a merchant's own orders and names no gateway", opts, async (t) => {
  if (!creds?.key || !creds.salt) return t.skip("the test banker has no test Key + Salt");
  const before = await (await signed(TODAY, TODAY)).json() as Record<string, any>;

  const ids: string[] = [];
  for (const amount of [150, 250.5, 75]) {
    const r = await createKatanaOrder({ orderId: `${PREFIX}${Date.now()}-${n++}`, amount, currency: "INR", merchantId: BANKER, livemode: false });
    ids.push(r.order.id);
  }
  assert.equal((await confirmKatanaOrder({ id: ids[0], outcome: "SUCCESS", utr: `ITESTRPT${Date.now()}`, evidence: "MANUAL", actor: "itest", livemode: false })).ok, true);
  assert.equal((await confirmKatanaOrder({ id: ids[1], outcome: "FAILED", evidence: "MANUAL", actor: "itest", livemode: false })).ok, true);

  const res = await signed(TODAY, TODAY);
  const b = await res.json() as Record<string, any>;
  assert.equal(res.status, 200);
  assert.deepEqual([b.merchant, b.livemode, b.from, b.to, b.truncated], [BANKER, false, TODAY, TODAY, false]);
  assert.equal(b.summary.orders - before.summary.orders, 3);
  assert.equal(b.summary.paid_orders - before.summary.paid_orders, 1);
  assert.equal(b.summary.failed_orders - before.summary.failed_orders, 1);
  assert.equal(b.summary.pending_orders - before.summary.pending_orders, 1);
  assert.equal(Number(b.summary.paid_amount) - Number(before.summary.paid_amount), 150);

  const mine = (b.orders as Record<string, any>[]).filter((o) => String(o.txnid).startsWith(PREFIX));
  assert.deepEqual(mine.map((o) => [o.amount, o.status, !!o.utr, !!o.paid_at]),
    [["150.00", "Captured", true, true], ["250.50", "Failed", false, false], ["75.00", "Pending", false, false]]);
  assert.deepEqual(Object.keys(mine[0]).sort(), ["amount", "created_at", "currency", "flow", "id", "paid_at", "status", "txnid", "utr"]);
  assert.equal(/payu|razorpay|cashfree|paytm|phonepe|ccavenue|rubyvault|ismartpay|channel_id|gateway/i.test(JSON.stringify(b)), false);

  // The hash is of the content: the header and the field agree, and it is reproducible.
  const { report_hash, ...content } = b;
  assert.equal(report_hash, res.headers.get("x-report-hash"));
  assert.equal(report_hash, reportHash(JSON.stringify(content)));
  assert.equal((await (await signed(TODAY, TODAY)).json() as Record<string, any>).report_hash, report_hash);
});

test("the CSV carries the same orders, one a line, with its own hash", opts, async (t) => {
  if (!creds?.key || !creds.salt) return t.skip("the test banker has no test Key + Salt");
  const res = await signed(TODAY, TODAY, { format: "csv" });
  const text = (await res.text()).replace(/^﻿/, "");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/csv/);
  const lines = text.split("\r\n");
  assert.equal(lines[0], "txnid,order_id,amount,currency,status,flow,utr,created_at,paid_at");
  assert.equal(lines.filter((l) => l.startsWith(PREFIX)).length, 3);
  assert.equal(res.headers.get("x-report-hash"), reportHash(text));
});

test("a wrong signature, an unknown key and a bad range are refused", opts, async (t) => {
  if (!creds?.key || !creds.salt) return t.skip("the test banker has no test Key + Salt");
  assert.equal((await call({ key: creds.key, from: TODAY, to: TODAY, hash: "00" })).status, 401);
  // A signature for one range does not open another.
  assert.equal((await call({ key: creds.key, from: "2026-01-01", to: "2026-01-02", hash: payoutSignature(creds, [TODAY, TODAY]) })).status, 401);
  assert.equal((await call({ key: "mk_test_bad", from: TODAY, to: TODAY, hash: "00" })).status, 401);
  assert.equal((await signed("2026-01-01", "2026-03-01")).status, 400);
  assert.equal((await call({ key: creds.key, from: TODAY })).status, 400);
});
