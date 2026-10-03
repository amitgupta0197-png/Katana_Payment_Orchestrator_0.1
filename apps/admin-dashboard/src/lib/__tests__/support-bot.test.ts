// The merchant support bot (lib/support-bot): the parts that decide what it can see and say.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "crypto";
import { diagnoseOrderSignature, parseHashHint, canonicalString, type OrderFields } from "@/lib/support-bot/signature";
import { scrubReply, costEstimate, questionContent } from "@/lib/support-bot/bot";
import { SUPPORT_BOT_TOOLS, TOOL_STEP_LABEL, ist, parseIstTime } from "@/lib/support-bot/tools";
import { SUPPORT_BOT_SYSTEM, scopeContext } from "@/lib/support-bot/knowledge";
import { chooseModel, MODELS } from "@/lib/support-bot/router";
import { readImages, sniffImage, MAX_IMAGES } from "@/lib/support-bot/images";
import { parseScopeKey, portalsEnabled } from "@/lib/support-bot/scope";
import { namesGateway } from "@/lib/merchant-safe";
import { redactBody } from "@/lib/api-log";
import { V2_ERRORS } from "@/lib/v2-api-errors";

const test_ = { key: "mk_test_0123456789abcdef", salt: "0f1e2d3c4b5a69788796a5b4c3d2e1f0", scheme: "HMAC_SHA256" };
const live = { key: "mk_live_fedcba9876543210", salt: "aa11bb22cc33dd44ee55ff6600778899", scheme: "HMAC_SHA256" };
const order: OrderFields = { txnid: "T-100", amount: "499.00", productinfo: "Shoes", email: "a@b.in" };
const hmac = (k: string, s: string) => createHmac("sha256", k).update(s).digest("hex");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The hint the request log would keep for a hash the merchant sent (lib/api-log). */
const hintOf = (hash: string) => parseHashHint((redactBody({ hash }) as { hash: string }).hash)!;
const verdict = (hash: string, f: OrderFields = order) => diagnoseOrderSignature(f, hintOf(hash), test_, live).verdict;

test("the request log's hash hint is read back: first four characters and length", () => {
  assert.deepEqual(parseHashHint("ab12…(64)"), { prefix: "ab12", length: 64 });
  assert.equal(parseHashHint("…"), null);
  assert.equal(parseHashHint(undefined), null);
});

test("each usual signing mistake is told apart from the hint alone", () => {
  const right = hmac(test_.key + test_.salt, "T-100|499.00|Shoes|a@b.in");
  assert.equal(verdict(right), "CORRECT");
  assert.equal(verdict(right.toUpperCase()), "UPPERCASE");
  assert.equal(verdict(hmac(test_.key + test_.salt, "T-100|499|Shoes|a@b.in")), "AMOUNT_FORMAT");
  assert.equal(verdict(hmac(test_.key + test_.salt, "T-100|499.00||")), "MISSING_FIELDS");
  assert.equal(verdict(hmac(test_.salt + test_.key, "T-100|499.00|Shoes|a@b.in")), "SALT_KEY_ORDER");
  assert.equal(verdict(hmac(test_.key + live.salt, "T-100|499.00|Shoes|a@b.in")), "OTHER_MODE_SALT");
  assert.equal(verdict(sha("T-100|499.00|Shoes|a@b.in")), "PLAIN_SHA256");
  assert.equal(verdict(sha("T-100|499.00|Shoes|a@b.in" + test_.salt)), "SHA256_WITH_SALT");
  assert.equal(verdict("deadbeef".repeat(8)), "UNKNOWN");
});

test("the diagnosis says what to sign and never carries the Salt", () => {
  const d = diagnoseOrderSignature(order, hintOf("deadbeef".repeat(8)), test_, live);
  assert.equal(d.should_sign, "T-100|499.00|Shoes|a@b.in");
  assert.ok(!JSON.stringify(d).includes(test_.salt) && !JSON.stringify(d).includes(live.salt));
  assert.equal(canonicalString({ txnid: "T", amount: "1" }, "HMAC_SHA256"), "T|1||");
  assert.match(canonicalString({ txnid: "T", amount: "1" }, "PAYU_SHA512"), /^<key>\|T\|1\|.*\|<salt>$/);
});

test("the answer never names a gateway and never repeats a Salt", () => {
  assert.equal(scrubReply("PayU declined it", []), "payment processor declined it");
  assert.equal(scrubReply(`your salt is ${test_.salt}.`, [test_.salt]), "your salt is [hidden].");
  assert.equal(scrubReply("  fine  ", ["short"]), "fine");
});

test("cost is estimated at the answering model's prices (Opus 5.5 by default)", () => {
  assert.equal(costEstimate({ input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }, MODELS.LIGHT.price), 6);
  assert.equal(costEstimate({ input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }, MODELS.STANDARD.price), 12);
  assert.equal(costEstimate({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }), 4);
  assert.equal(costEstimate({ input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }), 20);
  assert.equal(costEstimate({ input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000 }), 5.2);
});

test("no tool lets the model choose the account, and every schema is strict", () => {
  for (const t of SUPPORT_BOT_TOOLS) {
    const props = Object.keys((t.input_schema as { properties: Record<string, unknown> }).properties);
    assert.ok(!props.some((p) => /merchant|banker|account|code/i.test(p)), `${t.name} takes ${props.join(", ")}`);
    assert.equal(t.strict, true, t.name);
    assert.equal((t.input_schema as { additionalProperties?: boolean }).additionalProperties, false, t.name);
    assert.deepEqual([...((t.input_schema as { required?: string[] }).required ?? [])].sort(), [...props].sort(), `${t.name}: strict needs every property required`);
  }
});

test("the instructions name no gateway, list every error code, and hold nothing that varies", () => {
  assert.ok(!namesGateway(SUPPORT_BOT_SYSTEM));
  for (const code of Object.keys(V2_ERRORS)) assert.ok(SUPPORT_BOT_SYSTEM.includes(code), code);
  assert.doesNotMatch(SUPPORT_BOT_SYSTEM, /\b20\d\d-\d\d-\d\d\b/, "no date in the cached prefix");
  const one = scopeContext({ name: "Greenleaf", accounts: [{ code: "GRN1", name: "Greenleaf" }], staffTest: false });
  assert.match(one, /GRN1/);
  assert.doesNotMatch(one, /staff/i, "a merchant is not told it is a staff test");
  const many = scopeContext({ name: "Acme", accounts: [{ code: "A1", name: "Shop A" }, { code: "B2", name: "Shop B" }], staffTest: true });
  assert.match(many, /2 accounts: Shop A \(A1\), Shop B \(B2\)/);
  assert.match(many, /staff/);
  assert.match(SUPPORT_BOT_SYSTEM, /under 60 words/, "answers are kept short");
  assert.match(SUPPORT_BOT_SYSTEM, /screenshot is not proof/i);
});

test("times reach the bot in India time", () => {
  assert.equal(ist("2026-10-03T01:00:33Z"), "03 Oct 2026, 06:30:33 IST");
  assert.equal(ist(null), null);
  assert.equal(ist("not a date"), null);
});

test("every tool has a plain-words step for the person waiting", () => {
  for (const t of SUPPORT_BOT_TOOLS) assert.ok(TOOL_STEP_LABEL[t.name], t.name);
});

test("a payment time read off a screenshot is India time", () => {
  assert.equal(parseIstTime("2026-10-03 14:25")?.toISOString(), "2026-10-03T08:55:00.000Z");
  assert.equal(parseIstTime("2026-10-03T09:05:30")?.toISOString(), "2026-10-03T03:35:30.000Z");
  assert.equal(parseIstTime("2026-10-03T08:55:00Z")?.toISOString(), "2026-10-03T08:55:00.000Z");
  assert.equal(parseIstTime("yesterday"), null);
  assert.equal(parseIstTime(null), null);
});

test("the cheapest model that fits answers: general, own case, screenshot", () => {
  const pick = (question: string, images = 0) => chooseModel({ question, images, env: {} }).tier;
  assert.equal(pick("How do I go live?"), "LIGHT");
  assert.equal(pick("What is test mode?"), "LIGHT");
  assert.equal(pick("How do I sign the order request?"), "LIGHT");
  assert.equal(pick("My last payout failed. Why?"), "STANDARD");
  assert.equal(pick("I didn't get a webhook for my last order"), "STANDARD");
  assert.equal(pick("Order T-1042 shows expired"), "STANDARD");
  assert.equal(pick("customer paid, UTR 412345678901"), "STANDARD");
  assert.equal(pick("what does FLOW_NOT_ENABLED mean"), "STANDARD");
  assert.equal(pick("", 1), "HEAVY");
  assert.equal(pick("x".repeat(2000)), "HEAVY");
  assert.equal(chooseModel({ question: "How do I go live?", images: 0, env: { SUPPORT_BOT_ROUTING: "off" } }).tier, "HEAVY");
  assert.equal(MODELS.LIGHT.effort, null, "Haiku 4.5 takes no effort setting");
  assert.equal(MODELS.LIGHT.fallbacks, false);
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);

test("a screenshot is taken by its bytes, not by what the browser called it", () => {
  assert.equal(sniffImage(PNG), "image/png");
  assert.equal(sniffImage(JPG), "image/jpeg");
  assert.equal(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), null);
  const ok = readImages([`data:image/png;base64,${JPG.toString("base64")}`]);
  assert.ok("images" in ok && ok.images[0].media_type === "image/jpeg", "the bytes win over the claimed type");
  assert.ok("error" in readImages([Buffer.from("%PDF-1.7 hello world").toString("base64")]));
  assert.ok("error" in readImages(Array(MAX_IMAGES + 1).fill(PNG.toString("base64"))));
  assert.ok("error" in readImages(["not base64!"]));
  assert.deepEqual(readImages(undefined), { images: [] });
});

test("the question puts screenshots before the words", () => {
  assert.equal(questionContent("hi"), "hi");
  const c = questionContent("", [{ media_type: "image/png", data: "AAAA" }]) as { type: string }[];
  assert.deepEqual(c.map((b) => b.type), ["image", "text"]);
});

test("a scope is one banker or one merchant, and nothing else", () => {
  assert.equal(parseScopeKey("banker:BOTDEMO1"), "banker:BOTDEMO1");
  assert.equal(parseScopeKey("merchant:6F9619FF-8B86-D011-B42D-00C04FC964FF"), "merchant:6f9619ff-8b86-d011-b42d-00c04fc964ff");
  assert.equal(parseScopeKey("banker:x' OR 1=1"), null);
  assert.equal(parseScopeKey("merchant:abc"), null);
  assert.equal(parseScopeKey("staff:all"), null);
  assert.equal(portalsEnabled({}), false, "merchants do not get it until it is switched on");
  assert.equal(portalsEnabled({ SUPPORT_BOT_PORTALS: "1" }), true);
});
