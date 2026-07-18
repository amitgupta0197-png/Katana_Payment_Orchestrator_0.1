// POST /api/auth/login — email + password → signed cookie session.
// Real passwords: when the user has a scrypt password_hash we verify against it.
// Accounts not yet migrated to a real password (null / "demo-mode" hash) fall back
// to the shared DEMO_PASSWORD so the seeded demo logins keep working.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { setSessionCookie } from "@/lib/auth";
import { verifyPassword, isRealHash } from "@/lib/password";
import { publish } from "@/lib/events";
import { getMfa, checkLoginCode, deviceHash, recordDevice, isSensitiveRole, MFA_ENFORCED } from "@/lib/fifo-mfa";
import { loginLock, recordLoginFailure, clearLoginFailures, currentEpoch } from "@/lib/session-security";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totp: z.string().optional(),
});

export async function POST(req: Request) {
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;

  // Rate-limit / lockout (M4): too many recent failures for this email → refuse early.
  const lock = await loginLock(body.email);
  if (lock.locked)
    return NextResponse.json(
      { error: "too many failed attempts; try again later" },
      { status: 429, headers: { "Retry-After": String(lock.retryAfterSec) } },
    );

  try {
    const u = await rows<any>("auth", `
      SELECT id::text, email::text, COALESCE(full_name,'') AS full_name, status, password_hash
        FROM users WHERE email = $1
    `, [body.email]);
    if (!u.length) { await recordLoginFailure(body.email, ip); return NextResponse.json({ error: "invalid credentials" }, { status: 401 }); }
    if (u[0].status !== "active") return NextResponse.json({ error: "user disabled" }, { status: 403 });

    // Verify against the real password hash when set. The shared DEMO_PASSWORD fallback for
    // un-migrated accounts is DISABLED in production (audit C5) — otherwise any seeded account
    // with a null/non-scrypt hash logs in with "demo". In prod such an account cannot log in
    // until an admin sets a real password. Enable in a non-prod env with ALLOW_DEMO_LOGIN=1.
    const allowDemo = process.env.NODE_ENV !== "production" || process.env.ALLOW_DEMO_LOGIN === "1";
    const passwordOk = isRealHash(u[0].password_hash)
      ? verifyPassword(body.password, u[0].password_hash)
      : allowDemo && body.password === (process.env.DEMO_PASSWORD ?? "demo");
    if (!passwordOk) { await recordLoginFailure(body.email, ip); return NextResponse.json({ error: "invalid credentials" }, { status: 401 }); }

    const personas = await rows<any>("iam", `
      SELECT persona_kind, COALESCE(scope_id,'') AS scope_id, COALESCE(scope_label,'') AS scope_label, is_primary
        FROM user_personas WHERE user_id = $1::uuid
        ORDER BY is_primary DESC, granted_at DESC
    `, [u[0].id]);
    if (!personas.length) return NextResponse.json({ error: "no persona grants" }, { status: 403 });
    const primary = personas[0];

    // MFA (SEC-003). If the user has MFA enabled, a valid TOTP is always required.
    // If enforcement is on for a sensitive role but the user hasn't enrolled yet,
    // we still let them in (non-breaking) and signal that setup is required.
    const mfa = await getMfa(u[0].email);
    if (mfa?.enabled) {
      const ok = await checkLoginCode(u[0].email, body.totp);
      if (!ok) {
        await recordLoginFailure(body.email, ip);
        return NextResponse.json({ error: body.totp ? "invalid authentication code" : "authentication code required", mfa_required: true }, { status: 401 });
      }
    }
    const mfaSetupRequired = MFA_ENFORCED && isSensitiveRole(primary.persona_kind) && !mfa?.enabled;

    // Full success — clear the failure counter (M4).
    await clearLoginFailures(body.email);

    // Device binding (SEC-004): record the device and stamp its hash on the session.
    const ua = req.headers.get("user-agent");
    const dHash = deviceHash(ua, ip);
    await recordDevice(u[0].email, dHash, ua);

    await setSessionCookie({
      user_id: u[0].id,
      email: u[0].email,
      full_name: u[0].full_name,
      persona: primary.persona_kind,
      scope_id: primary.scope_id || null,
      scope_label: primary.scope_label,
      mfa: !!mfa?.enabled,
      device: dHash,
      sv: await currentEpoch(u[0].email),   // stamp the current session epoch (M6)
    });

    await publish({
      eventType: "auth.session_started",
      producer: "auth",
      entityType: "session",
      entityId: u[0].id,
      actorId: u[0].id,
      payload: { email: u[0].email, persona: primary.persona_kind, scope: primary.scope_label },
    });

    return NextResponse.json({
      user: { id: u[0].id, email: u[0].email, full_name: u[0].full_name },
      persona: primary.persona_kind,
      scope: { id: primary.scope_id || null, label: primary.scope_label },
      all_personas: personas,
      mfa_enabled: !!mfa?.enabled,
      mfa_setup_required: mfaSetupRequired,
    });
  } catch (err) {
    const e = pgError(err);
    return NextResponse.json(e.body, { status: e.status });
  }
}
