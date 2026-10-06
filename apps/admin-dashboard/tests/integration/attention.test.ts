// "Needs attention" (lib/attention-store) against the local database: a payment with no order shows
// up for its banker, a snooze hides it, and showing it again brings it back. Run with
// `pnpm test:integration`. IT WRITES ROWS, so it only runs against a local database and removes them.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { db, rows } from "@/lib/pg";
import { ingestTxnAlert } from "@/lib/txn-reconcile";
import { attention, snoozeAttention } from "@/lib/attention-store";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };
const BANKER = process.env.TEST_BANKER ?? "M10001";
const BY = "integration-test@local";
const R = String(Date.now()).slice(-9);
const AMOUNT = Number(`7${R.slice(-3)}.41`);
const KEY = `UNMATCHED_MONEY:${BANKER}`;

async function cleanup() {
  await rows("vendorGateway", "DELETE FROM vendor_manual_cases WHERE alert_id IN (SELECT id FROM vendor_txn_alerts WHERE merchant_id = $1 AND amount = $2)", [BANKER, AMOUNT]).catch(() => {});
  await rows("vendorGateway", "DELETE FROM vendor_txn_alerts WHERE merchant_id = $1 AND amount = $2", [BANKER, AMOUNT]);
  await rows("merchant", "DELETE FROM attention_snoozes WHERE snoozed_by = $1", [BY]).catch(() => {});
}
before(async () => {
  if (!LOCAL) return;
  const c = await db("merchant").connect();
  try { await c.query(readFileSync("../../tools/migrations/merchant/0024_attention_snoozes.sql", "utf8")); } finally { c.release(); }
  await cleanup();
});
after(async () => { if (LOCAL) await cleanup(); setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref(); });

test("a payment with no order is listed for its banker; a snooze hides it until shown again", opts, async () => {
  const res = await ingestTxnAlert({ source: "DEVICE", merchant_id: BANKER, amount: AMOUNT, utr: `906${R}`, bank: "PAYTM", raw: `RRN 906${R}`, nonce: `n-att-${R}` });
  assert.notEqual(res.outcome, "CONFIRMED");

  const v = await attention(true);
  const row = v.items.find((i) => i.key === KEY);
  assert.ok(row, "the unmatched payment is listed");
  assert.equal(row!.category, "UNMATCHED_MONEY");
  assert.equal(row!.severity, 1);
  assert.match(row!.fix!.href, /^\/unmatched\?banker=/);
  assert.ok(v.counts.UNMATCHED_MONEY >= 1);

  await snoozeAttention(KEY, BY, 24);
  const hidden = await attention();
  assert.ok(!hidden.items.some((i) => i.key === KEY), "hidden while snoozed");
  assert.ok(hidden.snoozed >= 1);

  await snoozeAttention(KEY, BY, 0);
  assert.ok((await attention()).items.some((i) => i.key === KEY), "back once shown again");
});
