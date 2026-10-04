// Channel accounting rules: reconciliation states (lib/payin-recon), fees per channel
// (lib/channel-fees), chargeback rules and decisions (lib/chargeback-rules), the merchant view of a
// chargeback (lib/chargeback-view) and "All" as the sum of the channels (lib/channel-accounts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { reconStateOf, reconVariance, RECON_STATES, ORDER_RECON_STATES, type ReconFacts } from "@/lib/payin-recon";
import { feeOn, feesByChannel, pickFeeRule, effectiveBps, type FeeRule } from "@/lib/channel-fees";
import { chainProblems, decideChargeback, pickCbRule, ruleDebit, stateAfterPostings, type CbRule } from "@/lib/chargeback-rules";
import { merchantChargeback, merchantExplanation } from "@/lib/chargeback-view";
import { emptyAccount, sumAccounts } from "@/lib/channel-accounts";
import type { ChargebackRow } from "@/lib/chargebacks-store";

const facts = (f: Partial<ReconFacts>): ReconFacts => ({
  paid: false, closed: false, amount: 100, statedUtr: false, credits: 0, creditAmount: 0, pointedMismatch: false, duplicate: false, review: false, ...f,
});

test("reconciliation states", () => {
  assert.equal(reconStateOf(facts({ paid: true, statedUtr: true })), "MATCHED");
  assert.equal(reconStateOf(facts({ paid: true, credits: 1, creditAmount: 100 })), "MATCHED");
  assert.equal(reconStateOf(facts({ paid: true, credits: 1, creditAmount: 90 })), "AMOUNT_MISMATCH");
  assert.equal(reconStateOf(facts({ paid: true, pointedMismatch: true })), "AMOUNT_MISMATCH");
  assert.equal(reconStateOf(facts({ paid: true, credits: 2, creditAmount: 200 })), "DUPLICATE");
  assert.equal(reconStateOf(facts({ paid: true, statedUtr: true, duplicate: true })), "DUPLICATE");
  assert.equal(reconStateOf(facts({ paid: true })), "MISSING_EXTERNAL");
  assert.equal(reconStateOf(facts({ paid: true, review: true })), "MANUAL_REVIEW");
  assert.equal(reconStateOf(facts({ credits: 1, creditAmount: 100 })), "STATUS_MISMATCH");
  assert.equal(reconStateOf(facts({ closed: true, credits: 1, creditAmount: 100 })), "STATUS_MISMATCH");
  assert.equal(reconStateOf(facts({ review: true })), "MANUAL_REVIEW");
  assert.equal(reconStateOf(facts({ closed: true })), "NOT_PAID");
  assert.equal(reconStateOf(facts({})), "PENDING");
  // MISSING_INTERNAL and SETTLEMENT_MISMATCH are not about one order.
  assert.deepEqual(RECON_STATES.filter((s) => !ORDER_RECON_STATES.includes(s)), ["MISSING_INTERNAL", "SETTLEMENT_MISMATCH"]);
});

test("reconciliation variance is what expected and observed are apart by", () => {
  assert.equal(reconVariance("MATCHED", 100, 100), 0);
  assert.equal(reconVariance("AMOUNT_MISMATCH", 100, 90), 10);
  assert.equal(reconVariance("STATUS_MISMATCH", 100, 100), 100);
  assert.equal(reconVariance("MISSING_EXTERNAL", 100, 0), 100);
  assert.equal(reconVariance("MANUAL_REVIEW", 100, 0), 0);
  assert.equal(reconVariance("PENDING", 100, 0), 0);
});

const feeRule = (o: Partial<FeeRule>): FeeRule => ({
  id: "r", provider_id: "P", merchant_key: null, channel_type: null, upline_bps: 0, katana_bps: 200, downline_bps: 0, gst_bps: 1800,
  version: 1, effective_from: "2026-01-01T00:00:00Z", effective_to: null, ...o,
});

test("a channel's own fee rate beats one for both, a banker's beats the merchant's", () => {
  const both = feeRule({ id: "both" }), intent = feeRule({ id: "intent", channel_type: "INTENT", katana_bps: 300 });
  const banker = feeRule({ id: "banker", merchant_key: "B1", katana_bps: 100 });
  const at = new Date("2026-06-01T00:00:00Z");
  assert.equal(pickFeeRule([both, intent], { providerId: "P", banker: "B2", channel: "INTENT", at })?.id, "intent");
  assert.equal(pickFeeRule([both, intent], { providerId: "P", banker: "B2", channel: "P2P", at })?.id, "both");
  assert.equal(pickFeeRule([both, intent, banker], { providerId: "P", banker: "B1", channel: "INTENT", at })?.id, "banker");
  assert.equal(pickFeeRule([both], { providerId: "Q", banker: "B1", channel: "P2P", at }), null);
  assert.equal(feeOn(1000, both), 23.6);        // 2% + 18% GST on it
  assert.equal(effectiveBps(both), 236);
  assert.equal(feeOn(1000, null), 0);
  const f = feesByChannel([
    { banker: "B2", channel: "INTENT", day: "2026-06-01", gross: 1000 },
    { banker: "B2", channel: "P2P", day: "2026-06-01", gross: 1000 },
  ], [both, intent], () => "P");
  assert.deepEqual(f.byChannel, { INTENT: 35.4, P2P: 23.6 });
});

const cbRule = (o: Partial<CbRule>): CbRule => ({
  id: "c", provider_id: "P", banker_code: null, channel_type: null, reason_code: null, debit_bps: 10_000, auto_debit: true,
  auto_max_amount: null, version: 1, effective_from: "2026-01-01T00:00:00Z", effective_to: null, ...o,
});

test("chargeback rule: most specific in force wins; none means none", () => {
  const at = new Date("2026-06-01T00:00:00Z");
  const all = cbRule({ id: "all" }), p2p = cbRule({ id: "p2p", channel_type: "P2P", debit_bps: 5_000 });
  const fraud = cbRule({ id: "fraud", channel_type: "P2P", reason_code: "10.4", debit_bps: 0 });
  const ended = cbRule({ id: "ended", channel_type: "INTENT", effective_to: "2026-05-01T00:00:00Z" });
  const s = (channel: string, reasonCode: string | null) => ({ providerId: "P", banker: "B1", channel, reasonCode, at });
  assert.equal(pickCbRule([all, p2p, fraud, ended], s("P2P", null))?.id, "p2p");
  assert.equal(pickCbRule([all, p2p, fraud, ended], s("P2P", "10.4"))?.id, "fraud");
  assert.equal(pickCbRule([all, p2p, fraud, ended], s("INTENT", null))?.id, "all");
  assert.equal(pickCbRule([ended], s("INTENT", null)), null);
  assert.equal(pickCbRule([cbRule({ provider_id: "Q" })], s("P2P", null)), null);
  assert.equal(ruleDebit(999.99, { debit_bps: 5_000 }), 500);
});

test("chargeback decisions: nothing is debited on a guess", () => {
  const order = { id: "o", status: "SUCCESS", amount: 1000, channel_type: "P2P", merchant_id: "B1" };
  const d = (o: Partial<Parameters<typeof decideChargeback>[0]>) =>
    decideChargeback({ amount: 1000, order, candidates: 1, alreadyClaimed: 0, rule: cbRule({}), ...o });
  assert.equal(d({ order: null, candidates: 0 }).state, "CB_PENDING_MATCH");
  assert.equal(d({ order: null, candidates: 3 }).state, "CB_MANUAL_REVIEW");
  assert.equal(d({ order: { ...order, status: "EXPIRED" } }).state, "CB_MANUAL_REVIEW");
  assert.equal(d({ amount: 1200 }).state, "CB_MANUAL_REVIEW");
  assert.equal(d({ alreadyClaimed: 600, amount: 500 }).state, "CB_MANUAL_REVIEW");
  assert.equal(d({ rule: null }).state, "CB_RULE_EXCEPTION");
  assert.equal(d({ rule: cbRule({ auto_debit: false }) }).state, "CB_MANUAL_REVIEW");
  assert.equal(d({ rule: cbRule({ auto_max_amount: 500 }) }).state, "CB_MANUAL_REVIEW");
  assert.deepEqual([d({ rule: cbRule({ debit_bps: 0 }) }).state, d({ rule: cbRule({ debit_bps: 0 }) }).debit], ["CB_MATCHED", 0]);
  assert.deepEqual([d({}).state, d({}).debit], ["CB_DEBIT_POSTED", 1000]);
  assert.deepEqual([d({ rule: cbRule({ debit_bps: 2_500 }) }).state, d({ rule: cbRule({ debit_bps: 2_500 }) }).debit], ["CB_PARTIAL_DEBIT", 250]);
  assert.equal(stateAfterPostings(1000, 1000, 1000), "CB_REVERSED");
  assert.equal(stateAfterPostings(1000, 1000, 400), "CB_DEBIT_POSTED");
  assert.equal(stateAfterPostings(1000, 250, 0), "CB_PARTIAL_DEBIT");
});

test("a chargeback is reconciled only when the chain agrees", () => {
  const base = { state: "CB_DEBIT_POSTED" as const, order_id: "o", channel_type: "P2P", order_channel: "P2P", calculated_debit: 500, debited: 500, override: false };
  assert.deepEqual(chainProblems(base), []);
  assert.equal(chainProblems({ ...base, debited: 400 }).length, 1);
  assert.deepEqual(chainProblems({ ...base, debited: 400, override: true }), []);
  assert.equal(chainProblems({ ...base, order_channel: "INTENT" }).length, 1);
  assert.deepEqual(chainProblems({ ...base, order_id: null }), ["not matched to a pay-in"]);
  assert.deepEqual(chainProblems({ ...base, state: "CB_DISMISSED", order_id: null }), []);
});

test("the merchant view of a chargeback names no gateway, no source and no person", () => {
  const row = {
    id: "1", cb_ref: "CB-1", source: "GATEWAY", source_name: "PayU disputes desk", bank_ref: "B1", original_ref: "123456789012",
    stated_order: null, stated_banker: null, stated_channel: null, amount: 1000, currency: "INR", reason_code: "10.4",
    reason_text: "PayU reports fraud", event_date: null, livemode: true, received_at: "2026-10-01T00:00:00.000Z", received_by: "ops@katana",
    order_id: "o", order_ref: "ORD1", order_created_at: null, order_utr: null, merchant_id: "B1", provider_id: "P", channel_type: "INTENT",
    order_amount: 1000, match_method: "REFERENCE", matched_at: null, matched_by: "ops@katana", rule_id: "r", rule_version: 2,
    debit_bps: 5000, calculated_debit: 500, debited: 500, reversed: 0, state: "CB_PARTIAL_DEBIT", state_note: "approved by ops@katana",
    updated_at: "2026-10-01T00:00:00.000Z", override: false,
  } as ChargebackRow;
  const v = merchantChargeback(row, []);
  const text = JSON.stringify(v);
  assert.equal(/payu/i.test(text), false);
  assert.equal(text.includes("ops@katana"), false);
  assert.equal(v.source, "Payment processor");
  assert.equal(v.debit_ratio, "50%");
  assert.match(merchantExplanation(row), /₹500\.00 debited of the ₹1,000\.00 chargeback \(50% under your terms\)/);
});

test("All is the sum of the channels", () => {
  const a = emptyAccount(), b = emptyAccount();
  a.paid = { count: 3, amount: 300 }; a.failed = { count: 1, amount: 50 }; a.gross = 300; a.fees = 6; a.net = 294; a.settled = 100; a.unsettled = 200;
  a.recon.MATCHED = { count: 3, amount: 300, variance: 0 }; a.chargebacks.count = 1;
  b.paid = { count: 1, amount: 100 }; b.gross = 150; b.received_no_order = 50; b.net = 150; b.settled = 0; b.unsettled = 100;
  b.recon.MISSING_INTERNAL = { count: 1, amount: 50, variance: 50 }; b.variance = 50;
  const t = sumAccounts([a, b]);
  assert.deepEqual([t.paid.count, t.paid.amount, t.gross, t.fees, t.net, t.settled, t.unsettled, t.variance], [4, 400, 450, 6, 444, 100, 300, 50]);
  assert.equal(t.success_rate, 80);          // 4 paid of 5 decided
  assert.equal(t.chargebacks.ratio, 25);     // 1 chargeback on 4 paid pay-ins
  assert.equal(t.recon.MISSING_INTERNAL.amount, 50);
});
