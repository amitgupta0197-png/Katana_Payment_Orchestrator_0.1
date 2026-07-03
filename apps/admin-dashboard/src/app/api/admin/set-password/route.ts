// POST /api/admin/set-password — SUPER_ADMIN sets (or resets) the login password
// for a provider or merchant user. Provisions the login (users row + persona grant)
// if it doesn't exist yet, so an admin can hand a provider/merchant their credentials.
//
// Body: { email, password?, kind?: "MERCHANT"|"PROVIDER", scope_id?, scope_label?, full_name? }
//   - password omitted → a one-time password is generated and returned.
//   - kind + scope_id → ensures the matching persona grant exists.
// Returns: { email, password, generated, created_user }

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { hashPassword, generatePassword } from "@/lib/password";

export const dynamic = "force-dynamic";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(6, "password must be at least 6 characters").max(100).optional(),
  kind: z.enum(["MERCHANT", "PROVIDER"]).optional(),
  scope_id: z.string().optional(),
  scope_label: z.string().optional(),
  full_name: z.string().optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;

  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const password = body.password ?? generatePassword();
  const generated = !body.password;

  try {
    const existing = await rows<{ id: string }>("auth", `SELECT id::text FROM users WHERE email = $1`, [body.email]);
    let userId: string;
    let createdUser = false;
    if (existing.length) {
      userId = existing[0].id;
      await rows("auth", `UPDATE users SET password_hash = $2, status = 'active', updated_at = now() WHERE id = $1::uuid`,
        [userId, hashPassword(password)]);
    } else {
      const created = await rows<{ id: string }>("auth", `
        INSERT INTO users (id, email, full_name, password_hash, status)
        VALUES (gen_random_uuid(), $1, $2, $3, 'active') RETURNING id::text
      `, [body.email, body.full_name || body.email, hashPassword(password)]);
      userId = created[0].id;
      createdUser = true;
    }

    // Ensure the persona grant exists (idempotent) when scope info is supplied.
    if (body.kind && body.scope_id) {
      await rows("iam", `
        INSERT INTO user_personas (id, user_id, persona_kind, scope_id, scope_label, is_primary, granted_by)
        SELECT gen_random_uuid(), $1::uuid, $2, $3, $4, true, $5
        WHERE NOT EXISTS (
          SELECT 1 FROM user_personas WHERE user_id = $1::uuid AND persona_kind = $2 AND scope_id = $3
        )
      `, [userId, body.kind, body.scope_id, body.scope_label ?? body.scope_id, s.email]);
    }

    return NextResponse.json({ email: body.email, password, generated, created_user: createdUser });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
