// A banker's integration, tracked: callback URL choice, check states and health scores (lib/integration).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeFlows, afterCheck, bandOf, callbackAlertKey, callbackBand, callbackUrlProblem, chooseCallbackTarget, flowItems,
  overallScore, parseCallbackFlow, payinCallbackFlow, pingPasses, scoreOf, stateFromPings, usableFlowUrl, type FlowFacts,
} from "@/lib/integration";

test("a per-flow URL is used only while PENDING or VERIFIED and set", () => {
  assert.equal(usableFlowUrl({ url: "https://a.example/cb", status: "VERIFIED" }), "https://a.example/cb");
  assert.equal(usableFlowUrl({ url: " https://a.example/cb ", status: "PENDING" }), "https://a.example/cb");
  assert.equal(usableFlowUrl({ url: "https://a.example/cb", status: "FAILED" }), null);
  assert.equal(usableFlowUrl({ url: null, status: "VERIFIED" }), null);
  assert.equal(usableFlowUrl({ url: "ftp://a.example", status: "VERIFIED" }), null);
  assert.equal(usableFlowUrl(null), null);
});

test("callback target: notify_url, then the flow's URL, then what the sender chose before", () => {
  const fallback = "https://default.example/hook";
  assert.equal(chooseCallbackTarget({ notifyUrl: "https://order.example/n", flowUrl: "https://flow.example", fallback }), "https://order.example/n");
  assert.equal(chooseCallbackTarget({ notifyUrl: null, flowUrl: "https://flow.example", fallback }), "https://flow.example");
  assert.equal(chooseCallbackTarget({ notifyUrl: "not a url", flowUrl: null, fallback }), fallback, "an unusable notify_url is ignored, as before");
  assert.equal(chooseCallbackTarget({ notifyUrl: undefined, flowUrl: null, fallback }), fallback);
  assert.equal(chooseCallbackTarget({ flowUrl: null, fallback: null }), null, "no target stays no target");
  // Nothing changes for a banker with no per-flow URL.
  assert.equal(chooseCallbackTarget({ notifyUrl: "HTTPS://Order.example", flowUrl: null, fallback }), "HTTPS://Order.example");
});

test("an order's channel decides its flow; legacy rows have none", () => {
  assert.equal(payinCallbackFlow("INTENT"), "INTENT");
  assert.equal(payinCallbackFlow("P2P"), "P2P");
  assert.equal(payinCallbackFlow("UNCLASSIFIED"), null);
  assert.equal(payinCallbackFlow(null), null);
  assert.equal(parseCallbackFlow("payout"), "PAYOUT");
  assert.equal(parseCallbackFlow("CARD"), null);
});

test("a pass verifies; the third failure in a row fails, with amber then red alerts", () => {
  let s = afterCheck({ status: "PENDING", consecutive_failures: 0 }, false);
  assert.deepEqual(s, { status: "PENDING", consecutive_failures: 1, alert: "AMBER" });
  s = afterCheck(s, false);
  assert.deepEqual(s, { status: "PENDING", consecutive_failures: 2, alert: "AMBER" });
  s = afterCheck(s, false);
  assert.deepEqual(s, { status: "FAILED", consecutive_failures: 3, alert: "RED" });
  assert.deepEqual(afterCheck(s, true), { status: "VERIFIED", consecutive_failures: 0, alert: "NONE" });
  assert.equal(afterCheck({ status: "VERIFIED", consecutive_failures: 0 }, false).status, "VERIFIED", "one failure keeps a verified URL in use");
  assert.equal(callbackAlertKey("BK1", null), "callback:BK1:DEFAULT");
  assert.equal(callbackAlertKey("BK1", "P2P"), "callback:BK1:P2P");
});

test("a 2xx passes; a JSON echo must match the challenge when present", () => {
  assert.deepEqual(pingPasses(200, "OK", "abc"), { ok: true, error: null });
  assert.deepEqual(pingPasses(204, "", "abc"), { ok: true, error: null });
  assert.deepEqual(pingPasses(200, JSON.stringify({ received: true }), "abc"), { ok: true, error: null });
  assert.deepEqual(pingPasses(200, JSON.stringify({ echo: "abc" }), "abc"), { ok: true, error: null });
  assert.equal(pingPasses(200, JSON.stringify({ echo: "nope" }), "abc").ok, false);
  assert.equal(pingPasses(500, "", "abc").error, "HTTP 500");
  // A server that rejects the made-up test order is reachable (2026-10-06: a merchant's 404s).
  for (const s of [400, 404, 409, 422]) {
    const p = pingPasses(s, "order not found", "abc");
    assert.equal(p.ok, true, `HTTP ${s}`);
    assert.match(p.note ?? "", new RegExp(`answered ${s} for the test order`));
  }
  assert.equal(pingPasses(401, "", "abc").ok, false);
  assert.equal(pingPasses(503, "", "abc").ok, false);
  assert.equal(pingPasses(301, "", "abc").ok, false);
  assert.equal(pingPasses(null, "", "abc").ok, false);
});

test("the default URL's state comes from its own pings, newest first", () => {
  const u = "https://a.example/hook";
  assert.deepEqual(stateFromPings([], u), { status: "PENDING", consecutive_failures: 0, checked: false });
  assert.equal(stateFromPings([{ ok: true, url: u }], u).status, "VERIFIED");
  assert.deepEqual(stateFromPings([{ ok: false, url: u }, { ok: true, url: u }], u), { status: "VERIFIED", consecutive_failures: 1, checked: true });
  assert.equal(stateFromPings([{ ok: false, url: u }, { ok: false, url: u }, { ok: false, url: u }, { ok: true, url: u }], u).status, "FAILED");
  assert.equal(stateFromPings([{ ok: false, url: u }], u).status, "PENDING", "never passed");
  assert.equal(stateFromPings([{ ok: true, url: "https://old.example" }], u).checked, false, "pings of an older URL do not count");
});

test("a typed callback URL", () => {
  assert.equal(callbackUrlProblem("https://shop.example/katana/callback"), null);
  assert.equal(callbackUrlProblem("shop.example"), "not a URL");
  assert.equal(callbackUrlProblem("ftp://shop.example"), "the URL must start with https://");
  assert.equal(callbackUrlProblem("https://u:p@shop.example"), "the URL must not carry a user name or password");
});

test("the flows a banker is scored on follow its merchant's choice", () => {
  assert.deepEqual(activeFlows("PAYIN", ["P2P"], false, []), ["P2P"]);
  assert.deepEqual(activeFlows("BOTH", ["P2P", "INTENT"], false, []), ["INTENT", "P2P", "PAYOUT"]);
  assert.deepEqual(activeFlows("PAYOUT", [], true, ["INTENT"]), ["PAYOUT"]);
  assert.deepEqual(activeFlows("UNSET", [], true, ["INTENT", "PAYOUT"]), ["INTENT", "PAYOUT"], "nothing chosen: what it used");
  assert.deepEqual(activeFlows("UNSET", [], true, []), []);
});

test("health score per flow", () => {
  const now = new Date("2026-10-05T12:00:00Z");
  const all: FlowFacts = {
    keyActive: true, callbackUrl: "https://a.example", lastVerifiedAt: "2026-10-05T06:00:00Z",
    successIn30d: true, webhookVersion: "v1", hasSigningSecret: false,
  };
  assert.equal(scoreOf(flowItems(all, now)), 100, "v1 needs no signing secret");
  assert.equal(scoreOf(flowItems({ ...all, webhookVersion: "v2" }, now)), 80);
  assert.equal(scoreOf(flowItems({ ...all, lastVerifiedAt: "2026-10-03T06:00:00Z" }, now)), 75, "a pass older than 24 h");
  assert.equal(scoreOf(flowItems({ ...all, callbackUrl: null }, now)), 50, "no URL: neither set nor verified");
  assert.equal(scoreOf(flowItems({ ...all, keyActive: false, callbackUrl: null, successIn30d: false }, now)), 0);
  assert.equal(bandOf(100), "GREEN");
  assert.equal(bandOf(75), "AMBER");
  assert.equal(bandOf(50), "RED");
  assert.equal(bandOf(null), "GREY");
  assert.equal(overallScore([100, 75]), 75, "the weakest flow");
  assert.equal(overallScore([]), null);
  assert.equal(callbackBand("VERIFIED"), "GREEN");
  assert.equal(callbackBand("VERIFIED", 1), "AMBER");
  assert.equal(callbackBand("FAILED", 3), "RED");
  assert.equal(callbackBand(null), "GREY");
});
