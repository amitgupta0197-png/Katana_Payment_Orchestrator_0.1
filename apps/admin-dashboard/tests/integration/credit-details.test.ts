// A captured payment keeps its detail block when it is merged into the row its push made.
// Run with `pnpm test:integration`.
//
// IT WRITES ROWS, so it only runs against a local database (PG_HOST localhost / 127.0.0.1) and
// removes the credits it created.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rows } from "@/lib/pg";
import { ingestTxnAlert } from "@/lib/txn-reconcile";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };
const BANKER = process.env.TEST_BANKER ?? "M10001";
const R = String(Date.now()).slice(-9);
const RRN_A = `903${R}`, RRN_B = `904${R}`;
// Amounts no other test or fixture uses, so the "exactly one complementary row" merge finds ours.
const AMT_A = `7${R.slice(-3)}.13`, AMT_B = `8${R.slice(-3)}.17`;
const DETAILS = { payment_amount: "₹ 1", paid_using: "UPI", counter_name: "DEFAULT" };

const row = (amount: string) => rows<{ utr: string | null; details: Record<string, string> | null }>("vendorGateway",
  `SELECT utr, details FROM vendor_txn_alerts WHERE merchant_id = $1 AND amount = $2 AND outcome <> 'DUPLICATE' ORDER BY created_at`,
  [BANKER, amount]);

async function cleanup() {
  await rows("vendorGateway", "DELETE FROM vendor_manual_cases WHERE alert_id IN (SELECT id FROM vendor_txn_alerts WHERE merchant_id = $1 AND amount = ANY($2::numeric[]))", [BANKER, [AMT_A, AMT_B]]).catch(() => {});
  await rows("vendorGateway", "DELETE FROM vendor_txn_alerts WHERE merchant_id = $1 AND amount = ANY($2::numeric[])", [BANKER, [AMT_A, AMT_B]]);
}

before(async () => { if (LOCAL) await cleanup(); });
after(async () => { if (LOCAL) await cleanup(); });

test("the RRN capture's details reach the row the payment push made", opts, async () => {
  await ingestTxnAlert({ source: "NOTIFICATION", merchant_id: BANKER, amount: AMT_A, sender: "com.paytm.business",
    raw: `₹${AMT_A} Received from ITEST PAYER`, payer_name: "ITEST PAYER", nonce: `n-a1-${R}` });
  await ingestTxnAlert({ source: "DEVICE", merchant_id: BANKER, amount: AMT_A, utr: RRN_A, bank: "PAYTM",
    raw: `RRN ${RRN_A}`, details: DETAILS, nonce: `n-a2-${R}` });
  const r = await row(AMT_A);
  assert.equal(r.length, 1, "one row for one payment");
  assert.equal(r[0].utr, RRN_A);
  assert.deepEqual(r[0].details, DETAILS);
});

test("a later read of the same RRN fills in details the row lacks", opts, async () => {
  await ingestTxnAlert({ source: "DEVICE", merchant_id: BANKER, amount: AMT_B, utr: RRN_B, bank: "PAYTM",
    raw: `RRN ${RRN_B}`, nonce: `n-b1-${R}` });
  assert.equal((await row(AMT_B))[0].details, null);
  await ingestTxnAlert({ source: "DEVICE", merchant_id: BANKER, amount: AMT_B, utr: RRN_B, bank: "PAYTM",
    raw: `RRN ${RRN_B} again`, details: DETAILS, nonce: `n-b2-${R}` });
  const r = await row(AMT_B);
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].details, DETAILS);
});
