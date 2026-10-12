// Banker onboarding wizard rules (lib/banker-wizard).
import { test } from "node:test";
import assert from "node:assert/strict";
import { afterSteps, EMPTY_ANSWERS, stepProblem, wizardCalls, wizardMethod, wizardSteps, type WizardAnswers } from "@/lib/banker-wizard";

const base: WizardAnswers = { ...EMPTY_ANSWERS, providerId: "p-1", name: "Mypay", code: "mypay-01", email: "ops@mypay.in" };

test("steps follow the choices: P2P scan and pay, quasi, Intent, connect later", () => {
  assert.deepEqual(wizardSteps({ ...base, type: null }), ["merchant", "banker", "type", "review"]);
  assert.deepEqual(wizardSteps({ ...base, type: "P2P", kind: "SCAN_PAY" }), ["merchant", "banker", "type", "kind", "app", "upi", "review"]);
  assert.deepEqual(wizardSteps({ ...base, type: "P2P", kind: "QUASI" }), ["merchant", "banker", "type", "kind", "payatom", "review"]);
  assert.deepEqual(wizardSteps({ ...base, type: "INTENT" }), ["merchant", "banker", "type", "gateway", "credentials", "review"]);
  assert.deepEqual(wizardSteps({ ...base, type: "INTENT", connectLater: true }), ["merchant", "banker", "type", "gateway", "review"]);
});

test("each step says what stops it", () => {
  assert.match(stepProblem("merchant", { ...base, providerId: "" })!, /merchant/);
  assert.equal(stepProblem("banker", base), null);
  assert.match(stepProblem("banker", base, { codeTaken: true })!, /taken/);
  assert.match(stepProblem("banker", { ...base, code: "a" })!, /code/);
  assert.match(stepProblem("upi", { ...base, app: "GPAY", upiId: "nope" })!, /UPI ID/);
  assert.equal(stepProblem("upi", { ...base, app: "GPAY", upiId: "shop@okaxis" }), null);
  assert.match(stepProblem("upi", { ...base, app: "BHARATPE", upiId: "bp@unitype", bharatpeMid: "12ab" })!, /digits/);
  const pa = { ...base.payatom, pid: "1", secret: "s3cret-value", apiKey: "k", apiBase: "https://x", latitude: "19.07", longitude: "72.87" };
  assert.equal(stepProblem("payatom", { ...base, payatom: pa }), null);
  assert.match(stepProblem("payatom", { ...base, payatom: { ...pa, apiKey: "s3cret-value" } })!, /different/);
  assert.equal(stepProblem("payatom", { ...base, connectLater: true }), null);
  assert.match(stepProblem("credentials", base, { gatewayFields: [{ name: "key", label: "Merchant Key" }] })!, /Merchant Key/);
});

test("methods: BharatPe app → BHARATPE, other apps → UPI_ID, quasi → PAYATOM, Intent → none", () => {
  assert.equal(wizardMethod({ ...base, type: "P2P", kind: "SCAN_PAY", app: "BHARATPE" }), "BHARATPE");
  assert.equal(wizardMethod({ ...base, type: "P2P", kind: "SCAN_PAY", app: "PHONEPE" }), "UPI_ID");
  assert.equal(wizardMethod({ ...base, type: "P2P", kind: "QUASI" }), "PAYATOM");
  assert.equal(wizardMethod({ ...base, type: "INTENT" }), null);
});

test("calls: create first with the upper-case code, then flow, the method's own setup, then the method", () => {
  const gp = wizardCalls({ ...base, type: "P2P", kind: "SCAN_PAY", app: "GPAY", upiId: "shop@okaxis", payeeName: "Mypay" });
  assert.deepEqual(gp.map((c) => c.key), ["create", "flow", "upi", "method"]);
  assert.equal(gp[0].body.merchant_code, "MYPAY-01");
  assert.deepEqual(gp[3].body, { method: "UPI_ID", app: "GPAY", note: "banker onboarding wizard" });

  const bp = wizardCalls({ ...base, type: "P2P", kind: "SCAN_PAY", app: "BHARATPE", upiId: "bp@unitype", bharatpeEnv: "TEST" });
  assert.deepEqual(bp.map((c) => c.key), ["create", "flow", "bharatpe", "method"]);
  assert.equal(bp[2].body.replace_primary, true);

  const q = wizardCalls({ ...base, type: "P2P", kind: "QUASI", payatom: { ...base.payatom, pid: "1", secret: "s", apiKey: "k", apiBase: "https://x", latitude: "1", longitude: "2" } });
  assert.deepEqual(q.map((c) => c.key), ["create", "flow", "payatom", "method"]);
  // PayAtom is P2P only: the wizard sends no product choice, just the P2P details.
  assert.equal(q[2].body.want, undefined);
  assert.equal((q[2].body.p2p as { pid: string }).pid, "1");

  const i = wizardCalls({ ...base, type: "INTENT", gateway: "PAYU", gatewayFields: { key: " k ", salt: "s", mid_code: "" } });
  assert.deepEqual(i.map((c) => c.key), ["create", "flow", "gateway"]);
  assert.deepEqual(i[2].body.fields, { key: "k", salt: "s" });
  assert.deepEqual(wizardCalls({ ...base, type: "INTENT", gateway: "PAYU", connectLater: true }).map((c) => c.key), ["create", "flow"]);
});

test("what is left afterwards names the agent app and the go-live steps", () => {
  assert.match(afterSteps({ ...base, type: "P2P", kind: "SCAN_PAY", app: "PAYTM" })[0], /Paytm for Business/);
  assert.match(afterSteps({ ...base, type: "P2P", kind: "SCAN_PAY", app: "BHARATPE" })[0], /pairing QR/);
  assert.match(afterSteps({ ...base, type: "INTENT", connectLater: true })[0], /Pays via gateway/);
  assert.match(afterSteps(base).at(-1)!, /live mode/);
});
