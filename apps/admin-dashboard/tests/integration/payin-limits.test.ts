// Pay-in limits, the suspension check, the status history and the ops alerts against a real
// database. Run with `pnpm test:integration`.
//
// IT WRITES ROWS, so it only runs against a local database (PG_HOST localhost / 127.0.0.1) and
// puts back what it changed. It needs the seed banker below, live-activated, with a settlement
// UPI ID and no pay-in gateway; override it with TEST_PROVIDER_ID / TEST_BANKER. The status
// history is append-only by design, so the rows it writes there stay.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { rows } from "@/lib/pg";
import { setProviderFlow, setBankerFlow } from "@/lib/payin-flow-store";
import { createKatanaOrder, confirmKatanaOrder, MerchantSuspendedError } from "@/lib/katana-order";
import { katanaOrderPost } from "@/lib/katana-order-api";
import { getCheckoutCreds } from "@/lib/merchant-checkout";
import { PayinLimitError, NO_LIMITS, type PayinLimits } from "@/lib/payin-limits";
import { getPayinLimits, getPayinUsage, setPayinLimits } from "@/lib/payin-limits-store";
import { raiseAlert, resolveAlert, openAlerts } from "@/lib/ops-alert";
import { beat, jobStatuses } from "@/lib/jobs";
import { scanPayinCompliance, listComplianceFlags, reviewComplianceFlag } from "@/lib/payin-compliance-store";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const PROVIDER = process.env.TEST_PROVIDER_ID ?? "a0000000-0000-0000-0000-000000000001";
const BANKER = process.env.TEST_BANKER ?? "M10001";
const BY = "integration-test@local";
const PREFIX = "ITEST-LIM-";
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };
let n = 0;
let saved: PayinLimits = NO_LIMITS;
let savedStage: string | null = null;

const ref = () => `${PREFIX}${Date.now()}-${n++}`;
const limits = (l: Partial<PayinLimits>) => setPayinLimits(BANKER, { ...NO_LIMITS, ...l }, BY);

async function order(amount: number, o: { orderId?: string; requestId?: string } = {}): Promise<{ id?: string; code?: string; limit?: number }> {
  try {
    const r = await createKatanaOrder({ orderId: o.orderId ?? ref(), amount, currency: "INR", merchantId: BANKER, livemode: true, requestId: o.requestId });
    return { id: r.order.id };
  } catch (e) {
    if (e instanceof PayinLimitError) return { code: e.code, limit: e.breach.limit };
    return { code: (e as { code?: string }).code ?? (e as Error).constructor.name };
  }
}

const removeOrders = () => rows("vendorGateway", `DELETE FROM vendor_payin_orders WHERE order_id LIKE '${PREFIX}%'`);

before(async () => {
  if (!LOCAL) return;
  const l = await getPayinLimits(BANKER);
  saved = { min: l.min, max: l.max, daily: l.daily, maxTps: l.maxTps };
  savedStage = (await rows<{ stage: string }>("merchant", "SELECT stage FROM merchants WHERE merchant_code = $1", [BANKER]))[0]?.stage ?? null;
  await setProviderFlow(PROVIDER, { flow: "P2P", by: BY });
  await removeOrders();
});

after(async () => {
  if (LOCAL) {
    await removeOrders();
    await setPayinLimits(BANKER, saved, BY);
    await rows("merchant", "UPDATE merchant_payment_config SET payin_limits_set_by = NULL, payin_limits_set_at = NULL WHERE payin_limits_set_by = $1", [BY]);
    if (savedStage) await rows("merchant", "UPDATE merchants SET stage = $2 WHERE merchant_code = $1", [BANKER, savedStage]);
    await setProviderFlow(PROVIDER, { flow: "UNSET", by: BY });
    await setBankerFlow(BANKER, { flow: "UNSET", by: BY });
    await rows("provider", "DELETE FROM provider_payin_flow_history WHERE changed_by = $1", [BY]);
    await rows("merchant", "DELETE FROM merchant_payin_flow_history WHERE changed_by = $1", [BY]);
    await rows("provider", "UPDATE providers SET payin_flow_set_by = NULL, payin_flow_set_at = NULL WHERE payin_flow_set_by = $1", [BY]);
    await rows("audit", "DELETE FROM ops_alerts WHERE alert_key LIKE 'itest:%'");
    await rows("audit", "DELETE FROM job_heartbeats WHERE job LIKE 'itest-%'");
    await rows("vendorGateway", "DELETE FROM payin_compliance_flags WHERE merchant_id = $1 AND flag_date = (now() AT TIME ZONE 'Asia/Kolkata')::date", [BANKER]);
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
});

test("with no limits of its own a banker takes the platform's: ₹1 to the UPI ceiling", opts, async () => {
  await limits({});
  assert.ok((await order(101)).id);
  assert.equal((await order(0.5)).code, "AMOUNT_BELOW_MIN");
  assert.deepEqual(await order(100000.01), { code: "UPI_LIMIT_EXCEEDED", limit: 100000 });
});

test("a banker's own minimum and maximum are enforced, and are read back", opts, async () => {
  assert.deepEqual(await limits({ min: 50, max: 5000 }), { ok: true });
  const l = await getPayinLimits(BANKER);
  assert.deepEqual([l.min, l.max, l.daily, l.maxTps, l.setBy], [50, 5000, null, null, BY]);
  assert.equal((await order(49.99)).code, "AMOUNT_BELOW_MIN");
  assert.ok((await order(50)).id);
  assert.ok((await order(5000)).id);
  assert.deepEqual(await order(5000.01), { code: "AMOUNT_ABOVE_MAX", limit: 5000 });
});

test("limits that contradict each other are not saved", opts, async () => {
  const r = await limits({ min: 100, max: 50 });
  assert.equal(r.ok, false);
});

test("the daily limit counts today's live orders and gives back a failed one", opts, async () => {
  await removeOrders();
  await limits({ daily: 1000 });
  const a = await order(600);
  assert.ok(a.id);
  assert.equal((await getPayinUsage(BANKER, true)).dayAmount >= 600, true);
  const used = (await getPayinUsage(BANKER, true)).dayAmount;
  await limits({ daily: used + 400 });
  assert.equal((await order(400.01)).code, "DAILY_LIMIT_EXCEEDED");
  assert.ok((await order(400)).id);
  assert.equal((await order(1)).code, "DAILY_LIMIT_EXCEEDED");
  // A failed order no longer counts toward the day.
  await confirmKatanaOrder({ id: a.id, outcome: "FAILED", evidence: "MANUAL", actor: BY, livemode: true });
  assert.ok((await order(600)).id);
});

test("a replayed order ref is answered with the original order, whatever the limits are now", opts, async () => {
  await limits({});
  const orderId = ref();
  const first = await order(300, { orderId });
  assert.ok(first.id);
  await limits({ max: 100 });
  assert.deepEqual(await order(300, { orderId }), { id: first.id });
  assert.equal((await order(300)).code, "AMOUNT_ABOVE_MAX");
});

test("the rate limit refuses the order after the last one allowed in a second", opts, async () => {
  // The orders of the tests above are still inside the last second; let them age out first.
  await new Promise((r) => setTimeout(r, 1100));
  await limits({ maxTps: 2 });
  // Sequential on a local database: three creations land well inside one second.
  const got = [await order(11), await order(12), await order(13)];
  assert.ok(got[0].id);
  assert.ok(got[1].id);
  assert.equal(got[2].code, "RATE_LIMITED");
  await new Promise((r) => setTimeout(r, 1100));
  assert.ok((await order(14)).id);
});

test("a suspended banker takes no orders, and takes them again once restored", opts, async () => {
  await limits({});
  await rows("merchant", "UPDATE merchants SET stage = 'SUSPENDED' WHERE merchant_code = $1", [BANKER]);
  try {
    await assert.rejects(
      createKatanaOrder({ orderId: ref(), amount: 101, currency: "INR", merchantId: BANKER, livemode: true }),
      (e: unknown) => e instanceof MerchantSuspendedError && e.code === "MERCHANT_SUSPENDED");
  } finally {
    await rows("merchant", "UPDATE merchants SET stage = $2 WHERE merchant_code = $1", [BANKER, savedStage]);
  }
  assert.ok((await order(101)).id);
});

test("every status an order has is in its history, with who changed it and the request id", opts, async () => {
  await limits({});
  const o = await order(222, { requestId: "itest-req-0001" });
  assert.ok(o.id);
  const read = () => rows<{ from_status: string | null; to_status: string; actor: string | null; evidence: string | null; request_id: string | null }>(
    "vendorGateway", "SELECT from_status, to_status, actor, evidence, request_id FROM vendor_payin_status_history WHERE order_id = $1::uuid ORDER BY id", [o.id]);
  assert.deepEqual(await read(), [{ from_status: null, to_status: "PENDING", actor: "order:create", evidence: null, request_id: "itest-req-0001" }]);

  const c = await confirmKatanaOrder({ id: o.id, outcome: "SUCCESS", utr: `ITESTLIM${Date.now()}`, evidence: "UTR", actor: BY, livemode: true });
  assert.equal(c.ok, true);
  const h = await read();
  assert.equal(h.length, 2);
  assert.deepEqual(h[1], { from_status: "PENDING", to_status: "SUCCESS", actor: BY, evidence: "UTR", request_id: "itest-req-0001" });

  // A write that does not change the status adds nothing.
  await rows("vendorGateway", "UPDATE vendor_payin_orders SET updated_at = now() WHERE id = $1::uuid", [o.id]);
  assert.equal((await read()).length, 2);
});

test("the status history cannot be changed or deleted", opts, async () => {
  const o = await order(123);
  await assert.rejects(rows("vendorGateway", "UPDATE vendor_payin_status_history SET to_status = 'SUCCESS' WHERE order_id = $1::uuid", [o.id]), /append-only/);
  await assert.rejects(rows("vendorGateway", "DELETE FROM vendor_payin_status_history WHERE order_id = $1::uuid", [o.id]), /append-only/);
});

test("the order API refuses with 422, the code, the field and the limit, and echoes the request id", opts, async (t) => {
  const creds = await getCheckoutCreds(BANKER, true).catch(() => null) as { key: string; salt: string; scheme: string } | null;
  if (!creds?.key || !creds.salt) return t.skip("the test banker has no live Key + Salt");
  await limits({ max: 500 });
  const call = async (amount: string, headers: Record<string, string> = {}) => {
    const o = { txnid: ref(), amount, productinfo: "t", email: "a@b.co" };
    const hash = creds.scheme === "PAYU_SHA512"
      ? crypto.createHash("sha512").update(`${creds.key}|${o.txnid}|${o.amount}|${o.productinfo}||${o.email}|||||||||||${creds.salt}`).digest("hex")
      : crypto.createHmac("sha256", creds.key + creds.salt).update([o.txnid, o.amount, o.productinfo, o.email].join("|")).digest("hex");
    const res = await katanaOrderPost(new Request("http://test/api", {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ key: creds.key, ...o, hash }),
    }), { flow: null, where: "test" });
    return { status: res.status, rid: res.headers.get("x-request-id"), body: await res.json() as Record<string, unknown> };
  };

  const bad = await call("500.01", { "x-request-id": "itest-req-abcdef" });
  assert.equal(bad.status, 422);
  assert.deepEqual(bad.body, { error: bad.body.error, code: "AMOUNT_ABOVE_MAX", field: "amount", limit: 500, actual: 500.01 });
  assert.equal(bad.rid, "itest-req-abcdef");

  const good = await call("500.00");
  assert.equal(good.status, 201);
  assert.match(good.rid ?? "", /^[0-9a-f-]{36}$/);           // none sent: one is made
  const untrusted = await call("10.00", { "x-request-id": "<script>" });
  assert.match(untrusted.rid ?? "", /^[0-9a-f-]{36}$/);      // not a plain token: replaced
});

test("an alert is sent once while it stays open, and again after it was resolved", opts, async () => {
  const key = `itest:${Date.now()}`;
  const send = async () => (await rows<{ last_sent_at: string; seen_count: string; resolved_at: string | null }>(
    "audit", "SELECT last_sent_at::text, seen_count::text, resolved_at::text FROM ops_alerts WHERE alert_key = $1", [key]))[0];
  await raiseAlert({ key, severity: "WARN", title: "itest" });
  const first = await send();
  await raiseAlert({ key, severity: "WARN", title: "itest" });
  const second = await send();
  assert.deepEqual([second.seen_count, second.last_sent_at], ["2", first.last_sent_at]);   // not sent again
  assert.equal((await openAlerts()).some((a) => a.alert_key === key), true);

  assert.deepEqual(await resolveAlert(key), { resolved: true });
  assert.deepEqual(await resolveAlert(key), { resolved: false });
  assert.equal((await openAlerts()).some((a) => a.alert_key === key), false);
  await raiseAlert({ key, severity: "WARN", title: "itest" });
  const third = await send();
  assert.equal(third.resolved_at, null);
  assert.notEqual(third.last_sent_at, first.last_sent_at);                                  // sent as new
});

test("a job that has not run for three times its interval is stale", opts, async () => {
  const job = `itest-${Date.now()}`;
  await beat(job, 60, true, { n: 1 });
  let j = (await jobStatuses()).find((x) => x.job === job);
  assert.deepEqual([j?.stale, j?.last_ok], [false, true]);
  await rows("audit", "UPDATE job_heartbeats SET last_finished_at = now() - interval '6 minutes' WHERE job = $1", [job]);
  j = (await jobStatuses()).find((x) => x.job === job);
  assert.equal(j?.stale, true);
  await beat(job, 60, false, { error: "boom" });
  j = (await jobStatuses()).find((x) => x.job === job);
  assert.deepEqual([j?.stale, j?.last_ok, j?.last_error], [false, false, "boom"]);
});

test("three paid orders just under ₹50,000 in an hour raise a structuring flag, kept through a re-scan and a review", opts, async () => {
  await limits({});
  for (const amount of [47000, 48000, 49999]) {
    const o = await order(amount);
    assert.ok(o.id);
    const c = await confirmKatanaOrder({ id: o.id, outcome: "SUCCESS", utr: `ITESTCMP${Date.now()}${n++}`, evidence: "UTR", actor: BY, livemode: true });
    assert.equal(c.ok, true);
  }
  const first = await scanPayinCompliance();
  assert.ok(first.merchants >= 1 && first.open >= 1);
  const mine = async () => (await listComplianceFlags({ merchantId: BANKER })).filter((f) => f.rule === "STRUCTURING");
  let flags = await mine();
  assert.equal(flags.length, 1);
  assert.deepEqual([flags[0].severity, flags[0].status, flags[0].detail.orders_in_one_hour], ["CRITICAL", "OPEN", 3]);

  const r = await reviewComplianceFlag(flags[0].id, "CLEARED", BY, "integration test");
  assert.deepEqual([r?.before.status, r?.after.status, r?.after.reviewed_by], ["OPEN", "CLEARED", BY]);
  // A re-scan on the same day finds the same pattern: one flag still, and its review is kept.
  const again = await scanPayinCompliance();
  assert.equal(again.new_flags, 0);
  flags = await mine();
  assert.deepEqual([flags.length, flags[0].status], [1, "CLEARED"]);
});

test("orders arriving together cannot pass the daily limit between them", opts, async () => {
  await limits({});
  await new Promise((r) => setTimeout(r, 50));
  const used = (await getPayinUsage(BANKER, true)).dayAmount;
  await limits({ daily: used + 1000 });
  // Eight orders of ₹300 at once against ₹1,000 of room: exactly three fit.
  const got = await Promise.all(Array.from({ length: 8 }, () => order(300)));
  assert.equal(got.filter((g) => g.id).length, 3);
  assert.equal(got.filter((g) => g.code === "DAILY_LIMIT_EXCEEDED").length, 5);
  assert.equal((await getPayinUsage(BANKER, true)).dayAmount, used + 900);
});

test("a bank reference cannot settle two live orders, even when both confirmations land together", opts, async () => {
  await limits({});
  const a = await order(111), b = await order(112);
  const utr = `ITESTDUP${Date.now()}`;
  const confirm = (id?: string) => confirmKatanaOrder({ id, outcome: "SUCCESS", utr, evidence: "UTR", actor: BY, livemode: true });
  const got = await Promise.all([confirm(a.id), confirm(b.id)]);
  assert.deepEqual(got.map((g) => g.ok).sort(), [false, true]);
  assert.match(got.find((g) => !g.ok)!.error ?? "", /duplicate UTR/);
  const paid = await rows<{ n: number }>("vendorGateway", "SELECT COUNT(*)::int AS n FROM vendor_payin_orders WHERE rrn = $1 AND status = 'SUCCESS'", [utr]);
  assert.equal(paid[0].n, 1);
});
