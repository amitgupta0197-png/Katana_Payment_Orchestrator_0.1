// Partners on real orders (vendorGateway 0044, lib/partner): a partner's sub-merchant takes test
// orders through the partner's bankers, the reference is unique per partner, the sub-merchant's
// status and limits are enforced, an exclusive partner's bankers refuse their own Keys, status
// changes are logged by the database, and a paid order's callback goes to the partner, never the
// banker. Run with `pnpm test:integration`. IT WRITES ROWS, so it only runs against a local
// database; the test merchant is a partner only while it runs.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rows } from "@/lib/pg";
import { confirmKatanaOrder, createKatanaOrder, PartnerOnlyError } from "@/lib/katana-order";
import { setProviderFlow } from "@/lib/payin-flow-store";
import { actOnSub, createPartner, createSub, getSub, listPartnerEvents, rotatePartnerSecret, setPartnerWebhook, subTodayAmount, updatePartner, updateSub, type PartnerRow } from "@/lib/partner/store";
import { createPartnerOrder, PartnerReferenceError, PartnerRefusalError } from "@/lib/partner/orders";
import { issuePartnerKey, resolvePartnerKey, revokePartnerKey } from "@/lib/partner/keys";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };
const PROVIDER = process.env.TEST_PROVIDER_ID ?? "a0000000-0000-0000-0000-000000000001";
const A = process.env.TEST_BANKER ?? "M10001";
const CODE = "ITESTPARTNER";
const BY = "integration-test-partner@local";
const R = String(Date.now()).slice(-7);
const PREFIX = "ITEST-PTN-";
let n = 0;
const ref = () => `${PREFIX}${R}-${n++}`;
let partner: PartnerRow;

async function cleanup() {
  const p = await rows<{ id: string }>("vendorGateway", `SELECT id::text FROM partners WHERE code = $1 OR provider_id = $2`, [CODE, PROVIDER]);
  await rows("vendorGateway", `DELETE FROM vendor_payin_orders WHERE order_id LIKE '${PREFIX}%'`);
  for (const { id } of p) {
    await rows("notification", `DELETE FROM webhook_outbox WHERE merchant_id = $1`, [`partner:${id}`]);
    await rows("vendorGateway", `ALTER TABLE partner_events DISABLE TRIGGER partner_events_locked_trg`);
    try { await rows("vendorGateway", `DELETE FROM partner_events WHERE partner_id = $1::uuid`, [id]); }
    finally { await rows("vendorGateway", `ALTER TABLE partner_events ENABLE TRIGGER partner_events_locked_trg`); }
    await rows("vendorGateway", `DELETE FROM partner_api_keys WHERE partner_id = $1::uuid`, [id]);
    await rows("vendorGateway", `DELETE FROM partner_sub_merchants WHERE partner_id = $1::uuid`, [id]);
    await rows("vendorGateway", `DELETE FROM partners WHERE id = $1::uuid`, [id]);
  }
}

before(async () => {
  if (!LOCAL) return;
  await cleanup();
  await setProviderFlow(PROVIDER, { flow: "BOTH", active: "P2P", by: BY });
  partner = await createPartner({ provider_id: PROVIDER, code: CODE, name: "Integration test partner", exclusive: true, own_gateway: "PAYATOM" }, BY);
});
after(async () => {
  if (LOCAL) {
    await cleanup();
    await setProviderFlow(PROVIDER, { flow: "UNSET", by: BY });
    await rows("provider", "DELETE FROM provider_payin_flow_history WHERE changed_by = $1", [BY]);
    await rows("provider", "UPDATE providers SET payin_flow_set_by = NULL, payin_flow_set_at = NULL WHERE payin_flow_set_by = $1", [BY]);
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
});

const newSub = (o: Record<string, unknown> = {}) => createSub(partner, {
  external_id: `${PREFIX}${R}-sub-${n++}`, legal_name: "Acme Traders", pan: "ABCDE1234F", ...o,
}, "API", `partner:${CODE}`);

const order = (sub: Awaited<ReturnType<typeof newSub>>, o: { reference?: string; amount?: number; livemode?: boolean; flow?: "P2P" | "INTENT" } = {}) =>
  createPartnerOrder({ partner, sub, livemode: o.livemode ?? false, reference: o.reference ?? ref(), amount: o.amount ?? 101, flow: o.flow ?? null });

/** The callback stamp: confirmKatanaOrder sends it without waiting, so wait for it here. */
async function callbackOf(id: string): Promise<any> {
  for (let i = 0; i < 40; i++) {
    const cb = (await stored(id)).meta.callback;
    if (cb) return cb;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

const stored = async (id: string) => (await rows<{ merchant_id: string; signed_by: string | null; partner_id: string | null; partner_sub_merchant_id: string | null; meta: any }>("vendorGateway",
  `SELECT merchant_id, signed_by, partner_id::text, partner_sub_merchant_id::text, meta FROM vendor_payin_orders WHERE id = $1::uuid`, [id]))[0];

test("a sub-merchant made through the API waits for review; the database logs it", opts, async () => {
  const s = await newSub();
  assert.equal(s.status, "PENDING");
  assert.match(s.sub_code, /^SM_[0-9A-F]{14}$/);
  const ev = await listPartnerEvents(partner.id, s.id);
  assert.equal(ev[0].action, "CREATED");
  assert.equal(ev[0].to_status, "PENDING");
  await assert.rejects(newSub({ external_id: s.external_id }), /already exists/);
});

test("a pending sub-merchant takes a test order on the partner's banker, stamped with the partner", opts, async () => {
  const s = await newSub();
  const r = await order(s);
  assert.equal(r.reused, false);
  const o = await stored(r.order.id);
  assert.equal(o.merchant_id, A);
  assert.equal(o.signed_by, `partner:${partner.id}`);
  assert.equal(o.partner_id, partner.id);
  assert.equal(o.partner_sub_merchant_id, s.id);
  assert.equal(o.meta.partner.sub_merchant, s.sub_code);
  assert.equal(o.meta.partner.external_id, s.external_id);
  await assert.rejects(rows("vendorGateway", `UPDATE vendor_payin_orders SET partner_sub_merchant_id = gen_random_uuid() WHERE id = $1::uuid`, [r.order.id]),
    /cannot be changed/);
});

test("a pending sub-merchant takes no live order; an approved one passes the sub-merchant check", opts, async () => {
  const s = await newSub();
  await assert.rejects(order(s, { livemode: true }), (e) => e instanceof PartnerRefusalError && e.refusal.code === "SUB_MERCHANT_NOT_ACTIVE");
  const approved = await actOnSub(s, "approve", null, BY);
  assert.equal(approved.status, "ACTIVE");
  const ev = await listPartnerEvents(partner.id, s.id);
  assert.equal(ev[0].action, "STATUS");
  assert.deepEqual([ev[0].from_status, ev[0].to_status, ev[0].actor], ["PENDING", "ACTIVE", BY]);
  await assert.rejects(rows("vendorGateway", `UPDATE partner_events SET actor = 'x' WHERE id = $1`, [ev[0].id]), /append-only/);
  // A live order now gets past the sub-merchant check: the banker's own rules decide (it may be live
  // locally, or refuse for its own reasons).
  await order(approved, { livemode: true }).then(
    (r) => assert.equal(r.order.livemode, true),
    (e) => assert.ok(!(e instanceof PartnerRefusalError), (e as Error).message));
});

test("a reference is one order per partner: a retry finds it, another amount or merchant is refused", opts, async () => {
  const s1 = await newSub(), s2 = await newSub();
  const reference = ref();
  const first = await order(s1, { reference, amount: 150 });
  const again = await order(s1, { reference, amount: 150 });
  assert.equal(again.reused, true);
  assert.equal(again.order.id, first.order.id);
  await assert.rejects(order(s1, { reference, amount: 151 }), PartnerReferenceError);
  await assert.rejects(order(s2, { reference, amount: 150 }), PartnerReferenceError);
});

test("the sub-merchant's flows and per-order limits", opts, async () => {
  const s = await newSub({ flows: "P2P", min_amount: 50, max_amount: 500 });
  await assert.rejects(order(s, { flow: "INTENT" }), (e) => e instanceof PartnerRefusalError && e.refusal.code === "FLOW_NOT_ALLOWED");
  await assert.rejects(order(s, { amount: 10 }), (e) => e instanceof PartnerRefusalError && e.refusal.code === "SUB_MERCHANT_MIN_AMOUNT");
  await assert.rejects(order(s, { amount: 501 }), (e) => e instanceof PartnerRefusalError && e.refusal.code === "SUB_MERCHANT_MAX_AMOUNT");
  const ok = await order(s, { amount: 500 });
  assert.equal(ok.order.channel_type, "P2P");
  assert.equal(await subTodayAmount(s.id), 0);   // test orders never count toward the day
});

test("a partner's change to an active sub-merchant's PAN sends it back for review", opts, async () => {
  const s = await actOnSub(await newSub(), "approve", null, BY);
  const same = await updateSub(partner, s, { phone: "+919800000000" }, `partner:${CODE}`, false);
  assert.equal(same.status, "ACTIVE");
  const changed = await updateSub(partner, same, { pan: "ZZZZZ9999Z" }, `partner:${CODE}`, false);
  assert.equal(changed.status, "PENDING");
  const staffChange = await updateSub(partner, await actOnSub(changed, "approve", null, BY), { pan: "ABCDE1234F" }, BY, true);
  assert.equal(staffChange.status, "ACTIVE");
});

test("a suspended sub-merchant takes nothing; a suspended partner takes nothing", opts, async () => {
  const s = await newSub();
  const susp = await actOnSub(s, "suspend", "documents expired", BY);
  await assert.rejects(order(susp), (e) => e instanceof PartnerRefusalError && e.refusal.code === "SUB_MERCHANT_NOT_ACTIVE");
  const s2 = await newSub();
  partner = (await updatePartner(partner.id, { status: "SUSPENDED" }, BY))!;
  try {
    await assert.rejects(order(s2), (e) => e instanceof PartnerRefusalError && e.refusal.code === "PARTNER_SUSPENDED");
  } finally { partner = (await updatePartner(partner.id, { status: "ACTIVE" }, BY))!; }
});

test("an exclusive partner's banker refuses an order signed with its own Key", opts, async () => {
  await assert.rejects(createKatanaOrder({ orderId: ref(), amount: 101, currency: "INR", merchantId: A, livemode: false, flow: "P2P", routeAcrossBankers: true }),
    (e) => e instanceof PartnerOnlyError && e.code === "PARTNER_ONLY");
  partner = (await updatePartner(partner.id, { exclusive: false }, BY))!;
  try {
    const r = await createKatanaOrder({ orderId: ref(), amount: 101, currency: "INR", merchantId: A, livemode: false, flow: "P2P" });
    assert.equal((await stored(r.order.id)).partner_id, null);
  } finally { partner = (await updatePartner(partner.id, { exclusive: true }, BY))!; }
});

test("partner keys: the prefix is the mode; a revoked key opens nothing", opts, async () => {
  const { key, secret } = await issuePartnerKey(partner.id, false, "test", BY);
  assert.match(secret, /^pk_test_/);
  const owner = await resolvePartnerKey(secret);
  assert.equal(owner?.partner.id, partner.id);
  assert.equal(owner?.livemode, false);
  assert.equal(await resolvePartnerKey(secret.replace("pk_test_", "pk_live_")), null);
  assert.equal(await revokePartnerKey(partner.id, key.id, BY), true);
  assert.equal(await resolvePartnerKey(secret), null);
});

test("a paid order's callback goes to the partner, signed with the partner's secret, never to the banker", opts, async () => {
  await setPartnerWebhook(partner.id, { url: "https://partner.example/katana" }, BY);
  // Without a secret nothing is sent.
  const s = await newSub();
  const r1 = await order(s);
  await confirmKatanaOrder({ id: r1.order.id, outcome: "SUCCESS", evidence: "MANUAL", actor: BY, utr: `9${R}0001` });
  assert.equal((await callbackOf(r1.order.id))?.skipped, "no signing secret");

  assert.match((await rotatePartnerSecret(partner.id, BY))!, /^whsec_/);
  const r2 = await order(s);
  await confirmKatanaOrder({ id: r2.order.id, outcome: "SUCCESS", evidence: "MANUAL", actor: BY, utr: `9${R}0002` });
  const cb = await callbackOf(r2.order.id);
  assert.equal(cb.version, "partner");
  assert.equal(cb.target, "https://partner.example/katana");
  const box = await rows<{ merchant_id: string; version: string; payload: any }>("notification",
    `SELECT merchant_id, version, payload FROM webhook_outbox WHERE outbox_id = $1::uuid`, [cb.outbox_id]);
  assert.equal(box[0].merchant_id, `partner:${partner.id}`);
  assert.equal(box[0].version, "v2");
  assert.equal(box[0].payload.status, "SUCCESS");
  assert.equal(box[0].payload.sub_merchant_id, s.sub_code);
  assert.equal(box[0].payload.external_id, s.external_id);
  assert.equal(box[0].payload.gateway, null);
  // Nothing was queued for the banker.
  const bankerRows = await rows("notification", `SELECT 1 FROM webhook_outbox WHERE merchant_id = $1 AND order_id = $2::uuid`, [A, r2.order.id]);
  assert.equal(bankerRows.length, 0);
});

test("getSub finds a sub-merchant by SM_ id, external id or uuid, and only the partner's own", opts, async () => {
  const s = await newSub();
  for (const k of [s.sub_code, s.external_id, s.id]) assert.equal((await getSub(partner.id, k))?.id, s.id);
  assert.equal(await getSub("00000000-0000-0000-0000-000000000000", s.sub_code), null);
});
