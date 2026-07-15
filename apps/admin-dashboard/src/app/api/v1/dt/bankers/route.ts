// GET  /api/v1/dt/bankers — list banker logins (BANKER persona grants + user status).
// POST /api/v1/dt/bankers — provision a separate banker login: creates (or reuses) the
// auth user and grants a BANKER persona scoped to the banker_id. Mirrors the merchant
// auto-provisioning pattern: a brand-new email gets a one-time password returned ONCE
// to the admin to hand to the banker; an existing email is just granted the persona.
import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { hashPassword, generatePassword } from "@/lib/password";
import { auditDt } from "@/lib/dt";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE", "RISK"]);
  if ("response" in g) return g.response;
  try {
    const grants = await rows<any>("iam", `
      SELECT user_id::text, COALESCE(scope_id,'') AS banker_id,
             COALESCE(scope_label,'') AS scope_label, granted_at
        FROM user_personas WHERE persona_kind = 'BANKER'
       ORDER BY granted_at DESC LIMIT 500
    `);
    let bankers: any[] = [];
    if (grants.length) {
      const users = await rows<any>("auth", `
        SELECT id::text, email::text, COALESCE(full_name,'') AS full_name, status
          FROM users WHERE id = ANY($1::uuid[])
      `, [grants.map((r) => r.user_id)]);
      const byId = new Map(users.map((u) => [u.id, u]));
      bankers = grants.map((r) => ({
        banker_id: r.banker_id,
        email: byId.get(r.user_id)?.email ?? "",
        full_name: byId.get(r.user_id)?.full_name ?? "",
        status: byId.get(r.user_id)?.status ?? "unknown",
        granted_at: r.granted_at,
      }));
    }
    return NextResponse.json({ bankers });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const schema = z.object({
  banker_id: z.string().trim().min(1).max(120),
  email: z.string().email(),
  full_name: z.string().trim().max(200).optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN"]);
  if ("response" in g) return g.response;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const existing = await rows<{ id: string }>("auth", `SELECT id::text FROM users WHERE email = $1`, [body.email]);
    let userId: string;
    let tempPassword: string | null = null;
    if (existing.length) {
      userId = existing[0].id;
    } else {
      tempPassword = generatePassword();
      const created = await rows<{ id: string }>("auth", `
        INSERT INTO users (id, email, full_name, password_hash, status)
        VALUES (gen_random_uuid(), $1, $2, $3, 'active') RETURNING id::text
      `, [body.email, body.full_name || body.banker_id, hashPassword(tempPassword)]);
      userId = created[0].id;
    }
    // Ensure a BANKER persona scoped to this banker_id (idempotent). scope_id is the
    // banker_id text used across the DT tables (dt_purchases.banker_id etc.).
    await rows("iam", `
      INSERT INTO user_personas (id, user_id, persona_kind, scope_id, scope_label, is_primary, granted_by)
      SELECT gen_random_uuid(), $1::uuid, 'BANKER', $2, $3, true, $4
      WHERE NOT EXISTS (
        SELECT 1 FROM user_personas WHERE user_id = $1::uuid AND persona_kind = 'BANKER' AND scope_id = $2
      )
    `, [userId, body.banker_id, `${body.banker_id} — DT Banker`, g.session.email]);
    await auditDt(g.session.email, "BANKER_LOGIN_PROVISION", "banker_login", body.banker_id, null, { email: body.email, existing: existing.length > 0 });
    return NextResponse.json({
      banker_id: body.banker_id,
      login: { email: body.email, password: tempPassword, existing: existing.length > 0 },
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
