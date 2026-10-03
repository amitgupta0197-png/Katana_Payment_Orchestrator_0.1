// The v2 order API and webhook against a real database: create and read an order with a Bearer
// key, the v2 event a paid / expired / late-paid order is announced with, the signature the
// receiver checks, resend, test events, and that a v1 banker's callback is unchanged.
// Run with `pnpm test:integration`.
//
// IT WRITES ROWS, so it only runs against a local database and removes everything it created.
// Nothing leaves the machine: deliveries go to a documentation address (203.0.113.10) and
// `fetch` is replaced for that address, so what would have been sent is captured instead.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rows } from "@/lib/pg";
import { setProviderFlow } from "@/lib/payin-flow-store";
import { confirmKatanaOrder } from "@/lib/katana-order";
import { readOrderStatus } from "@/lib/pay-status";
import { v2CreateOrder, v2GetOrder, V2_ERRORS } from "@/lib/v2-api";
import { issueV2Key } from "@/lib/v2-keys";
import { saveWebhookSettings, rotateWebhookSecret, listWebhookSettings } from "@/lib/webhook-settings";
import { resendOutbox, deliverNow } from "@/lib/webhook-outbox";
import { sendTestEvent } from "@/lib/webhook-test";
import { orderUuidFrom, verifyV2Signature } from "@/lib/webhook-v2";
import { verifyKatanaHash } from "@/lib/katana-pay";
import { getCheckoutCreds, issueCheckoutCreds } from "@/lib/merchant-checkout";
import { orderTimeline, searchOrders } from "@/lib/order-timeline";
import { readApiLog } from "@/lib/api-log";
import { orderInScope } from "@/lib/portal-scope";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const PROVIDER = process.env.TEST_PROVIDER_ID ?? "a0000000-0000-0000-0000-000000000001";
const BANKER = process.env.TEST_BANKER ?? "M10001";
const OTHER = process.env.TEST_OTHER_BANKER ?? "M10002";
const BY = "integration-test-v2@local";
const PREFIX = "ITEST-V2-";
const HOOK = "https://203.0.113.10/katana-hook";
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };

let liveKey = "", testKey = "", otherKey = "", secret = "", n = 0;
const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
const realFetch = globalThis.fetch;
let answer = 200;

const ref = () => `${PREFIX}${Date.now()}-${n++}`;
const post = (key: string, body: unknown) => v2CreateOrder(new Request("http://localhost/v2/orders", {
  method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body),
}));
const get = (key: string, id: string) => v2GetOrder(new Request(`http://localhost/v2/orders/${id}`, { headers: { authorization: `Bearer ${key}` } }), id);
const pay = (ktn: string, utr: string | null) =>
  confirmKatanaOrder({ id: orderUuidFrom(ktn)!, outcome: "SUCCESS", utr, evidence: "UTR", actor: BY, livemode: true });
const age = (ktn: string, minutes: number) =>
  rows("vendorGateway", `UPDATE vendor_payin_orders SET created_at = now() - make_interval(mins => $2::int) WHERE id = $1::uuid`, [orderUuidFrom(ktn), minutes]);
/** The callback is sent after the status is written and is not awaited there: wait for it here. */
async function delivered(count: number): Promise<void> {
  for (let i = 0; i < 100 && sent.length < count; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, count, `expected ${count} deliveries, saw ${sent.length}`);
}
const settle = () => new Promise((r) => setTimeout(r, 300));

async function cleanup() {
  await setProviderFlow(PROVIDER, { flow: "UNSET", by: BY });
  await rows("provider", "DELETE FROM provider_payin_flow_history WHERE changed_by = $1", [BY]);
  await rows("provider", "UPDATE providers SET payin_flow_set_by = NULL, payin_flow_set_at = NULL WHERE payin_flow_set_by = $1", [BY]);
  const ids = (await rows<{ id: string }>("vendorGateway", `SELECT id::text FROM vendor_payin_orders WHERE order_id LIKE '${PREFIX}%'`)).map((r) => r.id);
  await rows("notification", `DELETE FROM webhook_outbox WHERE order_id = ANY($1::uuid[]) OR requested_by = $2`, [ids, BY]);
  await rows("vendorGateway", `DELETE FROM vendor_payin_orders WHERE order_id LIKE '${PREFIX}%'`);
  await rows("auth", "DELETE FROM api_keys WHERE issued_by = $1", [BY]);
  await rows("audit", "DELETE FROM api_request_log WHERE merchant_id = ANY($1::text[]) AND (request_body->>'reference' LIKE $2 OR endpoint = '/v2/orders/{id}')", [[BANKER, OTHER], `${PREFIX}%`]);
  await rows("audit", "DELETE FROM api_request_log WHERE merchant_id IS NULL AND created_at > now() - interval '10 minutes' AND api_version = 'v2'");
  await rows("merchant", `UPDATE merchants SET webhook_version = 'v1', webhook_events = 'ALL', webhook_url = NULL, webhook_secret = NULL,
                            webhook_version_set_by = NULL, webhook_version_set_at = NULL WHERE merchant_code = $1`, [BANKER]);
}

before(async () => {
  if (!LOCAL) return;
  await cleanup();
  await setProviderFlow(PROVIDER, { flow: "P2P", by: BY });
  liveKey = (await issueV2Key(BANKER, true, "itest live", BY)).secret;
  testKey = (await issueV2Key(BANKER, false, "itest test", BY)).secret;
  otherKey = (await issueV2Key(OTHER, false, "itest other", BY)).secret;
  const s = await saveWebhookSettings(BANKER, { webhook_version: "v2", webhook_events: "ALL", callback_url: HOOK }, BY);
  assert.ok(s.ok && s.secret, "moving to v2 makes the signing secret");
  secret = s.ok ? s.secret! : "";
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (!url.startsWith(HOOK)) return realFetch(input, init);
    sent.push({ url, headers: Object.fromEntries(Object.entries(init.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])), body: String(init.body) });
    return new Response("ok", { status: answer });
  }) as typeof fetch;
});
after(async () => {
  globalThis.fetch = realFetch;
  if (LOCAL) { await settle(); await cleanup(); }
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
});

test("an order is created with a Bearer key and answered in the v2 shape", opts, async () => {
  const reference = ref();
  const res = await post(liveKey, { amount: 10100, currency: "INR", reference, callback_url: HOOK, metadata: { cart: "42" } });
  const b = await res.json();
  assert.equal(res.status, 201);
  assert.deepEqual(Object.keys(b).sort(), ["checkout_url", "expires_at", "order_id", "reference", "status"]);
  assert.match(b.order_id, /^KTN_[0-9a-f]{32}$/);
  assert.deepEqual([b.reference, b.status], [reference, "PENDING"]);
  assert.ok(b.checkout_url.endsWith(`/pay/${orderUuidFrom(b.order_id)}`));
  assert.ok(Date.parse(b.expires_at) > Date.now());
  assert.ok(res.headers.get("x-request-id"));

  // The stored order is the ordinary one: rupees, the banker and mode of the key, the notes kept.
  const o = (await rows<any>("vendorGateway", "SELECT amount, merchant_id, livemode, meta FROM vendor_payin_orders WHERE id = $1::uuid", [orderUuidFrom(b.order_id)]))[0];
  assert.deepEqual([Number(o.amount), o.merchant_id, o.livemode, o.meta.api_version, o.meta.metadata, o.meta.notify_url], [101, BANKER, true, "v2", { cart: "42" }, HOOK]);
});

test("the same reference again is the same order; a different amount under it is refused", opts, async () => {
  const reference = ref();
  const first = await (await post(liveKey, { amount: 10100, reference })).json();
  const again = await post(liveKey, { amount: 10100, reference });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).order_id, first.order_id);
  const other = await post(liveKey, { amount: 20000, reference });
  const e = await other.json();
  assert.deepEqual([other.status, e.code], [409, "REFERENCE_REUSED"]);
  // A test key has its own references: the same one makes a separate, test order.
  const t = await (await post(testKey, { amount: 10100, reference })).json();
  assert.notEqual(t.order_id, first.order_id);
});

test("every refusal is { code, message, reference } with a published code", opts, async () => {
  const cases: [Response, number, string][] = [
    [await post("sk_live_not-a-real-key", { amount: 100, reference: ref() }), 401, "UNAUTHORIZED"],
    [await v2CreateOrder(new Request("http://localhost/v2/orders", { method: "POST", body: "{}" })), 401, "UNAUTHORIZED"],
    [await post(liveKey, { amount: 10.5, reference: ref() }), 400, "INVALID_REQUEST"],
    [await post(liveKey, { amount: 10100 }), 400, "INVALID_REQUEST"],
    [await post(liveKey, { amount: 10100, reference: ref(), currency: "USD" }), 400, "UNSUPPORTED_CURRENCY"],
    [await post(liveKey, { amount: 50, reference: ref() }), 422, "AMOUNT_BELOW_MIN"],
    [await get(liveKey, "KTN_00000000000000000000000000000000"), 404, "ORDER_NOT_FOUND"],
    [await get(liveKey, "no-such-reference"), 404, "ORDER_NOT_FOUND"],
  ];
  for (const [res, status, code] of cases) {
    const b = await res.json();
    assert.deepEqual([res.status, b.code], [status, code]);
    assert.deepEqual(Object.keys(b).sort(), ["code", "message", "reference"]);
    assert.ok(code in V2_ERRORS && V2_ERRORS[code as keyof typeof V2_ERRORS].status === status);
    assert.equal(res.headers.get("x-request-id"), b.reference);
  }
});

test("an order is read by its id or by the merchant's reference, and only by its own banker and mode", opts, async () => {
  const reference = ref();
  const made = await (await post(liveKey, { amount: 10100, reference })).json();
  const byId = await (await get(liveKey, made.order_id)).json();
  const byRef = await (await get(liveKey, reference)).json();
  assert.deepEqual(byId, byRef);
  assert.deepEqual([byId.order_id, byId.reference, byId.status, byId.amount, byId.currency, byId.event, byId.rrn, byId.gateway],
    [made.order_id, reference, "PENDING", 10100, "INR", null, null, null]);
  for (const key of [otherKey, testKey]) {
    assert.equal((await get(key, made.order_id)).status, 404);
    assert.equal((await get(key, reference)).status, 404);
  }
});

test("a paid order is announced with payment.success, signed in the header, with one event id", opts, async () => {
  sent.length = 0; answer = 200;
  const reference = ref();
  const made = await (await post(liveKey, { amount: 10100, reference, callback_url: HOOK })).json();
  const utr = `ITESTV2${Date.now()}`;
  assert.equal((await pay(made.order_id, utr)).ok, true);
  await delivered(1);

  const d = sent[0], b = JSON.parse(d.body);
  assert.equal(d.headers["x-katana-event"], "payment.success");
  assert.equal(verifyV2Signature(d.headers["x-katana-signature"], d.body, secret), true);
  assert.equal(verifyV2Signature(d.headers["x-katana-signature"], d.body, "whsec_wrong"), false);
  assert.match(d.headers["x-katana-event-id"], /^evt_[0-9a-f]{32}$/);
  assert.equal(b.event_id, d.headers["x-katana-event-id"]);
  assert.deepEqual(Object.keys(b).sort(), ["amount", "currency", "event", "event_id", "gateway", "order_id", "paid_at", "reference", "rrn", "rrn_is_synthetic", "status"]);
  assert.deepEqual([b.event, b.order_id, b.reference, b.status, b.amount, b.currency, b.rrn, b.rrn_is_synthetic, b.gateway],
    ["payment.success", made.order_id, reference, "SUCCESS", 10100, "INR", utr, false, null]);
  assert.ok(Date.parse(b.paid_at));
  // Nothing of the v1 contract is in it.
  assert.equal(/Captured|RESPONSE_CODE|HASH/.test(d.body), false);
  assert.equal(d.headers["x-signature"], undefined);

  // The status API says the same thing, with the id of the event that announced it.
  const read = await (await get(liveKey, reference)).json();
  for (const k of Object.keys(b)) assert.deepEqual(read[k], b[k], k);
});

test("a payment with no bank reference is marked synthetic", opts, async () => {
  sent.length = 0;
  const made = await (await post(liveKey, { amount: 10100, reference: ref(), callback_url: HOOK })).json();
  assert.equal((await pay(made.order_id, null)).ok, true);
  await delivered(1);
  const b = JSON.parse(sent[0].body);
  assert.match(b.rrn, /^\d{12}$/);
  assert.equal(b.rrn_is_synthetic, true);
});

test("an order that expires and is then paid gets payment.expired, then payment.success with previous_status", opts, async () => {
  sent.length = 0;
  const reference = ref();
  const made = await (await post(liveKey, { amount: 10100, reference, callback_url: HOOK })).json();
  await age(made.order_id, 20);
  assert.equal((await (await get(liveKey, reference)).json()).status, "EXPIRED");
  await delivered(1);
  const expired = JSON.parse(sent[0].body);
  assert.deepEqual([sent[0].headers["x-katana-event"], expired.status, expired.rrn, expired.paid_at], ["payment.expired", "EXPIRED", null, null]);
  assert.equal("previous_status" in expired, false);

  assert.equal((await pay(made.order_id, `ITESTV2L${Date.now()}`)).ok, true);
  await delivered(2);
  const paid = JSON.parse(sent[1].body);
  assert.deepEqual([sent[1].headers["x-katana-event"], paid.status, paid.previous_status], ["payment.success", "SUCCESS", "EXPIRED"]);
  assert.notEqual(paid.event_id, expired.event_id);
  await settle();
  assert.equal(sent.length, 2);   // told once per status, never twice
});

test("paid only: the expiry is not sent, the payment that follows is", opts, async () => {
  sent.length = 0;
  assert.ok((await saveWebhookSettings(BANKER, { webhook_events: "PAID_ONLY" }, BY)).ok);
  try {
    const reference = ref();
    const made = await (await post(liveKey, { amount: 10100, reference, callback_url: HOOK })).json();
    await age(made.order_id, 20);
    assert.equal((await readOrderStatus(orderUuidFrom(made.order_id)!))?.status, "EXPIRED");
    await settle();
    assert.equal(sent.length, 0);
    assert.equal((await pay(made.order_id, `ITESTV2P${Date.now()}`)).ok, true);
    await delivered(1);
    assert.equal(sent[0].headers["x-katana-event"], "payment.success");
  } finally {
    await saveWebhookSettings(BANKER, { webhook_events: "ALL" }, BY);
  }
});

test("a failed delivery is retried with the same event id; a resend is a new delivery with a new one", opts, async () => {
  sent.length = 0; answer = 500;
  const made = await (await post(liveKey, { amount: 10100, reference: ref(), callback_url: HOOK })).json();
  const id = orderUuidFrom(made.order_id)!;
  assert.equal((await pay(made.order_id, `ITESTV2R${Date.now()}`)).ok, true);
  await delivered(1);
  await settle();
  const row = (await rows<any>("notification", "SELECT outbox_id::text, status, attempts, event_id, version FROM webhook_outbox WHERE order_id = $1::uuid", [id]))[0];
  assert.deepEqual([row.status, row.attempts, row.version, row.event_id], ["PENDING", 1, "v2", sent[0].headers["x-katana-event-id"]]);

  answer = 200;
  const r = await resendOutbox(row.outbox_id, BY);
  assert.ok(r && r.result.ok && r.result.http_status === 200);
  await delivered(2);
  const [first, second] = sent.map((s) => JSON.parse(s.body));
  assert.equal(sent[1].headers["x-katana-event"], sent[0].headers["x-katana-event"]);
  assert.notEqual(second.event_id, first.event_id);
  assert.equal(sent[1].headers["x-katana-event-id"], second.event_id);
  assert.deepEqual({ ...second, event_id: null }, { ...first, event_id: null });
  assert.equal(verifyV2Signature(sent[1].headers["x-katana-signature"], sent[1].body, secret), true);

  // Both deliveries, with each attempt, are on the order's timeline; a merchant sees no actor.
  const t = await orderTimeline(made.order_id, { staff: false, codes: [BANKER] });
  assert.equal(t?.deliveries.length, 2);
  assert.deepEqual(t?.deliveries.map((d) => d.event), ["payment.success", "payment.success"]);
  assert.deepEqual(t?.deliveries.flatMap((d) => d.attempts.map((a) => a.http_status)).sort(), [200, 500]);
  assert.deepEqual(t?.steps.map((s) => [s.to, s.label]), [["PENDING", "Order created"], ["SUCCESS", "Payment confirmed"]]);
  assert.equal(t?.steps.some((s) => "actor" in s), false);
  assert.equal((await orderTimeline(made.order_id, { staff: true, codes: null }))?.steps[1].actor, BY);
  // …and not on anybody else's.
  assert.equal(await orderTimeline(made.order_id, { staff: false, codes: [OTHER] }), null);
});

test("an order is found by its id, its reference or its bank reference, within scope", opts, async () => {
  const reference = ref(), utr = `ITESTV2S${Date.now()}`;
  const made = await (await post(liveKey, { amount: 10100, reference })).json();
  await pay(made.order_id, utr);
  const mine = { staff: false, codes: [BANKER] };
  for (const q of [made.order_id, reference, utr, reference.slice(0, -2)])
    assert.equal((await searchOrders(q, mine)).some((h) => h.order_id === made.order_id), true, q);
  assert.deepEqual(await searchOrders(reference, { staff: false, codes: [OTHER] }), []);
  assert.deepEqual(await searchOrders(reference, { staff: false, codes: [] }), []);
  assert.equal((await searchOrders(utr, { staff: true, codes: null })).length, 1);
  // This order's callback is sent without being awaited. Let it land here, or it arrives in the
  // next test after that test has emptied `sent` and is read as that test's first delivery.
  await settle();
});

test("a test event is sent in the banker's version, belongs to no order and is attempted once", opts, async () => {
  sent.length = 0; answer = 503;
  const before = (await rows<{ n: number }>("vendorGateway", "SELECT COUNT(*)::int AS n FROM vendor_payin_orders"))[0].n;
  const r = await sendTestEvent(BANKER, "payment.failed", BY);
  assert.ok(r.ok && !r.result.ok && r.result.http_status === 503 && r.result.status === "TEST_FAILED");
  const b = JSON.parse(sent[0].body);
  assert.deepEqual([sent[0].headers["x-katana-event"], b.status, b.reference], ["payment.failed", "FAILED", "test-event"]);
  assert.equal(verifyV2Signature(sent[0].headers["x-katana-signature"], sent[0].body, secret), true);
  const row = (await rows<any>("notification", "SELECT status, is_test, order_id, attempts FROM webhook_outbox WHERE outbox_id = $1::uuid", [r.ok ? r.outbox_id : null]))[0];
  assert.deepEqual([row.status, row.is_test, row.order_id, row.attempts], ["TEST_FAILED", true, null, 1]);
  assert.equal((await rows<{ n: number }>("vendorGateway", "SELECT COUNT(*)::int AS n FROM vendor_payin_orders"))[0].n, before);
  answer = 200;
});

test("a replaced secret signs the next delivery; the old one no longer verifies", opts, async () => {
  sent.length = 0;
  const fresh = await rotateWebhookSecret(BANKER);
  assert.ok(fresh && fresh !== secret);
  const r = await sendTestEvent(BANKER, "payment.success", BY);
  assert.ok(r.ok && r.result.ok);
  assert.equal(verifyV2Signature(sent[0].headers["x-katana-signature"], sent[0].body, fresh!), true);
  assert.equal(verifyV2Signature(sent[0].headers["x-katana-signature"], sent[0].body, secret), false);
  secret = fresh!;
});

test("a banker on v1 is sent the v1 callback, exactly as before", opts, async () => {
  sent.length = 0;
  assert.ok((await saveWebhookSettings(BANKER, { webhook_version: "v1" }, BY)).ok);
  const creds = (await getCheckoutCreds(BANKER, true)) ?? (await issueCheckoutCreds(BANKER, "HMAC_SHA256", true));
  try {
    const reference = ref(), utr = `ITESTV1${Date.now()}`;
    const made = await (await post(liveKey, { amount: 10100, reference, callback_url: HOOK })).json();
    assert.equal((await pay(made.order_id, utr)).ok, true);
    await delivered(1);
    const d = sent[0], b = JSON.parse(d.body);
    assert.deepEqual([b.ORDER_ID, b.STATUS, b.RESPONSE_CODE, b.RRN, b.AMOUNT], [reference, "Captured", "000", utr, "101"]);
    const { HASH, ...fields } = b;
    assert.equal(verifyKatanaHash(fields, creds.salt, HASH), true);
    assert.equal(d.headers["x-event-type"], "payin.status");
    for (const h of ["x-katana-event", "x-katana-signature", "x-katana-event-id"]) assert.equal(d.headers[h], undefined);
    const row = (await rows<any>("notification", "SELECT version, event_id FROM webhook_outbox WHERE order_id = $1::uuid", [orderUuidFrom(made.order_id)]))[0];
    assert.deepEqual([row.version, row.event_id], ["v1", null]);
  } finally {
    await saveWebhookSettings(BANKER, { webhook_version: "v2" }, BY);
  }
});

test("a banker set to v2 with no signing secret yet is still sent the v1 callback", opts, async () => {
  sent.length = 0; answer = 200;
  // What a banker created after the migration looks like: v2 by default, no secret made yet.
  await rows("merchant", "UPDATE merchants SET webhook_version = 'v2', webhook_secret = NULL WHERE merchant_code = $1", [BANKER]);
  const creds = (await getCheckoutCreds(BANKER, true)) ?? (await issueCheckoutCreds(BANKER, "HMAC_SHA256", true));
  try {
    const st = (await listWebhookSettings([BANKER]))[0];
    assert.deepEqual([st.webhook_version, st.effective_version, st.has_secret], ["v2", "v1", false]);
    const reference = ref();
    const made = await (await post(liveKey, { amount: 10100, reference, callback_url: HOOK })).json();
    assert.equal((await pay(made.order_id, `ITESTNS${Date.now()}`)).ok, true);
    await delivered(1);
    const b = JSON.parse(sent[0].body);
    assert.deepEqual([b.ORDER_ID, b.STATUS, sent[0].headers["x-event-type"], sent[0].headers["x-katana-event"]], [reference, "Captured", "payin.status", undefined]);
    const { HASH, ...fields } = b;
    assert.equal(verifyKatanaHash(fields, creds.salt, HASH), true);
  } finally {
    // Making the secret is what puts v2 in force.
    secret = (await rotateWebhookSecret(BANKER))!;
    assert.equal((await listWebhookSettings([BANKER]))[0].effective_version, "v2");
  }
});

test("paid only applies to a v1 banker too", opts, async () => {
  sent.length = 0;
  assert.ok((await saveWebhookSettings(BANKER, { webhook_version: "v1", webhook_events: "PAID_ONLY" }, BY)).ok);
  try {
    const made = await (await post(liveKey, { amount: 10100, reference: ref(), callback_url: HOOK })).json();
    await age(made.order_id, 20);
    assert.equal((await readOrderStatus(orderUuidFrom(made.order_id)!))?.status, "EXPIRED");
    await settle();
    assert.equal(sent.length, 0);
    assert.equal((await pay(made.order_id, `ITESTV1P${Date.now()}`)).ok, true);
    await delivered(1);
    assert.equal(JSON.parse(sent[0].body).STATUS, "Captured");
  } finally {
    await saveWebhookSettings(BANKER, { webhook_version: "v2", webhook_events: "ALL" }, BY);
  }
});

test("a delivery is attempted seven times, each with the same event id, then given up", opts, async () => {
  sent.length = 0; answer = 500;
  const made = await (await post(liveKey, { amount: 10100, reference: ref(), callback_url: HOOK })).json();
  const id = orderUuidFrom(made.order_id)!;
  assert.equal((await pay(made.order_id, `ITESTV27${Date.now()}`)).ok, true);
  await delivered(1);
  await settle();
  const outbox = (await rows<{ outbox_id: string }>("notification", "SELECT outbox_id::text FROM webhook_outbox WHERE order_id = $1::uuid", [id]))[0].outbox_id;
  // Each retry is due after its wait; make it due now and attempt it, until the row stops being retried.
  const statuses: string[] = [];
  for (let i = 0; i < 10; i++) {
    await rows("notification", "UPDATE webhook_outbox SET next_attempt_at = now() WHERE outbox_id = $1::uuid AND status = 'PENDING'", [outbox]);
    const r = await deliverNow(outbox);
    if (!r) break;
    statuses.push(r.status);
  }
  answer = 200;
  assert.deepEqual(statuses, ["PENDING", "PENDING", "PENDING", "PENDING", "PENDING", "DEAD_LETTER"]);
  assert.equal(sent.length, 7);
  assert.equal(new Set(sent.map((d) => d.headers["x-katana-event-id"])).size, 1);
  const row = (await rows<any>("notification", "SELECT status, attempts FROM webhook_outbox WHERE outbox_id = $1::uuid", [outbox]))[0];
  assert.deepEqual([row.status, row.attempts], ["DEAD_LETTER", 7]);
});

test("a merchant or banker login may act only on its own bankers' orders", opts, async () => {
  const session = (persona: string, scope_id: string | null) => ({ user_id: "u", email: BY, full_name: "", persona, scope_id, scope_label: "", exp: 0 }) as any;
  const banker = session("MERCHANT", BANKER), provider = session("PROVIDER", PROVIDER), admin = session("SUPER_ADMIN", null);
  assert.equal(await orderInScope(banker, BANKER), true);
  assert.equal(await orderInScope(banker, OTHER), false);
  assert.equal(await orderInScope(banker, null), false);           // a staff test order belongs to no banker
  assert.equal(await orderInScope(provider, BANKER), true);
  assert.equal(await orderInScope(provider, "SOMEONE-ELSES-BANKER"), false);
  assert.equal(await orderInScope(session("BANKER", "x"), BANKER), false);
  for (const m of [BANKER, OTHER, null]) assert.equal(await orderInScope(admin, m), true);
});

test("each request is in the log, with the key cut out and the body kept for staff only", opts, async () => {
  const reference = ref();
  await post(liveKey, { amount: 10100, reference, metadata: { secret: "do-not-log-this-value" } });
  await settle();
  const staff = (await readApiLog({ merchantCodes: null, full: true, merchant: BANKER, limit: 500 })).find((r) => (r.request_body as any)?.reference === reference);
  assert.ok(staff, "the request is logged");
  assert.deepEqual([staff!.api_version, staff!.method, staff!.endpoint, staff!.http_status, staff!.livemode], ["v2", "POST", "/v2/orders", 201, true]);
  assert.equal(JSON.stringify(staff).includes("do-not-log-this-value"), false);
  assert.equal(JSON.stringify(staff).includes(liveKey), false);
  const mine = await readApiLog({ merchantCodes: [BANKER] });
  assert.ok(mine.length > 0 && mine.every((r) => !("request_body" in r) && r.merchant_id === BANKER));
  assert.deepEqual(await readApiLog({ merchantCodes: [OTHER], limit: 5 }).then((r) => r.filter((x) => x.merchant_id !== OTHER)), []);
});
