// Katana's payout sandbox (lib/payout-providers/sandbox): where a test-key payout goes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { sandboxOutcome, sandboxUtr, SANDBOX_SETTLE_SECONDS, sandboxConnector, SANDBOX_PAYOUT } from "@/lib/payout-providers/sandbox";
import { payoutConnector, sandboxPayout } from "@/lib/payout-providers";
import { publicPayoutStatus } from "@/lib/payout-api";

test("the paise decide: .99 succeeds at once, .13 fails, anything else succeeds after a few seconds", () => {
  assert.equal(sandboxOutcome(1099n, 0).final, "SUCCESS");
  assert.equal(sandboxOutcome(1013n, 0).final, "FAILED");
  assert.match(sandboxOutcome(1013n, 0).msg!, /\.13/);
  assert.equal(sandboxOutcome(1013n, 999).final, "FAILED", "a failure stays a failure");
  assert.equal(sandboxOutcome(1000n, 0).final, null);
  assert.equal(sandboxOutcome(1000n, SANDBOX_SETTLE_SECONDS - 1).final, null);
  assert.equal(sandboxOutcome(1000n, SANDBOX_SETTLE_SECONDS).final, "SUCCESS");
});

test("a sandbox payout gets a stable, obviously made-up bank reference", () => {
  assert.equal(sandboxUtr("TXN-1"), sandboxUtr("TXN-1"));
  assert.notEqual(sandboxUtr("TXN-1"), sandboxUtr("TXN-2"));
  assert.match(sandboxUtr("TXN-1"), /^SBX\d{9}$/);
});

test("the sandbox is a connector the payout engine can look up, and it is test only", async () => {
  assert.equal(payoutConnector(SANDBOX_PAYOUT), sandboxConnector);
  assert.equal(sandboxPayout().creds.env, "TEST");
  assert.deepEqual(await sandboxConnector.creds("ANY"), { env: "TEST" });
  const accepted = await sandboxConnector.transfer({ env: "TEST" }, {
    ref: "TXN-9", txnRef: "TXN-9", amountMinor: 1099n, rail: "IMPS", purpose: "x", beneficiaryName: "y",
  });
  assert.ok(accepted.ok && accepted.data.state?.final === "SUCCESS" && accepted.data.state.amountMinor === 1099n);
  const pending = await sandboxConnector.transfer({ env: "TEST" }, {
    ref: "TXN-8", txnRef: "TXN-8", amountMinor: 1000n, rail: "IMPS", purpose: "x", beneficiaryName: "y",
  });
  assert.ok(pending.ok && pending.data.state === undefined, "in flight: settled later by the status check");
});

test("a failure reason that names a gateway is scrubbed before a merchant reads it", async () => {
  const { payoutView } = await import("@/lib/payout-api");
  const v = payoutView({ order_ref: "PO-1", status: "FAILED", amount_minor: "100", currency: "INR", livemode: true,
    failure_reason: "PayU refused the transfer: insufficient balance", created_at: new Date() });
  assert.equal(v.failure_reason, "payment processor refused the transfer: insufficient balance");
  assert.equal(publicPayoutStatus("SUBMITTED"), "PROCESSING");
});
