// MFA + device binding engine (PayTech BRD SEC-003, SEC-004). Non-breaking:
// enforcement is env-gated (FIFO_MFA_ENFORCE, default off) so live logins keep
// working until users enrol. When a user has MFA enabled, a TOTP code is always
// required regardless of the enforce flag.

import { createHash } from "crypto";
import { rows } from "@/lib/pg";
import { generateSecret, otpauthUri, verifyTotp } from "@/lib/totp";
import type { Persona } from "@/lib/auth";

export const SENSITIVE_ROLES: Persona[] = ["SUPER_ADMIN", "ADMIN", "OPERATOR", "FINANCE", "RISK", "COMPLIANCE"];
export const MFA_ENFORCED = (process.env.FIFO_MFA_ENFORCE ?? "false") === "true";

export function isSensitiveRole(p: Persona): boolean { return SENSITIVE_ROLES.includes(p); }

export interface MfaRow { email: string; enabled: boolean; totp_secret: string }

export async function getMfa(email: string): Promise<MfaRow | null> {
  return (await rows<MfaRow>("fifo", `SELECT email, enabled, totp_secret FROM fifo_user_mfa WHERE email=$1`, [email]).catch(() => []))[0] ?? null;
}

// Begin enrolment — (re)generates a secret in disabled state and returns the
// otpauth URI the user adds to their authenticator. Verifying activates it.
export async function enrollMfa(email: string, userId?: string | null): Promise<{ secret: string; otpauth: string }> {
  const secret = generateSecret();
  await rows("fifo", `
    INSERT INTO fifo_user_mfa (email, user_id, totp_secret, enabled, created_at)
    VALUES ($1,$2,$3,false, now())
    ON CONFLICT (email) DO UPDATE SET totp_secret=EXCLUDED.totp_secret, enabled=false, created_at=now(), verified_at=NULL
  `, [email, userId ?? null, secret]);
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
