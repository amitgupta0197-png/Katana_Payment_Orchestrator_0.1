// The Starter Kit (lib/starter-kit): chat messages written from what a banker was set up for.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import { buildStarterKit, KIT_FORMATS, LEGACY_ORDER_STRING, MAX_PART_CHARS, payinApiFor, type KitFacts } from "@/lib/starter-kit";
import { namesGateway } from "@/lib/merchant-safe";
import { computeSignature } from "@/lib/gateway-creds";

const base: KitFacts = {
  bankerName: "Greenleaf Stores", merchantCode: "GRNLF01", baseUrl: "https://katanapay.co",
  services: "BOTH", flow: { flow: "P2P", active: null },
  testCreds: { key: "mk_test_7f3a91c2e04b5d88", salt: "9d2e0b7a61f84c1e9d2e0b7a61f84c1e", scheme: "HMAC_SHA256" },
  liveKey: { key: "mk_live_0a1b2c3d4e5f6071", saltHint: "••••a1b2" },
  liveMode: "NOT_REQUESTED",
  liveChecklist: [{ label: "Onboarding approved", done: true }, { label: "Webhook URL set", done: false }],
  webhook: { url: "https://greenleaf.example/katana", version: "v1", v2Pending: false, paidOnly: false, secretHint: null },
  testPayouts: "SANDBOX",
  limits: { min: 10, max: 100000, daily: 500000 },
};
const all = (k: KitFacts, f: (typeof KIT_FORMATS)[number] = "whatsapp") => buildStarterKit(k, f).parts.map((p) => p.text).join("\n\n");

test("the test Key and Salt are in the kit; the live Salt never is", () => {
  const text = all(base);
  assert.ok(text.includes(base.testCreds!.key));
  assert.ok(text.includes(base.testCreds!.salt));
  assert.ok(text.includes(base.liveKey!.key) === false, "live key is only shown once live mode is on");
  const live = all({ ...base, liveMode: "ACTIVATED" });
  assert.ok(live.includes(base.liveKey!.key));
  assert.ok(live.includes("a1b2"));
  assert.doesNotMatch(live, /mk_live_[0-9a-f]+["']?\s*\n?Salt: `?[0-9a-f]{32}/);
});

test("the order endpoint follows the flow", () => {
  assert.equal(payinApiFor({ flow: "P2P", active: null }).create, "/api/v1/p2p/order");
  assert.equal(payinApiFor({ flow: "INTENT", active: null }).create, "/api/v1/intent/order");
  assert.equal(payinApiFor({ flow: "BOTH", active: "INTENT" }).create, "/api/v1/katana-pay/order");
  assert.equal(payinApiFor({ flow: "UNSET", active: null }).create, "/api/v1/katana-pay/order");
  assert.ok(all(base).includes("https://katanapay.co/api/v1/p2p/order"));
  assert.ok(all({ ...base, flow: { flow: "INTENT", active: null } }).includes("/api/v1/intent/order"));
  assert.match(all({ ...base, flow: { flow: "BOTH", active: "INTENT" } }), /uses your default, Intent/);
});

test("pay-in only gets no payout messages; pay-out only gets no pay-in messages", () => {
  const payin = buildStarterKit({ ...base, services: "PAYIN" });
  assert.ok(!payin.parts.some((p) => p.title === "Payouts"));
  assert.doesNotMatch(all({ ...base, services: "PAYIN" }), /payouts\/create/);
  const payout = buildStarterKit({ ...base, services: "PAYOUT" });
  assert.deepEqual(payout.parts.map((p) => p.title), ["Welcome and keys", "Payouts", "Errors and going live"]);
  assert.doesNotMatch(all({ ...base, services: "PAYOUT" }), /p2p\/order|katana-pay\/order|Test your pay-ins/);
  assert.match(all({ ...base, services: "PAYOUT" }), /2\. Send payouts[\s\S]*3\. Errors/);
  assert.match(all(base), /4\. Send payouts[\s\S]*5\. Errors/);
});

test("the webhook check matches the version in force", () => {
  assert.match(all(base), /sort the names A to Z/);
  assert.doesNotMatch(all(base), /X-Katana-Signature/);
  const v2 = all({ ...base, webhook: { ...base.webhook, version: "v2", secretHint: "••••9b02" } });
  assert.match(v2, /X-Katana-Signature/);
  assert.match(v2, /ends 9b02/);
});

test("no message names a gateway, in any format", () => {
  for (const f of KIT_FORMATS) for (const services of ["PAYIN", "PAYOUT", "BOTH", "UNSET"] as const)
    for (const p of buildStarterKit({ ...base, services, flow: { flow: "BOTH", active: "INTENT" } }, f).parts)
      assert.ok(!namesGateway(p.text), `${f}/${services}: ${p.title}`);
});

test("every message fits in one Telegram message", () => {
  for (const f of KIT_FORMATS) for (const p of buildStarterKit(base, f).parts) assert.ok(p.text.length <= MAX_PART_CHARS, `${f}: ${p.title} is ${p.text.length}`);
  assert.ok(MAX_PART_CHARS < 4096);
});

test("formats: WhatsApp *bold*, Telegram **bold**, plain has no markup", () => {
  assert.match(all(base, "whatsapp"), /^\*1\. Katana Starter Kit/);
  assert.match(all(base, "telegram"), /^\*\*1\. Katana Starter Kit/);
  const plain = all(base, "plain");
  assert.match(plain, /^1\. Katana Starter Kit/);
  assert.doesNotMatch(plain, /```|\*\*/);
});

test("the older SHA-512 description matches the signature Katana checks", () => {
  const creds = { key: "K", salt: "S", scheme: "PAYU_SHA512" as const };
  const order = { txnId: "T1", amount: "1.99", productinfo: "P", firstname: "", email: "e@x" };
  const described = LEGACY_ORDER_STRING.replace("key", "K").replace("txnid", "T1").replace("amount", "1.99")
    .replace("productinfo", "P").replace("firstname", "").replace("email", "e@x").replace(/salt$/, "S");
  assert.equal(createHash("sha512").update(described).digest("hex"), computeSignature(creds, order).signature);
});

test("test payouts: the sandbox's amounts, or the gateway's test system", () => {
  assert.match(all(base), /ends in `\.13`: FAILED\n• anything else: PROCESSING/);
  const gw = all({ ...base, testPayouts: "GATEWAY" });
  assert.match(gw, /payment processor's test system/);
  assert.doesNotMatch(gw, /PROCESSING, then SUCCESS within/);
});

test("warnings tell the sender what to fix first", () => {
  assert.deepEqual(buildStarterKit(base).warnings, []);
  const w = buildStarterKit({ ...base, testCreds: null, webhook: { ...base.webhook, url: null, v2Pending: true }, flow: { flow: "UNSET", active: null } }).warnings;
  assert.equal(w.length, 4);
  assert.ok(!all({ ...base, testCreds: null }).includes("undefined"));
});
