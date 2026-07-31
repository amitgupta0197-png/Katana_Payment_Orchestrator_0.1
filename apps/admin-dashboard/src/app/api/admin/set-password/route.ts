// POST /api/admin/set-password — SUPER_ADMIN or ADMIN sets (or resets) the login
// password for a provider or merchant user. Provisions the login (users row +
// persona grant) if it doesn't exist yet, so an admin can hand a provider/merchant
// their credentials. Aligned with banker login provisioning (/api/v1/dt/bankers),
// which the same roles can call. Note: this route is exempted from the middleware's
// blanket SUPER_ADMIN-only /api/admin/* gate — the gate below is authoritative.
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
import { revokeSessions } from "@/lib/session-security";

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
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN"]);
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
      // Privilege guard (audit H7): this self-service provisioning route may only (re)set
      // passwords for tenant logins (MERCHANT/PROVIDER/BANKER). Refuse to touch a privileged
      // staff account, so an ADMIN cannot reset a SUPER_ADMIN's password and take it over.
      const PRIVILEGED = new Set(["SUPER_ADMIN", "ADMIN", "FINANCE", "COMPLIANCE", "RISK", "OPERATOR", "SUPPORT"]);
      const targetPersonas = await rows<{ persona_kind: string }>("iam",
        `SELECT persona_kind FROM user_personas WHERE user_id = $1::uuid`, [userId]);
      if (targetPersonas.some((p) => PRIVILEGED.has(p.persona_kind)))
        return NextResponse.json({ error: "cannot set the password of a privileged staff account via this route" }, { status: 403 });
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

    // Invalidate any existing sessions for the account whose password just changed (M6).
    await revokeSessions(body.email);

    // Ensure the persona grant exists (idempotent) when scope info is supplied, and
    // make it PRIMARY.
    //
    // Login picks the persona by `ORDER BY is_primary DESC, granted_at DESC`, so a user
    // that already held a primary grant for some other entity would keep landing in that
    // entity's portal — the admin sets a password here and the login goes somewhere else.
    // Setting a password from an entity's page is an unambiguous statement of "this login
    // belongs to THIS entity", so the new grant is promoted and the others demoted.
    if (body.kind && body.scope_id) {
      await rows("iam", `
        INSERT INTO user_personas (id, user_id, persona_kind, scope_id, scope_label, is_primary, granted_by)
        SELECT gen_random_uuid(), $1::uuid, $2, $3, $4, true, $5
        WHERE NOT EXISTS (
          SELECT 1 FROM user_personas WHERE user_id = $1::uuid AND persona_kind = $2 AND scope_id = $3
        )
      `, [userId, body.kind, body.scope_id, body.scope_label ?? body.scope_id, s.email]);

      // Demote every other grant, then promote this one. Two statements rather than one
      // so a pre-existing grant (which the INSERT above skipped) is still promoted.
      await rows("iam", `
        UPDATE user_personas SET is_primary = false
         WHERE user_id = $1::uuid AND NOT (persona_kind = $2 AND scope_id = $3)
      `, [userId, body.kind, body.scope_id]);
      await rows("iam", `
        UPDATE user_personas SET is_primary = true
         WHERE user_id = $1::uuid AND persona_kind = $2 AND scope_id = $3
      `, [userId, body.kind, body.scope_id]);
    }

    // Tell the admin where this login will actually land, and flag it when the change
    // moved an existing login away from another entity's portal — that is a surprising
    // side effect if the same email is shared between two entities.
    const PORTAL: Record<string, string> = {
      PROVIDER: "Merchant portal (/provider-portal)",
      MERCHANT: "Banker portal (/merchant-portal)",
    };
    const others = body.kind && body.scope_id
      ? await rows<{ persona_kind: string; scope_label: string }>("iam", `
          SELECT persona_kind, COALESCE(scope_label, scope_id, '') AS scope_label
            FROM user_personas
           WHERE user_id = $1::uuid AND NOT (persona_kind = $2 AND scope_id = $3)
        `, [userId, body.kind, body.scope_id]).catch(() => [])
      : [];

    return NextResponse.json({
      email: body.email, password, generated, created_user: createdUser,
      lands_on: body.kind ? (PORTAL[body.kind] ?? body.kind) : null,
      moved_from: others.map((o) => `${o.persona_kind}${o.scope_label ? ` (${o.scope_label})` : ""}`),
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
