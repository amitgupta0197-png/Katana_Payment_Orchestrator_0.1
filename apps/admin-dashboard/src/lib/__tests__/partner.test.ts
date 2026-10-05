// The partner module's rules (lib/partner/rules) and its guide (public/katana-partner-guide.html).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  cleanSubMerchant, flowsWithinPartner, limitsProblem, moveSub, orderFlowFor, partnerIdFromOutbox, partnerKeyMode,
  partnerOrderRefusal, partnerSigner, type SubLike,
} from "@/lib/partner/rules";
import { PARTNER_API_ERRORS } from "@/lib/partner/api-errors";
import { V2_ERRORS } from "@/lib/v2-api-errors";
import { namesGateway } from "@/lib/merchant-safe";

const sub = (o: Partial<SubLike> = {}): SubLike => ({ status: "ACTIVE", flows: "BOTH", min_amount: null, max_amount: null, daily_amount: null, ...o });
const live = (o: Partial<Parameters<typeof partnerOrderRefusal>[0]> = {}) =>
  partnerOrderRefusal({ partner: { status: "ACTIVE" }, sub: sub(), livemode: true, amount: 100, todayAmount: 0, ...o });

test("a new sub-merchant needs an external id, a legal name and a valid PAN", () => {
  const ok = cleanSubMerchant({ external_id: " MER-1 ", legal_name: " Acme Traders ", pan: "abcde1234f" });
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.value.external_id, "MER-1");
    assert.equal(ok.value.legal_name, "Acme Traders");
    assert.equal(ok.value.pan, "ABCDE1234F");
    assert.equal(ok.value.flows, "BOTH");
  }
  const noPan = cleanSubMerchant({ external_id: "M1", legal_name: "Acme" });
  assert.ok(!noPan.ok && noPan.problem.field === "pan");
  const badId = cleanSubMerchant({ external_id: "has space", legal_name: "Acme", pan: "ABCDE1234F" });
  assert.ok(!badId.ok && badId.problem.field === "external_id");
  const badPan = cleanSubMerchant({ external_id: "M1", legal_name: "Acme", pan: "ABCDE12345" });
  assert.ok(!badPan.ok && badPan.problem.field === "pan");
});

test("a GSTIN must carry the sub-merchant's PAN", () => {
  const ok = cleanSubMerchant({ external_id: "M1", legal_name: "Acme", pan: "ABCDE1234F", gstin: "27ABCDE1234F1Z5" });
  assert.ok(ok.ok);
  const other = cleanSubMerchant({ external_id: "M1", legal_name: "Acme", pan: "ABCDE1234F", gstin: "27ZZZZZ9999Z1Z5" });
  assert.ok(!other.ok && other.problem.field === "gstin");
});

test("an update checks only the fields it sends; amounts are rupees with at most two places", () => {
  const u = cleanSubMerchant({ max_amount: 5000 }, true);
  assert.ok(u.ok && Object.keys(u.value).join() === "max_amount");
  const bad = cleanSubMerchant({ max_amount: 10.555 }, true);
  assert.ok(!bad.ok && bad.problem.field === "max_amount");
  const neg = cleanSubMerchant({ daily_amount: -1 }, true);
  assert.ok(!neg.ok);
  assert.deepEqual(limitsProblem({ min_amount: 500, max_amount: 100 })?.field, "min_amount");
  assert.deepEqual(limitsProblem({ max_amount: 5000, daily_amount: 1000 })?.field, "max_amount");
  assert.equal(limitsProblem({ min_amount: 10, max_amount: 100, daily_amount: 1000 }), null);
});

test("status moves: staff review, a partner may resubmit a rejected one", () => {
  assert.deepEqual(moveSub("PENDING", "approve"), { ok: true, to: "ACTIVE" });
  assert.deepEqual(moveSub("PENDING", "reject"), { ok: true, to: "REJECTED" });
  assert.deepEqual(moveSub("ACTIVE", "suspend"), { ok: true, to: "SUSPENDED" });
  assert.deepEqual(moveSub("SUSPENDED", "reactivate"), { ok: true, to: "ACTIVE" });
  assert.deepEqual(moveSub("REJECTED", "resubmit"), { ok: true, to: "PENDING" });
  assert.equal(moveSub("ACTIVE", "approve").ok, false);
  assert.equal(moveSub("REJECTED", "approve").ok, false);
  assert.equal(moveSub("SUSPENDED", "resubmit").ok, false);
});

test("live orders need an ACTIVE sub-merchant; a pending one may test", () => {
  assert.equal(live(), null);
  assert.equal(live({ sub: sub({ status: "PENDING" }) })?.code, "SUB_MERCHANT_NOT_ACTIVE");
  assert.equal(live({ sub: sub({ status: "PENDING" }), livemode: false }), null);
  assert.equal(live({ sub: sub({ status: "SUSPENDED" }), livemode: false })?.code, "SUB_MERCHANT_NOT_ACTIVE");
  assert.equal(live({ sub: sub({ status: "REJECTED" }), livemode: false })?.code, "SUB_MERCHANT_NOT_ACTIVE");
  assert.equal(live({ partner: { status: "SUSPENDED" } })?.code, "PARTNER_SUSPENDED");
});

test("the sub-merchant's limits: per order always, per day on live orders", () => {
  assert.equal(live({ sub: sub({ min_amount: 200 }) })?.code, "SUB_MERCHANT_MIN_AMOUNT");
  assert.equal(live({ sub: sub({ max_amount: 50 }) })?.code, "SUB_MERCHANT_MAX_AMOUNT");
  const day = live({ sub: sub({ daily_amount: 1000 }), todayAmount: 950 });
  assert.equal(day?.code, "SUB_MERCHANT_DAILY_LIMIT");
  assert.equal(day?.limit, 1000);
  assert.equal(day?.actual, 1050);
  assert.equal(live({ sub: sub({ daily_amount: 1000 }), todayAmount: 900 }), null);
  assert.equal(live({ sub: sub({ daily_amount: 1000 }), todayAmount: 950, livemode: false }), null);
});

test("the flow a partner order takes", () => {
  assert.deepEqual(orderFlowFor("BOTH", null), { ok: true, flow: null });
  assert.deepEqual(orderFlowFor("P2P", null), { ok: true, flow: "P2P" });
  assert.deepEqual(orderFlowFor("BOTH", "INTENT"), { ok: true, flow: "INTENT" });
  const r = orderFlowFor("P2P", "INTENT");
  assert.ok(!r.ok && r.refusal.code === "FLOW_NOT_ALLOWED");
  assert.equal(flowsWithinPartner("BOTH", "P2P"), false);
  assert.equal(flowsWithinPartner("P2P", "P2P"), true);
  assert.equal(flowsWithinPartner("INTENT", "BOTH"), true);
  assert.equal(flowsWithinPartner("INTENT", null), true);
});

test("keys, signer and outbox owner never look like a banker's", () => {
  assert.equal(partnerKeyMode("pk_live_abc"), true);
  assert.equal(partnerKeyMode("pk_test_abc"), false);
  assert.equal(partnerKeyMode("sk_live_abc"), null);
  assert.equal(partnerSigner("x"), "partner:x");
  assert.equal(partnerIdFromOutbox("partner:abc"), "abc");
  assert.equal(partnerIdFromOutbox("M10001"), null);
});

test("the partner API keeps every v2 code with its status", () => {
  for (const [code, v] of Object.entries(V2_ERRORS)) assert.equal(PARTNER_API_ERRORS[code as keyof typeof PARTNER_API_ERRORS].status, v.status, code);
});

const GUIDE = readFileSync(new URL("../../../public/katana-partner-guide.html", import.meta.url), "utf8");

test("the partner guide lists every error code the API can return", () => {
  for (const code of Object.keys(PARTNER_API_ERRORS)) assert.ok(GUIDE.includes(code), `guide is missing ${code}`);
});

test("the partner guide names no payment gateway", () => {
  assert.equal(namesGateway(GUIDE), false);
});
