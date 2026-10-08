// BharatPe setup (lib/bharatpe-setup): config validation and the agent↔Katana signing scheme.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateBharatPeConfig, normaliseVpa, envOfApiKey, API_KEY_PREFIX,
  bharatpeSign, verifyBharatPeSignature, timestampFresh,
} from "@/lib/bharatpe-setup";

test("validateBharatPeConfig: lowercases the VPA and defaults env to TEST", () => {
  const r = validateBharatPeConfig({ payee_vpa: "  Store@BANK  " });
  assert.ok(r.values);
  assert.equal(r.values!.payee_vpa, "store@bank");
  assert.equal(r.values!.env, "TEST");
});

test("validateBharatPeConfig: a missing or malformed UPI ID is refused", () => {
  assert.ok(validateBharatPeConfig({ payee_vpa: "" }).error);
  assert.ok(validateBharatPeConfig({ payee_vpa: "not-a-vpa" }).error);
});

test("validateBharatPeConfig: a non-numeric BharatPe merchant id is refused", () => {
  assert.ok(validateBharatPeConfig({ payee_vpa: "st@bank", bharatpe_merchant_id: "ABC123" }).error);
  assert.ok(validateBharatPeConfig({ payee_vpa: "st@bank", bharatpe_merchant_id: "711433303641288" }).values);
});

test("normaliseVpa trims and lowercases", () => {
  assert.equal(normaliseVpa("  A@B  "), "a@b");
  assert.equal(normaliseVpa(123 as unknown), "");
});

test("envOfApiKey reads the prefix", () => {
  assert.equal(envOfApiKey(API_KEY_PREFIX.PROD + "x"), "PROD");
  assert.equal(envOfApiKey(API_KEY_PREFIX.TEST + "x"), "TEST");
  assert.equal(envOfApiKey("sk_live_x"), null);
});

test("signature round-trips and rejects tampering", () => {
  const key = "bpk_live_abc", ts = String(Date.now()), body = JSON.stringify({ amount: 500, utr: "123456789012" });
  const secret = "s3cr3t";
  const sig = bharatpeSign(key, ts, body, secret);
  assert.ok(verifyBharatPeSignature(key, ts, body, secret, sig));
  assert.ok(!verifyBharatPeSignature(key, ts, body + " ", secret, sig)); // body changed
  assert.ok(!verifyBharatPeSignature(key, ts, body, "other", sig));       // wrong secret
  assert.ok(!verifyBharatPeSignature("bpk_live_xyz", ts, body, secret, sig)); // wrong key binding
});

test("timestampFresh enforces the ±5 min window", () => {
  const now = 1_000_000_000_000;
  assert.ok(timestampFresh(String(now), now));
  assert.ok(timestampFresh(String(now - 4 * 60 * 1000), now));
  assert.ok(!timestampFresh(String(now - 6 * 60 * 1000), now));
  assert.ok(!timestampFresh("not-a-number", now));
});
