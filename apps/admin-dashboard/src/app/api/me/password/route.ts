// POST /api/me/password — the logged-in user changes their own password.
// Verifies the current password (real hash, or the shared demo password for
// un-migrated accounts), then stores a new scrypt hash. Works for any persona.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { rows, pgError } from "@/lib/pg";
import { hashPassword, verifyPassword, isRealHash } from "@/lib/password";

export const dynamic = "force-dynamic";

const schema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(6, "new password must be at least 6 characters").max(100),
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
    const currentOk = isRealHash(stored)
      ? verifyPassword(body.current_password, stored)
      : body.current_password === (process.env.DEMO_PASSWORD ?? "demo");
    if (!currentOk) return NextResponse.json({ error: "current password is incorrect" }, { status: 400 });

    await rows("auth", `UPDATE users SET password_hash = $2, updated_at = now() WHERE email = $1`,
      [session.email, hashPassword(body.new_password)]);

    return NextResponse.json({ ok: true });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
