// PayU's 429 on _payment: a real rate limit, or a wrong Key + Salt (BBUY88, 2026-10-06).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPayuUpiIntent } from "@/lib/payu-intent";
import type { GatewayMid } from "@/lib/gateway-creds";

const MID = { gateway: "PAYU", mid_code: "13686388", key: "CGcAbc", salt: "s".repeat(32), scheme: "PAYU_SHA512", env: "PROD" } as GatewayMid;
const ORDER = { txnid: "BBUY88-1", amount: "200.00", productinfo: "Test", firstname: "J", email: "j@x.in", phone: "9999999999", surl: "https://k/r", furl: "https://k/r" };
const CLIENT = { ip: "1.2.3.4", deviceInfo: "Mozilla/5.0" };
const RATE = "Sorry, we are unable to process your payment due to Too many Requests. Please try after 60 seconds.";

function stub(verify: Record<string, unknown> | null) {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    if (String(url).includes("_payment")) return new Response(RATE, { status: 429 });
    return new Response(JSON.stringify(verify), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test("429 and verify_payment says Invalid Hash: the credentials are wrong, with a code", async () => {
  const s = stub({ status: 0, msg: "Invalid Hash." });
  try {
    const r = await createPayuUpiIntent(MID, ORDER, CLIENT);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, "GATEWAY_CREDENTIALS");
    assert.match(r.error, /credentials/);
    assert.doesNotMatch(r.error, /rate-limiting/);
    assert.equal(s.calls.length, 2);
    assert.match(s.calls[1], /postservice/);
  } finally { s.restore(); }
});

test("429 and the pair is accepted: still reported as a rate limit", async () => {
  const s = stub({ status: 1, transaction_details: { "BBUY88-1": { status: "Not Found" } } });
  try {
    const r = await createPayuUpiIntent(MID, ORDER, CLIENT);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, undefined);
    assert.match(r.error, /rate-limiting this request \(HTTP 429\)/);
  } finally { s.restore(); }
});
