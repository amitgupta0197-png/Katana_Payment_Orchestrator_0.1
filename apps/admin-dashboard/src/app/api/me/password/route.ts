// POST /api/me/password — the logged-in user changes their own password.
// Verifies the current password (real hash, or the shared demo password for
// un-migrated accounts), then stores a new scrypt hash. Works for any persona.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession, setSessionCookie } from "@/lib/auth";
import { rows, pgError } from "@/lib/pg";
import { hashPassword, verifyPassword, isRealHash, MIN_PASSWORD_LENGTH } from "@/lib/password";
import { revokeSessions, currentEpoch } from "@/lib/session-security";

export const dynamic = "force-dynamic";

const schema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(MIN_PASSWORD_LENGTH, `new password must be at least ${MIN_PASSWORD_LENGTH} characters`).max(100),
});

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  try {
    const u = await rows<{ password_hash: string | null }>("auth",
      `SELECT password_hash FROM users WHERE email = $1`, [session.email]);
    if (!u.length) return NextResponse.json({ error: "user not found" }, { status: 404 });

    const stored = u[0].password_hash;
    // The shared demo password stands in for a missing one only where the login route accepts
    // it: never in production. There, an account with no real password cannot change it here;
    // an admin sets one.
    const allowDemo = process.env.NODE_ENV !== "production" || process.env.ALLOW_DEMO_LOGIN === "1";
    const currentOk = isRealHash(stored)
      ? verifyPassword(body.current_password, stored)
      : allowDemo && body.current_password === (process.env.DEMO_PASSWORD ?? "demo");
    if (!currentOk) return NextResponse.json({ error: "current password is incorrect" }, { status: 400 });

    await rows("auth", `UPDATE users SET password_hash = $2, updated_at = now() WHERE email = $1`,
      [session.email, hashPassword(body.new_password)]);

    // Revoke every existing session for this user (M6), then re-issue THIS one so the
    // caller stays logged in while any other/stolen sessions are invalidated.
    await revokeSessions(session.email);
    await setSessionCookie({
      user_id: session.user_id, email: session.email, full_name: session.full_name,
      persona: session.persona, scope_id: session.scope_id, scope_label: session.scope_label,
      mfa: session.mfa, device: session.device, sv: await currentEpoch(session.email),
    });

    return NextResponse.json({ ok: true });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
