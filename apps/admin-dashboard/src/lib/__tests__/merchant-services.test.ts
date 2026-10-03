// What a merchant is onboarded for (lib/merchant-services): the choice made at creation and the
// setup a banker needs before go-live.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allowsPayin, allowsPayout, liveChecklistNeeds, suggestChoice, parseServices, setupItems, setupVerdict, validateOnboardingChoice, type SetupFacts,
} from "@/lib/merchant-services";

const none: SetupFacts = { upiId: false, payinGateway: false, payoutGateway: false };
const all: SetupFacts = { upiId: true, payinGateway: true, payoutGateway: true };
const states = (items: ReturnType<typeof setupItems>) => Object.fromEntries(items.map((i) => [i.key, i.state]));

test("a pay-in merchant sends no payouts, a pay-out merchant takes no pay-ins, an unset one does both", () => {
  assert.deepEqual([allowsPayin("PAYIN"), allowsPayout("PAYIN")], [true, false]);
  assert.deepEqual([allowsPayin("PAYOUT"), allowsPayout("PAYOUT")], [false, true]);
  assert.deepEqual([allowsPayin("BOTH"), allowsPayout("BOTH")], [true, true]);
  assert.deepEqual([allowsPayin("UNSET"), allowsPayout("UNSET")], [true, true]);
  assert.equal(parseServices("payin"), "PAYIN");
  assert.equal(parseServices("nonsense"), "UNSET");
  assert.equal(parseServices(null), "UNSET");
});

test("creating a merchant: pay-in needs a flow, Both flows need the one in use, pay-out only has none", () => {
  assert.equal(validateOnboardingChoice("PAYIN", "P2P", null), null);
  assert.equal(validateOnboardingChoice("BOTH", "INTENT", null), null);
  assert.equal(validateOnboardingChoice("PAYIN", "BOTH", "INTENT"), null);
  assert.equal(validateOnboardingChoice("PAYOUT", null, null), null);
  assert.match(validateOnboardingChoice("PAYIN", null, null)!, /select the pay-in flow/);
  assert.match(validateOnboardingChoice("BOTH", undefined, null)!, /select the pay-in flow/);
  assert.match(validateOnboardingChoice("PAYIN", "BOTH", null)!, /select the default flow/);
  assert.match(validateOnboardingChoice("PAYIN", "P2P", "P2P")!, /only selected for Both/);
  assert.match(validateOnboardingChoice("PAYOUT", "P2P", null)!, /no pay-in flow/);
});

test("a P2P banker needs its UPI ID, an Intent banker its gateway; neither is asked for the other's", () => {
  const p2p = setupItems("PAYIN", { flow: "P2P", active: null }, none);
  assert.deepEqual(states(p2p), { P2P_UPI_ID: "MISSING" });
  assert.equal(setupVerdict(p2p).result, "FAIL");
  assert.equal(setupVerdict(setupItems("PAYIN", { flow: "P2P", active: null }, { ...none, upiId: true })).result, "PASS");

  const intent = setupItems("PAYIN", { flow: "INTENT", active: null }, { ...none, upiId: true });
  assert.deepEqual(states(intent), { INTENT_GATEWAY: "MISSING" });
  assert.equal(setupVerdict(setupItems("PAYIN", { flow: "INTENT", active: null }, { ...none, payinGateway: true })).result, "PASS");
});

test("with both flows the one in use must be ready; the other only should be", () => {
  const items = setupItems("PAYIN", { flow: "BOTH", active: "INTENT" }, none);
  assert.deepEqual(states(items), { P2P_UPI_ID: "OPTIONAL_MISSING", INTENT_GATEWAY: "MISSING" });
  const ready = setupItems("PAYIN", { flow: "BOTH", active: "INTENT" }, { ...none, payinGateway: true });
  assert.equal(setupVerdict(ready).result, "REVIEW");
  assert.equal(setupVerdict(setupItems("PAYIN", { flow: "BOTH", active: "INTENT" }, all)).result, "PASS");
});

test("a pay-out merchant is asked for no pay-in setup, and a payout gateway is optional", () => {
  const items = setupItems("PAYOUT", { flow: "UNSET", active: null }, none);
  assert.deepEqual(states(items), { PAYOUT_GATEWAY: "OPTIONAL_MISSING" });
  assert.equal(setupVerdict(items).result, "REVIEW");
  assert.equal(setupVerdict(setupItems("PAYOUT", { flow: "UNSET", active: null }, { ...none, payoutGateway: true })).result, "PASS");
  // A flow left on the merchant from before does not matter once it takes no pay-ins.
  assert.deepEqual(states(setupItems("PAYOUT", { flow: "P2P", active: null }, none)), { PAYOUT_GATEWAY: "OPTIONAL_MISSING" });
});

test("both services ask for the pay-in setup and the payout one", () => {
  const items = setupItems("BOTH", { flow: "P2P", active: null }, { ...none, upiId: true });
  assert.deepEqual(states(items), { P2P_UPI_ID: "DONE", PAYOUT_GATEWAY: "OPTIONAL_MISSING" });
});

test("a merchant that takes pay-ins with no flow fails; one nobody chose for is only flagged", () => {
  assert.equal(setupVerdict(setupItems("PAYIN", { flow: "UNSET", active: null }, all)).result, "FAIL");
  const unset = setupItems("UNSET", { flow: "UNSET", active: null }, none);
  assert.deepEqual(states(unset), { CHOICE: "OPTIONAL_MISSING" });
  assert.equal(setupVerdict(unset).result, "REVIEW");
  // A flow selected before services existed is still checked.
  assert.deepEqual(states(setupItems("UNSET", { flow: "P2P", active: null }, none)), { P2P_UPI_ID: "MISSING" });
});

test("the live checklist asks for what the merchant was onboarded for; an unset one keeps the old checklist", () => {
  const old = { settlementVpa: true, payinGateway: false, testPayment: true, testPayout: false };
  assert.deepEqual(liveChecklistNeeds("UNSET", { flow: "UNSET", active: null }), old);
  assert.deepEqual(liveChecklistNeeds("PAYIN", { flow: "P2P", active: null }), old);
  assert.deepEqual(liveChecklistNeeds("BOTH", { flow: "BOTH", active: "P2P" }), old);
  const intent = { settlementVpa: false, payinGateway: true, testPayment: true, testPayout: false };
  assert.deepEqual(liveChecklistNeeds("PAYIN", { flow: "INTENT", active: null }), intent);
  assert.deepEqual(liveChecklistNeeds("BOTH", { flow: "BOTH", active: "INTENT" }), intent);
  // Pay-out only: no UPI ID, no gateway, no test payment it could never make; a test payout instead.
  assert.deepEqual(liveChecklistNeeds("PAYOUT", { flow: "UNSET", active: null }),
    { settlementVpa: false, payinGateway: false, testPayment: false, testPayout: true });
});

test("a merchant from before is suggested what its bankers actually did", () => {
  const e = { bankers: 3, p2pOrders: 0, intentOrders: 0, payouts: 0, bankersWithUpi: 0, bankersWithGateway: 0, bankersWithPayoutGateway: 0, days: 90 };
  assert.deepEqual(suggestChoice(e), { services: null, flow: null, active: null, reasons: [] });   // nothing to go on
  assert.deepEqual(suggestChoice({ ...e, p2pOrders: 1240 }), { services: "PAYIN", flow: "P2P", active: null, reasons: ["1,240 P2P pay-ins in the last 90 days"] });
  const both = suggestChoice({ ...e, p2pOrders: 12, intentOrders: 40, payouts: 3 });
  assert.deepEqual([both.services, both.flow, both.active], ["BOTH", "BOTH", "INTENT"]);
  assert.equal(suggestChoice({ ...e, p2pOrders: 5, intentOrders: 5 }).active, "P2P");                 // a tie
  assert.deepEqual([suggestChoice({ ...e, bankersWithGateway: 1 }).flow, suggestChoice({ ...e, bankersWithGateway: 1 }).reasons], ["INTENT", ["1 banker with a pay-in gateway"]]);
  const out = suggestChoice({ ...e, bankersWithPayoutGateway: 2 });
  assert.deepEqual([out.services, out.flow], ["PAYOUT", null]);
});

test("a merchant code is built from the name, and the next free one is offered when it is taken", async () => {
  const { codeFromName, nextFreeCode, MERCHANT_CODE } = await import("@/lib/merchant-code");
  assert.equal(codeFromName("Acme Retail Pvt Ltd"), "ACME-RETAIL");
  assert.equal(codeFromName("The Sharma & Sons Co."), "SHARMA-SONS");
  assert.equal(codeFromName("  Pvt Ltd "), "");
  assert.equal(codeFromName("X"), "");
  assert.ok(MERCHANT_CODE.test(codeFromName("Northstar Partners Private Limited")));
  assert.equal(nextFreeCode("ACME-RETAIL", []), "ACME-RETAIL");
  assert.equal(nextFreeCode("ACME-RETAIL", ["acme-retail"]), "ACME-RETAIL-2");
  assert.equal(nextFreeCode("ACME-RETAIL", ["ACME-RETAIL", "ACME-RETAIL-2", "ACME-RETAIL-3"]), "ACME-RETAIL-4");
});
