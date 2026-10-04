// The health engine's rules (lib/health).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bankerHealth, grade, integrationFlows, integrationHealth, istHour, merchantHealth, newlyDone, tspHealth,
  type BankerFacts, type HealthItem, type IntegrationFacts, type MerchantFacts,
} from "@/lib/health";
import type { Tsp, TspFacts } from "@/lib/chain";

const NOW = Date.parse("2026-10-05T06:00:00Z");
const HOURS = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const item = (key: string, state: HealthItem["state"], critical = false): HealthItem => ({ key, label: key, state, critical });
const find = (items: HealthItem[], key: string) => items.find((i) => i.key === key);

test("score is done over required; optional missing does not lower it", () => {
  assert.deepEqual(grade([item("a", "DONE"), item("b", "OPTIONAL_MISSING")]), { score: 100, raw_score: 100, band: "GREEN" });
  assert.equal(grade([item("a", "DONE"), item("b", "MISSING")]).score, 50);
  assert.equal(grade([]).score, 100);
});

test("bands: GREEN ≥ 90, AMBER ≥ 70, RED below", () => {
  const of = (done: number, missing: number) => grade([...Array(done)].map((_, i) => item(`d${i}`, "DONE")).concat([...Array(missing)].map((_, i) => item(`m${i}`, "MISSING")))).band;
  assert.equal(of(9, 1), "GREEN");
  assert.equal(of(7, 3), "AMBER");
  assert.equal(of(69, 31), "RED");
});

test("a critical item missing is BLOCKED with score 0, raw score kept", () => {
  const g = grade([item("a", "DONE"), item("b", "DONE"), item("c", "DONE"), item("x", "MISSING", true)]);
  assert.deepEqual(g, { score: 0, raw_score: 75, band: "BLOCKED" });
  assert.equal(grade([item("x", "DONE", true)]).band, "GREEN");
});

const tsp = (o: Partial<Tsp> = {}): Tsp => ({
  id: "t1", code: "PAYX", name: "PayX", legal_name: "PayX Pvt Ltd", tsp_type: "PAYMENT_AGGREGATOR", gateway_code: null,
  rbi_licence_no: "RBI/1", pci_dss_cert_no: null, primary_contact_name: "A", primary_contact_email: "a@x.in",
  primary_contact_phone: null, compliance_officer_name: "C", compliance_officer_email: "c@x.in",
  allowed_flows: ["INTENT"], max_mids_per_banker: 3, max_bankers: null, stage: "LIVE", screening_result: "CLEAR", ...o,
});
const tf: TspFacts = { approvedDocs: ["INCORPORATION", "RBI_LICENCE"], pendingDocs: [], confirmedBanks: 1, liveBankers: 0 };

test("TSP: reuses tspChecklist; a suspended TSP is BLOCKED; live only at LIVE", () => {
  const r = tspHealth(tsp(), tf);
  assert.equal(r.band, "GREEN");
  assert.equal(r.live, true);
  assert.ok(find(r.items, "live_banker"));
  assert.equal(tspHealth(tsp({ stage: "SUSPENDED" }), tf).band, "BLOCKED");
  assert.equal(tspHealth(tsp({ stage: "CONFIG" }), tf).live, false);
  assert.equal(tspHealth(tsp({ legal_name: null, primary_contact_email: null, compliance_officer_email: null }), { ...tf, approvedDocs: [] }).band, "RED");
});

const banker = (o: Partial<BankerFacts> = {}): BankerFacts => ({
  id: "b1", code: "BK1", name: "Banker", stage: "LIVE", blocked: false, missingDocs: [], bankVerified: true,
  chain: { hasTsp: true, tspLive: true, hasBank: true, bankConfirmed: true, tspCode: "PAYX" }, activeMidFlows: ["INTENT"],
  services: "PAYIN", flow: { flow: "INTENT", active: null },
  setup: [{ key: "INTENT_GATEWAY", label: "Intent gateway", state: "DONE", hint: "" }],
  gatewayAccounts: [], callback: { urlSet: true, verifiedAt: HOURS(2), source: "delivery" },
  openComplianceFlags: 0, payoutFunded: false, providerId: "p1", ...o,
});

test("banker: everything in place is GREEN", () => {
  const r = bankerHealth(banker(), NOW);
  assert.equal(r.band, "GREEN");
  assert.equal(r.score, 100);
  assert.equal(find(r.items, "payout_funds"), undefined, "a pay-in only banker has no payout item");
  assert.equal(find(r.items, "gateway_golive"), undefined, "no gateway accounts, no go-live item");
});

test("banker: blocked, suspended, or a required setup item missing is BLOCKED", () => {
  assert.equal(bankerHealth(banker({ blocked: true }), NOW).band, "BLOCKED");
  assert.equal(bankerHealth(banker({ stage: "SUSPENDED" }), NOW).band, "BLOCKED");
  const r = bankerHealth(banker({ setup: [{ key: "INTENT_GATEWAY", label: "g", state: "MISSING", hint: "save it" }] }), NOW);
  assert.equal(r.band, "BLOCKED");
  assert.equal(find(r.items, "setup_INTENT_GATEWAY")?.href, "/bankers/b1?tab=intent");
});

test("banker: KYB docs, bank verify, chain, MIDs, go-live, callback and flags each count", () => {
  const miss = (o: Partial<BankerFacts>, key: string) => find(bankerHealth(banker(o), NOW).items, key)?.state;
  assert.equal(miss({ missingDocs: ["PAN"] }, "kyb_documents"), "MISSING");
  assert.equal(miss({ bankVerified: false }, "bank_verify"), "MISSING");
  assert.equal(miss({ chain: { hasTsp: true, tspLive: false, hasBank: true, bankConfirmed: true, tspCode: "X" } }, "chain"), "MISSING");
  assert.equal(miss({ activeMidFlows: [] }, "mids"), "MISSING", "Intent pay-ins with no Intent MID");
  assert.equal(miss({ chain: { hasTsp: false, tspLive: false, hasBank: false, bankConfirmed: false, tspCode: null } }, "mids"), undefined);
  assert.equal(miss({ gatewayAccounts: [{ gateway: "PAYU", account: "gateway_mid", status: "VERIFYING" }] }, "gateway_golive"), "MISSING");
  assert.equal(miss({ gatewayAccounts: [{ gateway: "PAYU", account: "gateway_mid", status: "LIVE" }] }, "gateway_golive"), "DONE");
  assert.equal(miss({ callback: { urlSet: true, verifiedAt: HOURS(25), source: "delivery" } }, "callback"), "MISSING");
  assert.equal(miss({ callback: { urlSet: false, verifiedAt: HOURS(1), source: "ping" } }, "callback"), "MISSING");
  assert.equal(miss({ openComplianceFlags: 2 }, "compliance"), "MISSING");
});

test("banker: payout funds optional unless the merchant sends payouts", () => {
  assert.equal(find(bankerHealth(banker({ services: "UNSET" }), NOW).items, "payout_funds")?.state, "OPTIONAL_MISSING");
  assert.equal(find(bankerHealth(banker({ services: "BOTH" }), NOW).items, "payout_funds")?.state, "MISSING");
  assert.equal(find(bankerHealth(banker({ services: "PAYOUT", payoutFunded: true }), NOW).items, "payout_funds")?.state, "DONE");
});

const merchant = (o: Partial<MerchantFacts> = {}): MerchantFacts => ({
  id: "p1", code: "MER", name: "Merchant", status: "ACTIVE", kycStatus: "APPROVED", services: "PAYIN",
  flow: { flow: "P2P", active: null }, bankers: [{ id: "b1", code: "BK1", stage: "LIVE", band: "GREEN" }], unverifiedDocs: 0, ...o,
});

test("merchant: KYC, choice, bankers, live bankers healthy, KYB issues", () => {
  const r = merchantHealth(merchant());
  assert.equal(r.band, "GREEN");
  assert.equal(r.live, true);
  assert.equal(merchantHealth(merchant({ status: "SUSPENDED" })).band, "BLOCKED");
  assert.equal(find(merchantHealth(merchant({ kycStatus: "PENDING" })).items, "kyc")?.state, "MISSING");
  assert.equal(find(merchantHealth(merchant({ flow: { flow: "UNSET", active: null } })).items, "choice")?.state, "MISSING");
  assert.equal(find(merchantHealth(merchant({ services: "PAYOUT", flow: { flow: "UNSET", active: null } })).items, "choice")?.state, "DONE");
  assert.equal(find(merchantHealth(merchant({ bankers: [{ id: "", code: "B", stage: "LIVE", band: "RED" }] })).items, "bankers_healthy")?.state, "MISSING");
  assert.equal(find(merchantHealth(merchant({ bankers: [{ id: "", code: "B", stage: "LIVE", band: "AMBER" }] })).items, "bankers_healthy")?.state, "DONE");
  const none = merchantHealth(merchant({ bankers: [] }));
  assert.equal(find(none.items, "bankers")?.state, "MISSING");
  assert.equal(find(none.items, "bankers_healthy")?.state, "OPTIONAL_MISSING");
  assert.equal(none.live, false);
  assert.equal(find(merchantHealth(merchant({ unverifiedDocs: 1 })).items, "kyb_issues")?.state, "MISSING");
});

test("integration flows follow the choice, else what is set up", () => {
  const no = { p2p: false, intent: false, payout: false };
  assert.deepEqual(integrationFlows("PAYIN", { flow: "BOTH", active: "P2P" }, no), ["P2P", "INTENT"]);
  assert.deepEqual(integrationFlows("BOTH", { flow: "INTENT", active: null }, no), ["INTENT", "PAYOUT"]);
  assert.deepEqual(integrationFlows("PAYOUT", { flow: "UNSET", active: null }, no), ["PAYOUT"]);
  assert.deepEqual(integrationFlows("UNSET", { flow: "UNSET", active: null }, { p2p: true, intent: false, payout: true }), ["P2P", "PAYOUT"]);
});

const integ = (o: Partial<IntegrationFacts> = {}): IntegrationFacts => ({
  bankerId: "b1", code: "BK1", stage: "LIVE", flow: "INTENT", liveKey: true,
  callback: { urlSet: true, verifiedAt: HOURS(1), source: "ping" }, lastSuccessAt: HOURS(48),
  webhookVersion: "v2", hasSigningSecret: true, ...o,
});

test("integration: Key critical, callback 24 h, success in 30 days, v2 secret", () => {
  const r = integrationHealth(integ(), NOW);
  assert.equal(r.id, "BK1:INTENT");
  assert.equal(r.band, "GREEN");
  assert.equal(integrationHealth(integ({ liveKey: false }), NOW).band, "BLOCKED");
  assert.equal(find(integrationHealth(integ({ lastSuccessAt: HOURS(31 * 24) }), NOW).items, "success_30d")?.state, "MISSING");
  assert.equal(find(integrationHealth(integ({ hasSigningSecret: false }), NOW).items, "signing_secret")?.state, "MISSING");
  assert.equal(find(integrationHealth(integ({ webhookVersion: "v1", hasSigningSecret: false }), NOW).items, "signing_secret")?.state, "DONE");
  assert.match(find(integrationHealth(integ({ flow: "PAYOUT" }), NOW).items, "success_30d")!.label, /payout/);
});

test("completions: only items that were not DONE and now are; nothing on a first computation", () => {
  const before = [item("a", "MISSING"), item("b", "DONE"), item("c", "OPTIONAL_MISSING")];
  const after = [item("a", "DONE"), item("b", "DONE"), item("c", "DONE"), item("d", "DONE")];
  assert.deepEqual(newlyDone(before, after).map((i) => i.key), ["a", "c"]);
  assert.deepEqual(newlyDone(null, after), []);
});

test("IST hour for the daily digest", () => {
  assert.equal(istHour(new Date("2026-10-05T03:30:00Z")), 9);
  assert.equal(istHour(new Date("2026-10-04T20:00:00Z")), 1);
});
