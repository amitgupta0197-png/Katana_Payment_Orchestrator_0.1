// A banker's integration tracking against a real database (merchant 0019): per-flow callback URLs
// through Maker-Checker, checks and their states, the sender's URL choice. Run with
// `pnpm test:integration`. Local database only. Pings and the integration log are append-only,
// so the rows written there stay.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rows } from "@/lib/pg";
import { sealText } from "@/lib/sealed-text";
import { MC_ACTIONS } from "@/lib/maker-checker-actions";
import { getIntegration, requestCallbackChange, chainForBanker } from "@/lib/integration-store";
import { verifyCallback, type Sender } from "@/lib/callback-verify";
import { flowCallbackUrl } from "@/lib/integration-callback-url";
import { ChainError } from "@/lib/chain-store";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };
const N = String(Date.now()).slice(-8);
const CODE = `ITI${N}`;
const maker = { id: "00000000-0000-4000-8000-000000000001", email: "itest-maker@example.com" };
const checker = { id: "00000000-0000-4000-8000-000000000002", email: "itest-checker@example.com" };
let bankerId = "";

async function approve(requestId: string) {
  const r = (await rows<any>("provider", `SELECT request_id::text, resource_type, resource_id, action, payload FROM maker_checker_requests WHERE request_id = $1::uuid`, [requestId]))[0];
  await rows("provider", `UPDATE maker_checker_requests SET status = 'APPROVED', checker_email = $2 WHERE request_id = $1::uuid AND status = 'PENDING'`, [requestId, checker.email]);
  return MC_ACTIONS[r.action].apply(r, checker);
}
const code = async (p: Promise<unknown>) => { try { await p; return "OK"; } catch (e) { return e instanceof ChainError ? e.code : String(e); } };
const answering = (status: number, body = ""): Sender => async () => ({ status, body });

before(async () => {
  if (!LOCAL) return;
  bankerId = (await rows<{ id: string }>("merchant", `
    INSERT INTO merchants (merchant_code, legal_name, contact_email, stage, webhook_url, webhook_version, webhook_secret)
    VALUES ($1, 'Itest Integration Banker', 'itest-integ@example.com', 'APPLICATION', 'https://example.com/default-hook', 'v2', $2)
    RETURNING id::text`, [CODE, sealText("whsec_itest_secret_0123456789")]))[0].id;
});

after(async () => {
  if (LOCAL && bankerId) {
    await rows("provider", `DELETE FROM maker_checker_requests WHERE resource_type = 'banker_callback' AND payload->>'merchant_id' = $1`, [bankerId]).catch(() => {});
    await rows("merchant", `DELETE FROM banker_callback_urls WHERE merchant_id = $1::uuid`, [bankerId]);
    await rows("merchant", `DELETE FROM merchants WHERE id = $1::uuid`, [bankerId]);
    await rows("audit", `DELETE FROM ops_alerts WHERE alert_key LIKE $1`, [`callback:${CODE}:%`]).catch(() => {});
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
});

test("a per-flow URL is set through Maker-Checker and then used for that flow only", opts, async () => {
  assert.equal(await flowCallbackUrl(CODE, "INTENT"), null, "nothing set: senders keep their old target");
  assert.equal(await code(requestCallbackChange(bankerId, "INTENT", "http://127.0.0.1/cb", maker)), "URL_NOT_PUBLIC");
  assert.equal(await code(requestCallbackChange(bankerId, "INTENT", null, maker)), "NOTHING_TO_CLEAR");

  const { request_id } = await requestCallbackChange(bankerId, "INTENT", "https://example.com/intent-cb", maker);
  assert.equal(await code(requestCallbackChange(bankerId, "INTENT", "https://example.com/other", maker)), "REQUEST_PENDING");
  assert.equal(await flowCallbackUrl(CODE, "INTENT"), null, "not in use before approval");
  await approve(request_id);   // writes PENDING and checks it once (a real request to example.com)

  assert.equal(await flowCallbackUrl(CODE, "INTENT"), "https://example.com/intent-cb");
  assert.equal(await flowCallbackUrl(CODE, "P2P"), null);
  const ev = await rows<{ event: string }>("merchant", `SELECT event FROM integration_events WHERE merchant_id = $1::uuid`, [bankerId]);
  assert.ok(ev.some((e) => e.event === "callback_url_set"));
});

test("three failed checks make the URL FAILED and senders fall back; a pass restores it", opts, async () => {
  // A stale real check may have counted already: start from a pass.
  await verifyCallback({ merchantId: bankerId, flow: "INTENT", triggeredBy: "MANUAL", actor: "itest" }, answering(200, "ok"));
  for (let i = 1; i <= 3; i++) {
    const r = await verifyCallback({ merchantId: bankerId, flow: "INTENT", triggeredBy: "SCHEDULED" }, answering(503));
    assert.equal(r.ok, false);
    assert.equal(r.consecutive_failures, i);
    assert.equal(r.status, i < 3 ? "VERIFIED" : "FAILED");
  }
  assert.equal(await flowCallbackUrl(CODE, "INTENT"), null, "a FAILED URL is not used");
  const ok = await verifyCallback({ merchantId: bankerId, flow: "INTENT", triggeredBy: "MANUAL" }, answering(200, JSON.stringify({ echo: "wrong" })));
  assert.equal(ok.ok, false, "a JSON echo must match");
  let seen: Record<string, string> = {};
  const echo: Sender = async (_u, init) => { seen = init.headers; return { status: 200, body: JSON.stringify({ echo: init.headers["X-Katana-Challenge"] }) }; };
  const pass = await verifyCallback({ merchantId: bankerId, flow: "INTENT", triggeredBy: "MANUAL" }, echo);
  assert.equal(pass.status, "VERIFIED");
  assert.ok(seen["X-Katana-Signature"]?.startsWith("t="), "a v2 banker's check is signed like its events");
  assert.equal(seen["X-Katana-Check"], "1", "every check says it is one");
  assert.equal(await flowCallbackUrl(CODE, "INTENT"), "https://example.com/intent-cb");
  // A server that answers 404 to the made-up test order is reachable, with a note, not a failure.
  const reach = await verifyCallback({ merchantId: bankerId, flow: "INTENT", triggeredBy: "MANUAL" }, answering(404, "order not found"));
  assert.deepEqual([reach.ok, reach.status, reach.consecutive_failures], [true, "VERIFIED", 0]);
  assert.match(reach.note ?? "", /answered 404 for the test order/);
  const ev = await rows<{ event: string }>("merchant", `SELECT event FROM integration_events WHERE merchant_id = $1::uuid ORDER BY id DESC LIMIT 1`, [bankerId]);
  assert.equal(ev[0]?.event, "callback_reachable");
});

test("the default URL, the summary, the chain and clearing", opts, async () => {
  const d = await verifyCallback({ merchantId: bankerId, flow: null, triggeredBy: "MANUAL" }, answering(204));
  assert.equal(d.ok, true);
  assert.equal(d.url, "https://example.com/default-hook");

  const s = await getIntegration(bankerId);
  assert.equal(s.default_callback.status, "VERIFIED");
  assert.equal(s.callbacks.find((c) => c.flow === "INTENT")?.source, "FLOW");
  assert.equal(s.callbacks.find((c) => c.flow === "P2P")?.source, "DEFAULT");
  assert.ok(!JSON.stringify(s).includes("whsec_itest_secret"), "no secret in the summary");
  assert.equal(s.webhook.has_secret, true);
  assert.ok(s.callbacks.find((c) => c.flow === "INTENT")!.pings.length >= 5);

  const c = await chainForBanker(bankerId);
  assert.deepEqual(c.bankers[0].nodes.map((n) => n.kind), ["BANK", "TSP", "BANKER", "KATANA", "MERCHANT"]);
  assert.equal(c.bankers[0].nodes[0].band, "GREY", "no issuing bank");

  const { request_id } = await requestCallbackChange(bankerId, "INTENT", null, maker);
  await approve(request_id);
  assert.equal(await flowCallbackUrl(CODE, "INTENT"), null);
  assert.equal(await code(rows("merchant", `DELETE FROM callback_pings WHERE merchant_id = $1::uuid`, [bankerId])), "error: callback_pings is append-only");
});
