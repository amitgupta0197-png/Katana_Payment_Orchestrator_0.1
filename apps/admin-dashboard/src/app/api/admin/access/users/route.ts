// POST: create a user (authservice_db.users) and grant one initial persona
// assignment (iamservice_db.user_personas). SUPER_ADMIN only.
// PROVIDER scope_id must be a provider uuid; MERCHANT scope_id is a merchant
// code string. Persona row enforces uniqueness via the (user_id, is_primary)
// unique-where-primary index.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

const addUserSchema = z.object({
  email: z.string().email(),
  full_name: z.string().min(2).max(255),
  persona: z.enum(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]),
  scope_id: z.string().optional(),
  scope_label: z.string().optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  let body;
  try { body = addUserSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  if (body.persona !== "SUPER_ADMIN" && !body.scope_id) {
    return NextResponse.json({ error: "scope_id required for PROVIDER/MERCHANT" }, { status: 400 });
  }
  try {
    const userRow = await rows<{ id: string; email: string }>(
      "auth",
      `INSERT INTO users (email, full_name, status)
       VALUES ($1, $2, 'active')
       ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name, updated_at = now()
       RETURNING id::text, email::text`,
      [body.email, body.full_name],
    );
    const user = userRow[0];

    const assignmentRow = await rows<{ id: string }>(
      "iam",
      `INSERT INTO user_personas (user_id, persona_kind, scope_id, scope_label, is_primary, granted_by)
       VALUES ($1::uuid, $2, $3, $4, true, $5)
       RETURNING id::text`,
      [user.id, body.persona, body.scope_id ?? null, body.scope_label ?? "", g.session.email],
    );

    return NextResponse.json({
      user_id: user.id,
      email: user.email,
      persona: body.persona,
      assignment_id: assignmentRow[0].id,
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
