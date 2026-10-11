// "Take live" (lib/take-live) and the phone-fit checks (lib/banker-check phoneMismatches).
import { test } from "node:test";
import assert from "node:assert/strict";
import { gateWords, nextOnboardingStep, remainingSteps, takeLiveItems } from "@/lib/take-live";
import { phoneMismatches } from "@/lib/banker-check";
import { bharatpeKeyHint, normalisePairCode, pairCodeFrom, showPairCode, agentAppFor } from "@/lib/agent-pair";
import { readPayatomAnswer, readPayuVerify, readStatusAnswer } from "@/lib/credential-test";

test("onboarding steps run in order, CONFIG has two, LIVE has none", () => {
  assert.equal(nextOnboardingStep({ stage: "APPLICATION" })!.key, "step_application");
  assert.equal(nextOnboardingStep({ stage: "CONFIG", step_config: false })!.key, "step_config");
  assert.equal(nextOnboardingStep({ stage: "CONFIG", step_config: true })!.key, "step_approval");
  assert.equal(nextOnboardingStep({ stage: "LIVE" }), null);
  assert.deepEqual(remainingSteps({ stage: "BANK_VERIFY" }).map((s) => s.key), ["step_bank_verify", "step_mid_issuance", "step_config", "step_approval"]);
  assert.deepEqual(remainingSteps({ stage: "CONFIG", step_config: true }).map((s) => s.key), ["step_approval"]);
  assert.deepEqual(remainingSteps({ stage: "REJECTED" }), []);
});

test("take-live items say what is left", () => {
  const items = takeLiveItems({ stage: "SCREENING" }, "NOT_REQUESTED", [{ gateway: "PAYU", account: "gateway_mid", status: "VERIFYING" }], false);
  assert.deepEqual(items.map((i) => i.done), [false, false, false, false]);
  assert.match(items[0].detail, /5 steps left/);
  assert.match(items[2].detail, /PAYU still verifying/);
  assert.deepEqual(takeLiveItems({ stage: "LIVE" }, "ACTIVATED", [], true).map((i) => i.done), [true, true, true, true]);
  assert.match(gateWords({ gate: "MID_ISSUANCE", result: "FAIL", summary: "no TSP" }), /Mid issuance: failed — no TSP/);
});

test("phone fit: wrong app, other BharatPe key, no key; old agents and offline phones don't count", () => {
  const phone = (apps: string[], hint: string | null, reportsKey = true) => ({ deviceId: "d", captureApps: apps, bharatpeKeyHint: hint, reportsKey });
  assert.deepEqual(phoneMismatches({ p2pMethod: "BHARATPE", p2pApp: "BHARATPE", bharatpeKeyHint: "bpk_live_dm_F…xy", onlinePhones: [] }), []);
  assert.equal(phoneMismatches({ p2pMethod: "BHARATPE", p2pApp: "BHARATPE", bharatpeKeyHint: "bpk_live_dm_F…xy", onlinePhones: [phone(["PAYTM"], "bpk_live_dm_F…xy")] })[0].key, "PHONE_APP_MISMATCH");
  assert.equal(phoneMismatches({ p2pMethod: "BHARATPE", p2pApp: "BHARATPE", bharatpeKeyHint: "bpk_live_dm_F…xy", onlinePhones: [phone(["BHARATPE"], "bpk_live_OF4v…ab")] })[0].key, "BHARATPE_KEY_MISMATCH");
  assert.match(phoneMismatches({ p2pMethod: "BHARATPE", p2pApp: "BHARATPE", bharatpeKeyHint: "bpk_live_dm_F…xy", onlinePhones: [phone(["BHARATPE"], null)] })[0].title, /no BharatPe key/);
  assert.deepEqual(phoneMismatches({ p2pMethod: "BHARATPE", p2pApp: "BHARATPE", bharatpeKeyHint: "bpk_live_dm_F…xy", onlinePhones: [phone(["BHARATPE"], null, false)] }), []);
  assert.deepEqual(phoneMismatches({ p2pMethod: "UPI_ID", p2pApp: "GPAY", bharatpeKeyHint: null, onlinePhones: [phone(["GPAY", "PAYTM"], null)] }), []);
  assert.deepEqual(phoneMismatches({ p2pMethod: "UPI_ID", p2pApp: "OTHER", bharatpeKeyHint: null, onlinePhones: [phone([], null)] }), []);
});

test("pairing codes: unambiguous alphabet, forgiving input, the same key hint as the agent", () => {
  const c = pairCodeFrom(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
  assert.equal(c, "ABCDEFGH");
  assert.equal(normalisePairCode("abcd-efgh"), "ABCDEFGH");
  assert.equal(normalisePairCode("ABCD EFG0"), null);       // 0 is not in the alphabet
  assert.equal(showPairCode("ABCDEFGH"), "ABCD-EFGH");
  assert.equal(bharatpeKeyHint("bpk_live_dm_FqWertyuiopasdfxy"), "bpk_live_dm_F…xy");
  assert.equal(agentAppFor("OTHER"), null);
});

test("credential answers are read for the credentials, not the order", () => {
  assert.equal(readStatusAnswer("Cashfree", { ok: false, error: "authentication failed" }).result, "WRONG");
  assert.equal(readStatusAnswer("Cashfree", { ok: false, error: "order not found" }).result, "OK");
  assert.equal(readStatusAnswer("Cashfree", { ok: false, error: "Cashfree unreachable" }).result, "UNKNOWN");
  assert.equal(readPayuVerify("Invalid Hash.").result, "WRONG");
  assert.equal(readPatom(200, { status: "error", message: "Invalid signature" }), "WRONG");
  assert.equal(readPatom(200, { status: "success" }), "OK");
  assert.equal(readPatom(200, { status: "error", message: "No valid channel found" }), "WARN");
});
const readPatom = (h: number, b: { status?: string; message?: string }) => readPayatomAnswer(h, b).result;
