// MFA + device binding engine (Katana BRD SEC-003, SEC-004). Enforcement is env-gated
// (FIFO_MFA_ENFORCE, default off; the policy is in lib/mfa-policy.ts). When a user has MFA
// enabled, a TOTP code is always required regardless of the enforce flag.

import { createHash } from "crypto";
import { openText, sealText } from "@/lib/sealed-text";
import { rows } from "@/lib/pg";
import { generateSecret, otpauthUri, verifyTotp } from "@/lib/totp";

export { SENSITIVE_ROLES, MFA_ENFORCED, isSensitiveRole } from "@/lib/mfa-policy";

export interface MfaRow { email: string; enabled: boolean; totp_secret: string }

export async function getMfa(email: string): Promise<MfaRow | null> {
  // A database that cannot be read must not read as "this user has no two-factor": that
  // would let a login through without its code. Only a missing table (nobody has enrolled
  // on this database yet) answers "none"; any other failure is the caller's to refuse on.
  const m = (await rows<MfaRow>("fifo", `SELECT email, enabled, totp_secret FROM fifo_user_mfa WHERE email=$1`, [email])
    .catch((err) => { if ((err as { code?: string }).code === "42P01") return [] as MfaRow[]; throw err; }))[0];
  // The secret is sealed at rest (lib/sealed-text); callers get the secret itself.
  return m ? { ...m, totp_secret: openText(m.totp_secret) } : null;
}

/** Enrolment refused: two-factor is already on and no valid current code came with the request. */
export class MfaCodeRequired extends Error {}

// Begin enrolment — (re)generates a secret in disabled state and returns the
// otpauth URI the user adds to their authenticator. Verifying activates it.
//
// Starting again REPLACES the secret and switches two-factor off until the new one is
// verified. On an account that already has it on, that is switching it off, so it takes a
// valid current code — the same proof disableMfa asks for. Without this a stolen session
// could re-enrol and be rid of the second factor.
export async function enrollMfa(email: string, userId?: string | null, currentToken?: string | null): Promise<{ secret: string; otpauth: string }> {
  const existing = await getMfa(email);
  if (existing?.enabled && !(currentToken && verifyTotp(existing.totp_secret, currentToken)))
    throw new MfaCodeRequired("two-factor is already on: send a current code to replace it");
  const secret = generateSecret();
  await rows("fifo", `
    INSERT INTO fifo_user_mfa (email, user_id, totp_secret, enabled, created_at)
    VALUES ($1,$2,$3,false, now())
    ON CONFLICT (email) DO UPDATE SET totp_secret=EXCLUDED.totp_secret, enabled=false, created_at=now(), verified_at=NULL
  `, [email, userId ?? null, sealText(secret)]);
  return { secret, otpauth: otpauthUri(secret, email) };
}

export async function verifyAndEnable(email: string, token: string): Promise<boolean> {
  const m = await getMfa(email);
  if (!m) return false;
  if (!verifyTotp(m.totp_secret, token)) return false;
  await rows("fifo", `UPDATE fifo_user_mfa SET enabled=true, verified_at=now() WHERE email=$1`, [email]);
  return true;
}

export async function disableMfa(email: string, token: string): Promise<boolean> {
  const m = await getMfa(email);
  if (!m) return true;
  if (m.enabled && !verifyTotp(m.totp_secret, token)) return false; // need a valid code to turn it off
  await rows("fifo", `DELETE FROM fifo_user_mfa WHERE email=$1`, [email]);
  return true;
}

// Check a login code against an enabled secret.
export async function checkLoginCode(email: string, token?: string): Promise<boolean> {
  const m = await getMfa(email);
  if (!m || !m.enabled) return true;          // no MFA enabled → nothing to check
  return !!token && verifyTotp(m.totp_secret, token);
}

/**
 * Remove a user's two-factor without a code: for a lost or replaced authenticator, by a Super
 * Admin. The user sets it up again at their next sign-in.
 */
export async function resetMfa(email: string): Promise<boolean> {
  return (await rows("fifo", `DELETE FROM fifo_user_mfa WHERE email=$1 RETURNING 1`, [email])).length > 0;
}

export function deviceHash(userAgent?: string | null, ip?: string | null): string {
  return createHash("sha256").update(`${userAgent ?? ""}|${ip ?? ""}`).digest("hex").slice(0, 32);
}

export async function recordDevice(email: string, hash: string, userAgent?: string | null): Promise<void> {
  await rows("fifo", `
    INSERT INTO fifo_user_devices (email, device_hash, label, last_seen)
    VALUES ($1,$2,$3, now())
    ON CONFLICT (email, device_hash) DO UPDATE SET last_seen=now()
  `, [email, hash, (userAgent ?? "").slice(0, 120)]).catch(() => {});
}
