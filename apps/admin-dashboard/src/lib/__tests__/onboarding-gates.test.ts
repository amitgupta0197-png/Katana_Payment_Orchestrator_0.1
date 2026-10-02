// The onboarding application gate (lib/onboarding-gates): pure checks on a banker's identifiers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { blockingGates, gateApplication, requiredDocuments, type GateOutcome, type OnboardingSubject } from "@/lib/onboarding-gates";

const GOOD: OnboardingSubject = {
  id: "00000000-0000-0000-0000-000000000000", legal_name: "Urban Foods LLP", brand_name: null,
  category_mcc: "5411", website: "https://example.com", gstin: "27AAPFU0939F1ZV", business_pan: "AAPFU0939F",
  director_name: "Asha Kumar", director_pan: "ABCPK1234L", director_aadhaar_last4: "1234",
};
const run = (o: Partial<OnboardingSubject>) => gateApplication({ ...GOOD, ...o });

test("a complete, consistent application passes", () => {
  assert.equal(run({}).result, "PASS");
});

test("a malformed identifier fails, and says which", () => {
  const g = run({ gstin: "27AAPFU0939F1ZW" });
  assert.equal(g.result, "FAIL");
  assert.match(g.summary, /^gstin: /);
  assert.equal(run({ director_pan: "ABC" }).result, "FAIL");
  assert.equal(run({ director_aadhaar_last4: "123456789012" }).result, "FAIL");
});

test("a GSTIN issued on a different PAN fails", () => {
  const g = run({ business_pan: "AAACR5055K" });
  assert.equal(g.result, "FAIL");
  assert.match(g.summary, /not issued on this business PAN/);
});

test("a prohibited category fails; one that needs a licence is for review", () => {
  assert.match(run({ category_mcc: "7995" }).summary, /prohibited category: betting and gambling/);
  assert.equal(run({ category_mcc: "7995" }).result, "FAIL");
  assert.equal(run({ category_mcc: "6051" }).result, "REVIEW");
});

test("missing identifiers are for review, not a failure: older bankers have none", () => {
  const g = run({ gstin: null, business_pan: "", director_name: null });
  assert.equal(g.result, "REVIEW");
  assert.deepEqual(g.detail.missing, ["gstin", "business_pan", "director_name"]);
});

test("a failure outranks something missing", () => {
  assert.equal(run({ gstin: null, director_pan: "BAD" }).result, "FAIL");
});

test("a GST certificate is only called for when a GSTIN was given", () => {
  assert.deepEqual(requiredDocuments({ gstin: "27AAPFU0939F1ZV" }), ["PAN", "GST", "BANK_STATEMENT"]);
  assert.deepEqual(requiredDocuments({ gstin: null }), ["PAN", "BANK_STATEMENT"]);
});

test("only a FAIL refuses a step, unless onboarding is strict", () => {
  const g = (gate: GateOutcome["gate"], result: GateOutcome["result"]): GateOutcome => ({ gate, result, summary: "", detail: {} });
  const gates = [g("APPLICATION", "PASS"), g("WEBSITE", "REVIEW"), g("SCREENING", "FAIL")];
  assert.deepEqual(blockingGates(gates, false).map((x) => x.gate), ["SCREENING"]);
  assert.deepEqual(blockingGates(gates, true).map((x) => x.gate), ["WEBSITE", "SCREENING"]);
});

test("the number of test payments asked for is a whole number of at least one", async () => {
  const { minTestPayments, autoActivate } = await import("@/lib/live-activation");
  const saved = { n: process.env.LIVE_MIN_TEST_PAYMENTS, a: process.env.LIVE_AUTO_ACTIVATE };
  try {
    delete process.env.LIVE_MIN_TEST_PAYMENTS; delete process.env.LIVE_AUTO_ACTIVATE;
    assert.deepEqual([minTestPayments(), autoActivate()], [1, false]);     // the defaults change nothing
    process.env.LIVE_MIN_TEST_PAYMENTS = "3"; process.env.LIVE_AUTO_ACTIVATE = "1";
    assert.deepEqual([minTestPayments(), autoActivate()], [3, true]);
    for (const bad of ["0", "-2", "2.5", "many"]) { process.env.LIVE_MIN_TEST_PAYMENTS = bad; assert.equal(minTestPayments(), 1); }
  } finally {
    if (saved.n === undefined) delete process.env.LIVE_MIN_TEST_PAYMENTS; else process.env.LIVE_MIN_TEST_PAYMENTS = saved.n;
    if (saved.a === undefined) delete process.env.LIVE_AUTO_ACTIVATE; else process.env.LIVE_AUTO_ACTIVATE = saved.a;
  }
});
