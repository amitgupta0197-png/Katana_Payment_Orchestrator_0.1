// POST /api/auth/login — email + (demo) password → signed cookie session.
// Demo mode: password "demo" works for the seeded users (admin/provider/merchant @katana.dev).
// Production: replace with bcrypt against users.password_hash + rate limit + MFA.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { setSessionCookie } from "@/lib/auth";
import { publish } from "@/lib/events";
import { getMfa, checkLoginCode, deviceHash, recordDevice, isSensitiveRole, MFA_ENFORCED } from "@/lib/fifo-mfa";

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
  if (body.password !== (process.env.DEMO_PASSWORD ?? "demo")) {
    return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  }
  try {
    const u = await rows<any>("auth", `
      SELECT id::text, email::text, COALESCE(full_name,'') AS full_name, status
        FROM users WHERE email = $1
    `, [body.email]);
    if (!u.length) return NextResponse.json({ error: "user not found" }, { status: 401 });
    if (u[0].status !== "active") return NextResponse.json({ error: "user disabled" }, { status: 403 });

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
      if (!ok) return NextResponse.json({ error: body.totp ? "invalid authentication code" : "authentication code required", mfa_required: true }, { status: 401 });
    }
    const mfaSetupRequired = MFA_ENFORCED && isSensitiveRole(primary.persona_kind) && !mfa?.enabled;

    // Device binding (SEC-004): record the device and stamp its hash on the session.
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
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
