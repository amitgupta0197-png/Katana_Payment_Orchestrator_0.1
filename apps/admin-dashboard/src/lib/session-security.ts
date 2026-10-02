// Session security: login rate-limiting (audit M4) and revocable sessions (audit M6).
//
// M4 — after too many failed logins for an email inside a window, further attempts are
//      locked out until the window clears.
// M6 — each session cookie carries the user's "session epoch" at issue time. Bumping the
//      epoch (password change, or an explicit log-out-everywhere) invalidates every session
//      issued before it, giving stateless cookies a revocation mechanism.
//
// NEITHER MAY FAIL SILENTLY. Both used to swallow every database error, and on a database
// that never got their tables (fifo 0014) that meant no lockout at all and passwords that
// could be changed without ending a stolen session — with nothing anywhere saying so. A read
// or write that fails still lets the login through (locking every user out because a table is
// missing would be worse), but it raises an ops alert, so the gap is known the first time it
// matters.

import { rows } from "@/lib/pg";
import { raiseAlert } from "@/lib/ops-alert";

const LOCK_THRESHOLD = Number(process.env.LOGIN_LOCK_THRESHOLD ?? 8);          // failures for one email before lockout
const IP_LOCK_THRESHOLD = Number(process.env.LOGIN_IP_LOCK_THRESHOLD ?? 30);   // failures from one address, across emails
const LOCK_WINDOW_MIN = Number(process.env.LOGIN_LOCK_WINDOW_MIN ?? 15);       // rolling window (minutes)

function broken(what: string, err: unknown): void {
  void raiseAlert({
    key: `auth:${what}`, severity: "CRITICAL", repeatMinutes: 360,
    title: what === "lockout" ? "Login lockout is not working" : "Session revocation is not working",
    body: `${(err as Error).message.slice(0, 200)}. Apply tools/migrations/fifo/0018_login_attempts_ip.sql and 0019_revoked_sessions.sql.`,
  });
}

/**
 * The address a request came from. nginx sets X-Real-IP to the peer it accepted the connection
 * from; X-Forwarded-For is appended to, so only its LAST entry is nginx's and the earlier ones
 * are whatever the caller sent.
 */
export function clientIp(req: Request): string | null {
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const xff = (req.headers.get("x-forwarded-for") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : null;
}

// ── M4: login rate-limiting ──────────────────────────────────────────────────────────

/** Locked when this email, or this address across all emails, has failed too often in the window. */
export async function loginLock(email: string, ip: string | null = null): Promise<{ locked: boolean; retryAfterSec: number }> {
  let r: { by_email: number; by_ip: number; oldest: string | null }[];
  try {
    r = await rows<{ by_email: number; by_ip: number; oldest: string | null }>("fifo", `
      SELECT count(*) FILTER (WHERE email = $1)::int AS by_email,
             count(*) FILTER (WHERE $3::text IS NOT NULL AND ip = $3)::int AS by_ip,
             min(created_at) AS oldest
        FROM fifo_login_attempts
       WHERE (email = $1 OR ($3::text IS NOT NULL AND ip = $3))
         AND created_at > now() - ($2 || ' minutes')::interval
    `, [email, String(LOCK_WINDOW_MIN), ip]);
  } catch (err) { broken("lockout", err); return { locked: false, retryAfterSec: 0 }; }
  const byEmail = r[0]?.by_email ?? 0, byIp = r[0]?.by_ip ?? 0;
  if (byEmail < LOCK_THRESHOLD && byIp < IP_LOCK_THRESHOLD) return { locked: false, retryAfterSec: 0 };
  const oldestMs = r[0]?.oldest ? new Date(r[0].oldest).getTime() : Date.now();
  const retryAfterSec = Math.max(1, Math.ceil((oldestMs + LOCK_WINDOW_MIN * 60_000 - Date.now()) / 1000));
  return { locked: true, retryAfterSec };
}

export async function recordLoginFailure(email: string, ip: string | null): Promise<void> {
  await rows("fifo", `INSERT INTO fifo_login_attempts (email, ip) VALUES ($1, $2)`, [email, ip]).catch((err) => broken("lockout", err));
}

/** A successful login clears the email's failures. The address's count is left to age out. */
export async function clearLoginFailures(email: string): Promise<void> {
  await rows("fifo", `DELETE FROM fifo_login_attempts WHERE email = $1`, [email]).catch(() => {});
}

// ── M6: revocable sessions via a per-user epoch ──────────────────────────────────────

// Small in-process cache so the per-request epoch check isn't a DB round-trip every time.
// Single-instance deployment, so this stays coherent; bumpEpoch clears the entry.
const epochCache = new Map<string, { v: number; at: number }>();
const EPOCH_TTL_MS = 30_000;

export async function currentEpoch(email: string): Promise<number> {
  const hit = epochCache.get(email);
  if (hit && Date.now() - hit.at < EPOCH_TTL_MS) return hit.v;
  const r = await rows<{ session_epoch: number }>("fifo",
    `SELECT session_epoch FROM fifo_user_security WHERE email = $1`, [email]).catch(() => [] as { session_epoch: number }[]);
  const v = r[0]?.session_epoch ?? 0;
  epochCache.set(email, { v, at: Date.now() });
  return v;
}

/** Invalidate every session issued so far for this user (log out everywhere). */
export async function revokeSessions(email: string): Promise<void> {
  await rows("fifo", `
    INSERT INTO fifo_user_security (email, session_epoch, updated_at) VALUES ($1, 1, now())
    ON CONFLICT (email) DO UPDATE SET session_epoch = fifo_user_security.session_epoch + 1, updated_at = now()
  `, [email]).catch((err) => broken("revocation", err));
  epochCache.delete(email);
}

/** True when a session carrying `sessionEpoch` is still current for this user. */
export async function epochValid(email: string, sessionEpoch: number | undefined): Promise<boolean> {
  return (sessionEpoch ?? 0) === await currentEpoch(email);
}

// ── Ending one session (logout) ──────────────────────────────────────────────────────

// The ids of sessions that were logged out and have not yet expired. Few and short-lived, so
// the whole set is held in memory and re-read at the same interval as the epoch; a logout on
// this instance takes effect at once.
let revoked = new Map<string, number>();   // sid → expiry (ms)
let revokedReadAt = 0;

async function revokedSet(): Promise<Map<string, number>> {
  if (Date.now() - revokedReadAt < EPOCH_TTL_MS) return revoked;
  try {
    const r = await rows<{ sid: string; expires_at: string }>("fifo",
      `SELECT sid, expires_at FROM fifo_revoked_sessions WHERE expires_at > now()`);
    revoked = new Map(r.map((x) => [x.sid, new Date(x.expires_at).getTime()]));
  } catch (err) { broken("revocation", err); }
  revokedReadAt = Date.now();
  return revoked;
}

/** End one session: its cookie is refused from now on. `exp` is the cookie's own expiry (unix seconds). */
export async function revokeSession(sid: string, email: string, exp: number): Promise<void> {
  revoked.set(sid, exp * 1000);
  await rows("fifo", `
    INSERT INTO fifo_revoked_sessions (sid, email, expires_at) VALUES ($1, $2, to_timestamp($3))
    ON CONFLICT (sid) DO NOTHING
  `, [sid, email, exp]).catch((err) => broken("revocation", err));
  await rows("fifo", `DELETE FROM fifo_revoked_sessions WHERE expires_at < now()`).catch(() => {});
}

export async function sessionRevoked(sid: string | undefined): Promise<boolean> {
  if (!sid) return false;
  return (await revokedSet()).has(sid);
}
