// "Test my integration" (lib/integration-dryrun-store) against the local database: a correctly
// signed test order is accepted and creates nothing; a wrong hash is explained without the Salt;
// a banker login can't check another banker's key (it reads like an unknown key).
// Run with `pnpm test:integration`. Local database only.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "crypto";
import { rows } from "@/lib/pg";
import type { Session } from "@/lib/auth";
import { getCheckoutCreds, issueCheckoutCreds } from "@/lib/merchant-checkout";
import { dryRunOrder } from "@/lib/integration-dryrun-store";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const opts = { skip: LOCAL ? false : `refusing to run against a non-local database (${HOST})` };
const BANKER = process.env.TEST_BANKER ?? "M10001";
const R = String(Date.now()).slice(-8);

after(() => { setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref(); });

const session = (persona: Session["persona"], scope_id: string | null): Session =>
  ({ user_id: `itest-${persona}-${R}`, email: `itest-${R}@local`, full_name: "Integration test", persona, scope_id, scope_label: "" } as Session);

const hmac = (key: string, salt: string, s: string) => createHmac("sha256", key + salt).update(s).digest("hex");

test("a signed test order would be accepted, and nothing is created", opts, async () => {
  const creds = (await getCheckoutCreds(BANKER, false)) ?? (await issueCheckoutCreds(BANKER, "HMAC_SHA256", false));
  const txnid = `ITEST-DRY-${R}`;
  const body = { key: creds.key, txnid, amount: "1.00", productinfo: "Test", email: "t@example.com",
    hash: hmac(creds.key, creds.salt, `${txnid}|1.00|Test|t@example.com`) };
  const r = await dryRunOrder(session("SUPER_ADMIN", null), JSON.stringify(body), "test");
  assert.ok(!("limited" in r));
  if ("limited" in r) return;
  assert.equal(r.banker, BANKER);
  assert.equal(r.livemode, false);
  assert.ok(!r.problems.some((p) => p.code === "SIGNATURE_MISMATCH"), JSON.stringify(r.problems));
  assert.ok(r.passed.includes("The hash is right."));
  const made = await rows("vendorGateway", "SELECT 1 FROM vendor_payin_orders WHERE order_id = $1", [txnid]);
  assert.equal(made.length, 0, "a dry run makes no order");

  // A wrong hash: explained, with the string to sign, never the Salt.
  const bad = await dryRunOrder(session("SUPER_ADMIN", null), JSON.stringify({ ...body, amount: "1" }), "test");
  if ("limited" in bad) return;
  const sig = bad.problems.find((p) => p.code === "SIGNATURE_MISMATCH");
  assert.ok(sig, "the mismatch is reported");
  assert.match(sig!.fix, new RegExp(`${txnid}\\|1\\|Test\\|t@example.com`));
  assert.ok(!JSON.stringify(bad).includes(creds.salt), "the Salt is never shown");
});

test("a banker login can't check another banker's key: it reads like an unknown key", opts, async () => {
  const creds = (await getCheckoutCreds(BANKER, false)) ?? (await issueCheckoutCreds(BANKER, "HMAC_SHA256", false));
  const other = (await rows<{ code: string }>("merchant", "SELECT merchant_code AS code FROM merchants WHERE merchant_code <> $1 LIMIT 1", [BANKER]))[0];
  assert.ok(other, "needs a second banker in the local database");
  const body = { key: creds.key, txnid: `ITEST-DRY2-${R}`, amount: "1.00", hash: "00" };
  const r = await dryRunOrder(session("MERCHANT", other.code), JSON.stringify(body), "test");
  if ("limited" in r) return;
  assert.equal(r.banker, null);
  assert.deepEqual(r.problems.map((p) => p.code), ["INVALID_KEY"]);
  assert.ok(!JSON.stringify(r).includes(BANKER), "the other banker is never named");
});
