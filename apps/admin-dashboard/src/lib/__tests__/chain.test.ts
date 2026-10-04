// The Bank → TSP → Banker chain's rules (lib/chain).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bankInputProblem, blockingItems, chainRefusal, healthBand, healthScore, maskAccount, maskMid, midGate, midInputProblem,
  midIssueRefusal, requiredTspDocs, tspChecklist, tspInputProblem, tspNextStep, type Tsp, type TspFacts,
} from "@/lib/chain";

const tsp = (o: Partial<Tsp> = {}): Tsp => ({
  id: "t1", code: "PAYX", name: "PayX", legal_name: "PayX Pvt Ltd", tsp_type: "PAYMENT_AGGREGATOR", gateway_code: null,
  rbi_licence_no: "RBI/PA/1", pci_dss_cert_no: null, primary_contact_name: "A", primary_contact_email: "a@payx.in",
  primary_contact_phone: null, compliance_officer_name: "C", compliance_officer_email: "c@payx.in",
  allowed_flows: ["INTENT"], max_mids_per_banker: 3, max_bankers: null, stage: "APPLICATION", screening_result: null, ...o,
});
const facts = (o: Partial<TspFacts> = {}): TspFacts => ({ approvedDocs: [], pendingDocs: [], confirmedBanks: 0, liveBankers: 0, ...o });
const complete = facts({ approvedDocs: ["INCORPORATION", "RBI_LICENCE"], confirmedBanks: 1 });

test("an acquiring bank's arm needs no RBI licence of its own", () => {
  assert.deepEqual(requiredTspDocs({ tsp_type: "ACQUIRING_BANK_ARM" }), ["INCORPORATION"]);
  assert.deepEqual(requiredTspDocs({ tsp_type: "PAYMENT_GATEWAY" }), ["INCORPORATION", "RBI_LICENCE"]);
  const items = tspChecklist(tsp({ tsp_type: "ACQUIRING_BANK_ARM", rbi_licence_no: null }), facts());
  assert.equal(items.find((i) => i.key === "rbi_licence_no")!.state, "DONE");
  assert.equal(items.some((i) => i.key === "doc_RBI_LICENCE"), false);
});

test("each step needs only its own and earlier items", () => {
  const items = tspChecklist(tsp(), facts());
  // APPLICATION: the details are complete, so it may move on although nothing else is done.
  assert.deepEqual(tspNextStep(tsp(), items), { ok: true, to: "KYB_PENDING", second_person: false });
  // KYB_PENDING: the required documents must be approved; the optional PCI-DSS does not hold it.
  const r = tspNextStep(tsp({ stage: "KYB_PENDING" }), items);
  assert.equal(r.ok, false);
  if (!r.ok) assert.deepEqual(r.missing.map((m) => m.key).sort(), ["doc_INCORPORATION", "doc_RBI_LICENCE"]);
  assert.equal(tspNextStep(tsp({ stage: "KYB_PENDING" }), tspChecklist(tsp(), facts({ approvedDocs: ["INCORPORATION", "RBI_LICENCE"] }))).ok, true);
});

test("an incomplete application is held at APPLICATION", () => {
  const t = tsp({ compliance_officer_email: null });
  const r = tspNextStep(t, tspChecklist(t, facts()));
  assert.equal(r.ok, false);
  if (!r.ok) { assert.equal(r.code, "CHECKLIST_INCOMPLETE"); assert.deepEqual(r.missing.map((m) => m.key), ["compliance_officer"]); }
});

test("the screening step is not held up by its own screening item", () => {
  const t = tsp({ stage: "SCREENING" });
  assert.equal(tspNextStep(t, tspChecklist(t, complete)).ok, true);
  const b = tsp({ stage: "BANK_VERIFY" });
  assert.equal(tspNextStep(b, tspChecklist(b, complete)).ok, false, "past screening, an unscreened TSP is held");
  const s = tsp({ stage: "BANK_VERIFY", screening_result: "CLEAR" });
  assert.equal(tspNextStep(s, tspChecklist(s, facts({ approvedDocs: ["INCORPORATION", "RBI_LICENCE"] }))).ok, false, "no confirmed bank");
  assert.equal(tspNextStep(s, tspChecklist(s, complete)).ok, true);
});

test("going live needs flows and a quota, and a second person", () => {
  const t = tsp({ stage: "CONFIG", screening_result: "CLEAR", allowed_flows: [] });
  assert.equal(tspNextStep(t, tspChecklist(t, complete)).ok, false);
  const ok = tsp({ stage: "CONFIG", screening_result: "CLEAR" });
  assert.deepEqual(tspNextStep(ok, tspChecklist(ok, complete)), { ok: true, to: "LIVE", second_person: true });
  assert.equal(tspNextStep(tsp({ stage: "LIVE" }), []).ok, false);
  assert.equal(tspNextStep(tsp({ stage: "SUSPENDED" }), []).ok, false);
});

test("the score counts required items only", () => {
  const t = tsp({ stage: "LIVE", screening_result: "CLEAR" });
  const items = tspChecklist(t, complete);
  assert.equal(healthScore(items), 100, "no live banker and no PCI-DSS are optional");
  assert.equal(blockingItems("LIVE", items).length, 0);
  assert.ok(healthScore(tspChecklist(tsp(), facts())) < 70);
  assert.equal(healthBand(95), "GREEN"); assert.equal(healthBand(75), "AMBER"); assert.equal(healthBand(10), "RED");
});

test("TSP and bank forms", () => {
  assert.match(tspInputProblem({ code: "payx", name: "X", tsp_type: "PAYMENT_GATEWAY" }, true)!, /code/);
  assert.equal(tspInputProblem({ code: "PAYX", name: "X", tsp_type: "PAYMENT_GATEWAY" }, true), null);
  assert.match(tspInputProblem({ allowed_flows: ["INTENT", "CARD"] }, false)!, /CARD/);
  assert.match(tspInputProblem({ max_mids_per_banker: 0 }, false)!, /max_mids_per_banker/);
  assert.match(tspInputProblem({ primary_contact_email: "nope" }, false)!, /email/);
  assert.equal(bankInputProblem({ code: "HDFC", name: "HDFC Bank", bank_type: "PRIVATE", settlement_account: "5010 0012 3456" }, true), null);
  assert.match(bankInputProblem({ code: "HDFC", name: "HDFC Bank", bank_type: "PRIVATE", settlement_account: "12ab" }, true)!, /settlement_account/);
  assert.match(bankInputProblem({ status: "CLOSED" }, false)!, /status/);
  assert.equal(maskAccount("50100012345678"), "••••5678");
  assert.equal(maskAccount(null), null);
});

test("a banker joins only a LIVE TSP, with a bank that confirmed it", () => {
  const base = { tsp: { id: "t1", stage: "LIVE" as const, max_bankers: 2 }, bankLink: "CONFIRMED" as const, bankActive: true, otherBankersOnTsp: 0, midsOnOtherTsp: 0 };
  assert.equal(chainRefusal(base), null);
  assert.equal(chainRefusal({ ...base, tsp: null })!.code, "TSP_NOT_FOUND");
  assert.equal(chainRefusal({ ...base, tsp: { ...base.tsp, stage: "CONFIG" } })!.code, "TSP_NOT_LIVE");
  assert.equal(chainRefusal({ ...base, bankLink: "PENDING" })!.code, "BANK_NOT_ON_TSP");
  assert.equal(chainRefusal({ ...base, bankActive: false })!.code, "BANK_INACTIVE");
  assert.equal(chainRefusal({ ...base, otherBankersOnTsp: 2 })!.code, "TSP_BANKER_CAP");
  assert.equal(chainRefusal({ ...base, midsOnOtherTsp: 1 })!.code, "MIDS_ON_OTHER_TSP");
});

test("a MID is recorded within the TSP's flows and quota", () => {
  const f = { banker: { parent_tsp_id: "t1", issuing_bank_id: "b1" }, tsp: { stage: "LIVE" as const, allowed_flows: ["INTENT" as const], max_mids_per_banker: 2 }, bankLink: "CONFIRMED" as const, openMids: 0 };
  assert.equal(midIssueRefusal(f, "INTENT"), null);
  assert.equal(midIssueRefusal(f, "PAYOUT")!.code, "FLOW_NOT_ALLOWED");
  assert.equal(midIssueRefusal({ ...f, openMids: 2 }, "INTENT")!.code, "MID_QUOTA_REACHED");
  assert.equal(midIssueRefusal({ ...f, banker: { parent_tsp_id: null, issuing_bank_id: "b1" }, tsp: null }, "INTENT")!.code, "NO_TSP");
  assert.equal(midIssueRefusal({ ...f, banker: { parent_tsp_id: "t1", issuing_bank_id: null } }, "INTENT")!.code, "NO_BANK");
  assert.equal(midIssueRefusal({ ...f, tsp: { ...f.tsp, stage: "SUSPENDED" } }, "INTENT")!.code, "TSP_NOT_LIVE");
  assert.equal(midIssueRefusal({ ...f, tsp: { ...f.tsp, max_mids_per_banker: null } , openMids: 50 }, "INTENT"), null, "no quota set = no cap");
});

test("MID form", () => {
  const ok = { flow: "INTENT", mid_value: "4823991001", issued_on: "2026-10-01", expires_on: "2027-10-01", daily_limit: 100000, monthly_limit: 2000000 };
  assert.equal(midInputProblem(ok), null);
  assert.match(midInputProblem({ ...ok, flow: "CARD" })!, /flow/);
  assert.match(midInputProblem({ ...ok, mid_value: "ab" })!, /mid_value/);
  assert.match(midInputProblem({ ...ok, mid_value: "48 23" })!, /mid_value/);
  assert.match(midInputProblem({ ...ok, expires_on: "2026-01-01" })!, /before/);
  assert.match(midInputProblem({ ...ok, issued_on: "01-10-2026" })!, /issued_on/);
  assert.match(midInputProblem({ ...ok, daily_limit: 3000000 })!, /daily_limit/);
  assert.match(midInputProblem({ ...ok, monthly_limit: -1 })!, /monthly_limit/);
  assert.equal(maskMid("4823991001"), "••••••1001");
  assert.equal(maskMid("ab12"), "ab12");
});

test("the MID_ISSUANCE gate asks for what the banker's flows need", () => {
  const f = { hasTsp: true, hasBank: true, activeFlows: [] as ("INTENT" | "P2P" | "PAYOUT")[], services: "PAYIN" as const, payinFlow: "INTENT" as const };
  assert.equal(midGate({ ...f, hasTsp: false }).result, "FAIL");
  assert.equal(midGate({ ...f, hasBank: false }).result, "FAIL");
  assert.deepEqual(midGate(f).missing, ["INTENT"]);
  assert.equal(midGate(f).result, "FAIL");
  assert.equal(midGate({ ...f, activeFlows: ["INTENT"] }).result, "PASS");
  assert.equal(midGate({ ...f, payinFlow: "BOTH" }).result, "FAIL", "Both takes Intent too");
  assert.equal(midGate({ ...f, payinFlow: "P2P" }).result, "PASS", "P2P pays to the banker's own UPI ID");
  assert.equal(midGate({ ...f, services: "BOTH", payinFlow: "P2P" }).result, "REVIEW", "payout MID missing is only flagged");
  assert.equal(midGate({ ...f, services: "PAYOUT", payinFlow: "UNSET", activeFlows: ["PAYOUT"] }).result, "PASS");
  assert.equal(midGate({ ...f, services: "UNSET", payinFlow: "UNSET" }).result, "REVIEW");
  assert.equal(midGate({ ...f, services: "UNSET", payinFlow: "UNSET", activeFlows: ["P2P"] }).result, "PASS");
});
