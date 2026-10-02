// The bank statement import against a real database. Run with `pnpm test:integration`.
//
// IT WRITES ROWS, so it only runs against a local database (PG_HOST localhost / 127.0.0.1) and
// removes the credits, cases and orders it created.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { rows } from "@/lib/pg";
import { createKatanaOrder } from "@/lib/katana-order";
import { setProviderFlow } from "@/lib/payin-flow-store";
import { POST as feedPost } from "@/app/api/v1/bank-feeds/[bank_code]/route";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };
const PROVIDER = process.env.TEST_PROVIDER_ID ?? "a0000000-0000-0000-0000-000000000001";
const BANKER = process.env.TEST_BANKER ?? "M10001";
const BANK = "ITESTBANK";
const KEY = "itest-cron-key";
const SECRET = "itest-bank-secret";
const BY = "integration-test@local";
// References unique to this run, so a re-run never meets its own earlier credits.
const R = String(Date.now()).slice(-9);
const RRN_A = `901${R}`, RRN_B = `902${R}`;
let saved: { cron?: string; secret?: string } = {};

const statement = (amountA = "733,00") => [
  ":20:ITEST", ":25:50200012345678", ":28C:1/1",
  ":60F:C261001INR1000,00",
  `:61:2610021002C${amountA}NTRFNONREF//B1`, `:86:UPI/CR/${RRN_A}/ASHA KUMAR/okaxis/asha@okaxis`,
  ":61:2610021002C267,00NTRFNONREF//B2", `:86:UPI/CR/${RRN_B}/RAVI/okhdfc/ravi@okhdfcbank`,
  ":61:2610021002D100,00NCHGNONREF", ":86:CHARGES",
  ":62F:C261002INR1900,00", "",
].join("\r\n");

const post = (body: string, headers: Record<string, string>, query = `merchant_id=${BANKER}`) =>
  feedPost(new Request(`http://test/api/v1/bank-feeds/${BANK}?${query}`, { method: "POST", headers: { "content-type": "text/plain", ...headers }, body }),
    { params: Promise.resolve({ bank_code: BANK }) });
const credits = () => rows<{ utr: string; amount: string; outcome: string; source: string }>("vendorGateway",
  "SELECT utr, amount::text, outcome, source FROM vendor_txn_alerts WHERE utr = ANY($1) AND outcome <> 'DUPLICATE' ORDER BY utr", [[RRN_A, RRN_B]]);

async function cleanup() {
  await rows("vendorGateway", "DELETE FROM vendor_manual_cases WHERE alert_id IN (SELECT alert_id FROM vendor_txn_alerts WHERE utr = ANY($1))", [[RRN_A, RRN_B]]);
  await rows("vendorGateway", "DELETE FROM vendor_txn_alerts WHERE utr = ANY($1)", [[RRN_A, RRN_B]]);
  await rows("vendorGateway", "DELETE FROM vendor_payin_orders WHERE order_id LIKE 'ITEST-FEED-%'");
  await rows("vendorGateway", "DELETE FROM vendor_security_alerts WHERE detail = $1", [`bank feed for ${BANK}`]);
}

before(async () => {
  saved = { cron: process.env.FIFO_CRON_KEY, secret: process.env[`BANK_FEED_SECRET_${BANK}`] };
  process.env.FIFO_CRON_KEY = KEY;
  process.env[`BANK_FEED_SECRET_${BANK}`] = SECRET;
  if (LOCAL) await cleanup();
});
after(async () => {
  if (LOCAL) {
    await cleanup();
    await setProviderFlow(PROVIDER, { flow: "UNSET", by: BY });
    await rows("provider", "DELETE FROM provider_payin_flow_history WHERE changed_by = $1", [BY]);
    await rows("provider", "UPDATE providers SET payin_flow_set_by = NULL, payin_flow_set_at = NULL WHERE payin_flow_set_by = $1", [BY]);
  }
  for (const [k, v] of [["FIFO_CRON_KEY", saved.cron], [`BANK_FEED_SECRET_${BANK}`, saved.secret]] as const)
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
});

// The session path (a person uploading) needs a browser request and is not exercised here.
test("a wrong signature, and a good one over a stale timestamp, are refused", opts, async () => {
  const ts = String(Date.now());
  assert.equal((await post(statement(), { "x-timestamp": ts, "x-signature": "00" })).status, 401);
  // A good signature over a stale timestamp is a replay.
  const old = String(Date.now() - 600_000);
  const sig = createHmac("sha256", SECRET).update(`${old}.${statement()}`).digest("hex");
  assert.equal((await post(statement(), { "x-timestamp": old, "x-signature": sig })).status, 401);
  assert.deepEqual(await credits(), []);
});

test("a dry run reads the statement and imports nothing", opts, async () => {
  const res = await post(statement(), { "x-cron-key": KEY }, `merchant_id=${BANKER}&dry_run=1`);
  const b = await res.json() as Record<string, any>;
  assert.equal(res.status, 200);
  assert.deepEqual([b.format, b.account, b.balanced, b.entries_in_file, b.ingested, b.outcomes, b.skipped_count], ["MT940", "50200012345678", true, 3, 2, { DRY_RUN: 2 }, 1]);
  assert.deepEqual(await credits(), []);
});

test("a statement that does not add up to its closing balance imports nothing", opts, async () => {
  const res = await post(statement("999,00"), { "x-cron-key": KEY });
  assert.equal(res.status, 422);
  assert.deepEqual(await credits(), []);
});

test("the bank's signed push imports the credits; the same statement again adds nothing", opts, async () => {
  const body = statement();
  const sign = () => { const ts = String(Date.now()); return { "x-timestamp": ts, "x-signature": createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex") }; };
  const first = await (await post(body, sign())).json() as Record<string, any>;
  assert.deepEqual([first.ok, first.ingested, first.skipped_count], [true, 2, 1]);
  assert.deepEqual((await credits()).map((c) => [c.utr, c.amount, c.source]), [[RRN_A, "733.00", "BANK_STATEMENT"], [RRN_B, "267.00", "BANK_STATEMENT"]]);

  const second = await (await post(body, sign())).json() as Record<string, any>;
  // The second sighting is kept as a DUPLICATE, which no collection figure counts.
  assert.deepEqual(second.outcomes, { DUPLICATE: 2 });
  assert.equal((await credits()).length, 2);
});

test("a statement line never marks an order paid, even when an order of that amount is waiting", opts, async () => {
  await cleanup();
  await setProviderFlow(PROVIDER, { flow: "P2P", by: BY });
  const o = await createKatanaOrder({ orderId: `ITEST-FEED-${Date.now()}`, amount: 733, currency: "INR", merchantId: BANKER, livemode: true, flow: "P2P" });
  const res = await (await post(statement(), { "x-cron-key": KEY })).json() as Record<string, any>;
  assert.equal(res.ingested, 2);
  assert.equal(res.outcomes.CONFIRMED, undefined);
  const after = await rows<{ status: string }>("vendorGateway", "SELECT status FROM vendor_payin_orders WHERE id = $1::uuid", [o.order.id]);
  assert.equal(after[0].status, "PENDING");
});
