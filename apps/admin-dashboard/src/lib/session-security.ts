// Session security: login rate-limiting (audit M4) and revocable sessions (audit M6).
//
// M4 — after too many failed logins for an email inside a window, further attempts are
//      locked out until the window clears.
// M6 — each session cookie carries the user's "session epoch" at issue time. Bumping the
//      epoch (password change, or an explicit log-out-everywhere) invalidates every session
//      issued before it, giving stateless cookies a revocation mechanism.
//
// Both degrade safely: if the backing tables are missing (migration not yet applied) the
// helpers fail open for rate-limiting (no false lockout) and treat the epoch as 0.

import { rows } from "@/lib/pg";

const LOCK_THRESHOLD = Number(process.env.LOGIN_LOCK_THRESHOLD ?? 8);   // failures before lockout
const LOCK_WINDOW_MIN = Number(process.env.LOGIN_LOCK_WINDOW_MIN ?? 15); // rolling window (minutes)

// ── M4: login rate-limiting ──────────────────────────────────────────────────────────

export async function loginLock(email: string): Promise<{ locked: boolean; retryAfterSec: number }> {
  const r = await rows<{ n: number; oldest: string | null }>("fifo", `
    SELECT count(*)::int AS n, min(created_at) AS oldest
      FROM fifo_login_attempts
     WHERE email = $1 AND created_at > now() - ($2 || ' minutes')::interval
  `, [email, String(LOCK_WINDOW_MIN)]).catch(() => [] as { n: number; oldest: string | null }[]);
  const n = r[0]?.n ?? 0;
  if (n < LOCK_THRESHOLD) return { locked: false, retryAfterSec: 0 };
  const oldestMs = r[0]?.oldest ? new Date(r[0].oldest).getTime() : Date.now();
  const retryAfterSec = Math.max(1, Math.ceil((oldestMs + LOCK_WINDOW_MIN * 60_000 - Date.now()) / 1000));
  return { locked: true, retryAfterSec };
}

export async function recordLoginFailure(email: string, ip: string | null): Promise<void> {
  await rows("fifo", `INSERT INTO fifo_login_attempts (email, ip) VALUES ($1, $2)`, [email, ip]).catch(() => {});
}

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
  `, [email]).catch(() => {});
  epochCache.delete(email);
}

/** True when a session carrying `sessionEpoch` is still current for this user. */
export async function epochValid(email: string, sessionEpoch: number | undefined): Promise<boolean> {
  return (sessionEpoch ?? 0) === await currentEpoch(email);
}
