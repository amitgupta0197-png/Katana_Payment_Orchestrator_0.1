// Persona-based session. HMAC-signed cookie carrying (user_id, persona, scope_id).
// Production: replace with proper JWT lib (jose) + RS256 + rotation.

import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";

// BRD §8 roles. OPERATOR/COMPLIANCE/FINANCE/RISK/SUPPORT added for the FIFO
// payment-operations module; access is enforced per-route via gateOrResponse.
export type Persona =
  | "SUPER_ADMIN" | "ADMIN" | "PROVIDER" | "MERCHANT"
  | "OPERATOR" | "COMPLIANCE" | "FINANCE" | "RISK" | "SUPPORT";

export interface Session {
  user_id: string;
  email: string;
  full_name: string;
  persona: Persona;
  scope_id: string | null;
  scope_label: string;
  mfa?: boolean;       // MFA satisfied at login (SEC-003)
  device?: string;     // bound device hash (SEC-004)
  exp: number; // unix seconds
}

const COOKIE_NAME = "katana_session";
const SECRET = process.env.SESSION_SECRET ?? "dev-session-secret-do-not-use-in-prod";
const TTL_SECONDS = 8 * 60 * 60;

function sign(payload: string): string {
  return createHmac("sha256", SECRET).update(payload).digest("base64url");
}

export function signSession(s: Omit<Session, "exp">): string {
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const body = Buffer.from(JSON.stringify({ ...s, exp })).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function verifySession(token: string | undefined): Session | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = sign(body);
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch { return null; }
  let parsed: Session;
  try { parsed = JSON.parse(Buffer.from(body, "base64url").toString()); } catch { return null; }
  if (parsed.exp < Math.floor(Date.now() / 1000)) return null;
  return parsed;
}

export async function getSession(): Promise<Session | null> {
  const c = await cookies();
  return verifySession(c.get(COOKIE_NAME)?.value);
}

export async function setSessionCookie(s: Omit<Session, "exp">) {
  const c = await cookies();
  c.set(COOKIE_NAME, signSession(s), {
    httpOnly: true, sameSite: "lax", path: "/",
    // Secure by default in production, but allow opt-out for deployments
    // served over plain HTTP (e.g. an IP-only box with no TLS) where a
    // Secure cookie would be silently dropped by the browser.
    secure: process.env.COOKIE_SECURE
      ? process.env.COOKIE_SECURE === "true"
      : process.env.NODE_ENV === "production",
    maxAge: TTL_SECONDS,
  });
}

export async function clearSessionCookie() {
  const c = await cookies();
  c.delete(COOKIE_NAME);
}

export function requirePersona(s: Session | null, ...allowed: Persona[]): { ok: true; session: Session } | { ok: false; status: 401 | 403; error: string } {
  if (!s) return { ok: false, status: 401, error: "not authenticated" };
  if (allowed.length && !allowed.includes(s.persona))
    return { ok: false, status: 403, error: `requires ${allowed.join("|")} persona; you are ${s.persona}` };
  return { ok: true, session: s };
}
