// Linked mailboxes against a real database: approval, and the sign-in state.
// Run with `pnpm test:integration`.
//
// IT WRITES ROWS, so it only runs against a local database (PG_HOST localhost / 127.0.0.1) and
// removes them. The mailbox it creates has no working token; nothing is fetched from Google.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rows, db } from "@/lib/pg";
import { pollInboxByEmail } from "@/lib/email-ingest";
import { signState, verifyState } from "@/lib/gmail-oauth";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };
const EMAIL = `itest-mailbox-${Date.now()}@example.com`;

const cleanup = () => rows("vendorGateway", "DELETE FROM vendor_email_inboxes WHERE email LIKE 'itest-mailbox-%@example.com'");
before(async () => { if (LOCAL) await cleanup(); });
after(async () => { if (LOCAL) await cleanup(); setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref(); });

test("a sign-in state is good for fifteen minutes, and only as it was signed", () => {
  const s = signState("M10001", "dev-1");
  assert.deepEqual(verifyState(s), { merchant: "M10001", device: "dev-1" });
  assert.equal(verifyState(s, Date.now() + 16 * 60_000), null);                 // a link someone kept
  assert.deepEqual(verifyState(s, Date.now() + 14 * 60_000), { merchant: "M10001", device: "dev-1" });
  // The merchant in the payload cannot be swapped under the same signature.
  const [payload, sig] = s.split(".");
  const other = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), merchant: "M99999" })).toString("base64url");
  assert.equal(verifyState(`${other}.${sig}`), null);
  assert.equal(verifyState("nonsense"), null);
});

test("a newly linked mailbox is not read until it is approved", opts, async () => {
  await rows("vendorGateway", `
    INSERT INTO vendor_email_inboxes (merchant_id, email, auth_type, refresh_token, enabled, status, linked_via)
    VALUES ('M10001', $1, 'OAUTH', 'itest-not-a-token', true, 'OK', 'OAUTH_LINK')`, [EMAIL]);
  const row = async () => (await rows<{ approved: boolean; last_polled_at: string | null }>("vendorGateway",
    "SELECT approved, last_polled_at FROM vendor_email_inboxes WHERE email = $1", [EMAIL]))[0];
  assert.equal((await row()).approved, false);                                   // the default
  assert.equal(await pollInboxByEmail(EMAIL), null);                             // not read
  assert.equal((await row()).last_polled_at, null);

  // Applying the approval migration again must not approve it: only mailboxes from before the rule are.
  const client = await db("vendorGateway").connect();
  try { await client.query(readFileSync("../../tools/migrations/vendorGateway/0036_email_inbox_approval.sql", "utf8")); } finally { client.release(); }
  assert.equal((await row()).approved, false);

  // Once approved it is read. Its token is not real, so the read fails — and that it was tried is the point.
  await rows("vendorGateway", "UPDATE vendor_email_inboxes SET approved = true, approved_by = 'itest' WHERE email = $1", [EMAIL]);
  const polled = await pollInboxByEmail(EMAIL);
  assert.ok(polled);
  assert.ok(polled.error);
  assert.notEqual((await row()).last_polled_at, null);
});
