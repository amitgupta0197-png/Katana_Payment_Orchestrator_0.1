// Login lockout, session revocation and two-factor enrolment against a real database.
// Run with `pnpm test:integration`.
//
// IT WRITES ROWS, so it only runs against a local database (PG_HOST localhost / 127.0.0.1) and
// removes them. Every email and address it uses is its own.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rows } from "@/lib/pg";
import { clientIp, clearLoginFailures, currentEpoch, epochValid, loginLock, recordLoginFailure, revokeSessions } from "@/lib/session-security";
import { enrollMfa, getMfa, MfaCodeRequired, verifyAndEnable, disableMfa } from "@/lib/fifo-mfa";
import { totpNow } from "@/lib/totp";
import { isSealed } from "@/lib/sealed-text";
import { generatePassword, MIN_PASSWORD_LENGTH } from "@/lib/password";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };
const RUN = Date.now();
const email = (n: string) => `itest-${n}-${RUN}@example.com`;
const IP = `203.0.113.${RUN % 250}`;

async function cleanup() {
  await rows("fifo", "DELETE FROM fifo_login_attempts WHERE email LIKE 'itest-%@example.com'");
  await rows("fifo", "DELETE FROM fifo_user_security WHERE email LIKE 'itest-%@example.com'");
  await rows("fifo", "DELETE FROM fifo_user_mfa WHERE email LIKE 'itest-%@example.com'");
}
before(async () => { if (LOCAL) await cleanup(); });
after(async () => { if (LOCAL) await cleanup(); setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref(); });

test("the caller's address is the one nginx saw, not one the caller sent", () => {
  const h = (headers: Record<string, string>) => clientIp(new Request("http://test/", { headers }));
  assert.equal(h({ "x-real-ip": "198.51.100.7", "x-forwarded-for": "1.2.3.4, 198.51.100.7" }), "198.51.100.7");
  assert.equal(h({ "x-forwarded-for": "1.2.3.4, 5.6.7.8, 198.51.100.7" }), "198.51.100.7");   // the last entry is the proxy's
  assert.equal(h({}), null);
});

test("an email is locked after eight failures and unlocked by a successful login", opts, async () => {
  const e = email("lock");
  for (let i = 0; i < 7; i++) await recordLoginFailure(e, null);
  assert.equal((await loginLock(e)).locked, false);
  await recordLoginFailure(e, null);
  const l = await loginLock(e);
  assert.equal(l.locked, true);
  assert.ok(l.retryAfterSec > 0 && l.retryAfterSec <= 15 * 60);
  assert.equal((await loginLock(email("other"))).locked, false);        // another account is not affected
  await clearLoginFailures(e);
  assert.equal((await loginLock(e)).locked, false);
});

test("one address trying many accounts is locked out of all of them", opts, async () => {
  for (let i = 0; i < 30; i++) await recordLoginFailure(email(`spray${i}`), IP);
  assert.equal((await loginLock(email("never-tried"), IP)).locked, true);     // a fresh email, same address
  assert.equal((await loginLock(email("never-tried"), "198.51.100.200")).locked, false);
  assert.equal((await loginLock(email("spray3"), "198.51.100.200")).locked, false);   // one failure each: the emails are fine
});

test("revoking a user's sessions makes every earlier session invalid", opts, async () => {
  const e = email("revoke");
  const issuedAt = await currentEpoch(e);
  assert.equal(await epochValid(e, issuedAt), true);
  await revokeSessions(e);
  assert.equal(await epochValid(e, issuedAt), false);
  assert.equal(await epochValid(e, await currentEpoch(e)), true);            // a session issued now is fine
});

test("two-factor that is on cannot be replaced or switched off without a current code", opts, async () => {
  const e = email("mfa");
  const first = await enrollMfa(e);
  // The secret is sealed in the database and handed to callers as the secret itself.
  const stored = (await rows<{ totp_secret: string }>("fifo", "SELECT totp_secret FROM fifo_user_mfa WHERE email = $1", [e]))[0].totp_secret;
  assert.equal(isSealed(stored), true);
  assert.equal((await getMfa(e))?.totp_secret, first.secret);

  // Not yet verified: starting again needs no code.
  const second = await enrollMfa(e);
  assert.notEqual(second.secret, first.secret);
  assert.equal(await verifyAndEnable(e, totpNow(second.secret)), true);

  // Now it is on: re-enrolling without a code, or with a wrong one, is refused and changes nothing.
  await assert.rejects(enrollMfa(e), MfaCodeRequired);
  await assert.rejects(enrollMfa(e, null, "000000"), MfaCodeRequired);
  assert.deepEqual([(await getMfa(e))?.enabled, (await getMfa(e))?.totp_secret], [true, second.secret]);
  assert.equal(await disableMfa(e, "000000"), false);

  // With a current code it is replaced, and is off until the new secret is verified.
  const third = await enrollMfa(e, null, totpNow(second.secret));
  assert.notEqual(third.secret, second.secret);
  assert.equal((await getMfa(e))?.enabled, false);
});

test("a generated password meets the minimum length", () => {
  assert.equal(MIN_PASSWORD_LENGTH, 12);
  assert.ok(generatePassword().length >= MIN_PASSWORD_LENGTH);
  assert.notEqual(generatePassword(), generatePassword());
});
