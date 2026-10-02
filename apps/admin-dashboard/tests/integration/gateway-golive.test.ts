// The gateway go-live checklist and the webhook record against a real database: what an account
// being verified may take, what makes it LIVE, and that an account with no checklist is not
// touched. Run with `pnpm test:integration`.
//
// IT WRITES ROWS, so it only runs against a local database and removes everything it created.
// No gateway is called: the status-check step is recorded directly, as the route would after the
// gateway answered.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rows } from "@/lib/pg";
import {
  assertGoLiveAllows, AccountNotLiveError, getGoLive, goLiveBlocker, recordWebhookPayment, setLive, startVerifying,
  VERIFY_MAX_AMOUNT,
} from "@/lib/gateway-golive";
import { recordGatewayWebhook } from "@/lib/gateway-webhook-log";
import { gatewayHealth } from "@/lib/gateway-performance";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const BANKER = "ITEST-GOLIVE-BANKER";
const GW = "ITESTGW";
const BY = "integration-test-golive@local";
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };

async function cleanup() {
  await rows("vendorGateway", "DELETE FROM gateway_golive WHERE merchant_id = $1", [BANKER]);
  await rows("vendorGateway", "DELETE FROM gateway_webhook_events WHERE gateway = $1", [GW]);
}
before(async () => { if (LOCAL) await cleanup(); });
after(async () => { if (LOCAL) await cleanup(); setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref(); });

test("an account with no checklist is not restricted", opts, async () => {
  await assertGoLiveAllows(BANKER, GW, 99_999);
  assert.equal(await goLiveBlocker(BANKER, GW, 99_999), null);
});

test("a new live account is VERIFYING and takes only small payments", opts, async () => {
  const row = await startVerifying(BANKER, GW, BY, false);
  assert.deepEqual([row?.status, row?.created_by, row?.live_at], ["VERIFYING", BY, null]);
  await assertGoLiveAllows(BANKER, GW, VERIFY_MAX_AMOUNT);
  await assert.rejects(() => assertGoLiveAllows(BANKER, GW, VERIFY_MAX_AMOUNT + 1), (e) => e instanceof AccountNotLiveError && e.code === "ACCOUNT_NOT_LIVE" && e.status === 409);
  // The refusal a merchant reads names no gateway.
  assert.equal((await goLiveBlocker(BANKER, GW, 5_000))?.includes(GW), false);
  // Saving the credentials again does not restart or skip the checklist.
  assert.equal((await startVerifying(BANKER, GW, "someone-else@local", true))?.status, "VERIFYING");
});

test("it cannot be set live until the callback, a webhook-confirmed payment and a status check are recorded", opts, async () => {
  const refused = await setLive(BANKER, GW, BY, null);
  assert.ok(!refused.ok && /not complete/.test(refused.error));

  await rows("vendorGateway", "UPDATE gateway_golive SET ping_ok = true, ping_http_status = 200, ping_at = now(), ping_by = $2 WHERE merchant_id = $1", [BANKER, BY]);

  // A webhook that could not be verified, or that reported no payment, proves nothing.
  recordGatewayWebhook({ gateway: GW, merchantId: BANKER, txnId: "kp_itest_bad", signatureOk: false, outcome: "BAD_SIGNATURE" });
  recordGatewayWebhook({ gateway: GW, merchantId: BANKER, txnId: "kp_itest_pending", signatureOk: true, outcome: "NOT_FINAL", status: "UNKNOWN" });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await recordWebhookPayment(BANKER, GW, BY))?.webhook_at, null);

  recordGatewayWebhook({ gateway: GW, merchantId: BANKER, txnId: "kp_itest_paid", signatureOk: true, outcome: "APPLIED", status: "SUCCESS" });
  await new Promise((r) => setTimeout(r, 300));
  const hooked = await recordWebhookPayment(BANKER, GW, BY);
  assert.deepEqual([hooked?.webhook_txn_id, hooked?.webhook_by], ["kp_itest_paid", BY]);
  const still = await setLive(BANKER, GW, BY, null);
  assert.ok(!still.ok && /status check/.test(still.error));

  await rows("vendorGateway", "UPDATE gateway_golive SET status_order_id = webhook_order_id, status_at = now(), status_by = $2 WHERE merchant_id = $1", [BANKER, "checker@local"]);
  const live = await setLive(BANKER, GW, BY, "verified with a ₹10 payment");
  assert.ok(live.ok && live.row.status === "LIVE" && live.row.live_by === BY && live.row.live_at);

  await assertGoLiveAllows(BANKER, GW, 99_999);
  const row = await getGoLive(BANKER, GW);
  assert.deepEqual([row?.ping_by, row?.webhook_by, row?.status_by, row?.live_by, row?.note], [BY, BY, "checker@local", BY, "verified with a ₹10 payment"]);
});

test("an account that was already live keeps its payments when its credentials are saved again", opts, async () => {
  await rows("vendorGateway", "DELETE FROM gateway_golive WHERE merchant_id = $1", [BANKER]);
  const row = await startVerifying(BANKER, GW, BY, true);
  assert.deepEqual([row?.status, row?.live_by], ["LIVE", BY]);
  await assertGoLiveAllows(BANKER, GW, 99_999);
});

test("the health screen counts the webhooks a gateway sent and when the last one came", opts, async () => {
  const g = (await gatewayHealth(24)).find((x) => x.gateway_name === GW);
  assert.ok(g && g.webhooks_received_last_24h === 3 && g.last_webhook_at);
  // It took no orders, so its silence would not be an alert.
  assert.deepEqual([g!.orders_last_24h, g!.alerts], [0, []]);
});
