// SUPER_ADMIN CRUD; PROVIDER/MERCHANT C R own (PRODUCT_VISION §3.11).
// Source of truth: iamservice_db.user_personas.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  try {
    const params: unknown[] = [];
    let where = "TRUE";
    if (s.persona === "PROVIDER") { where = `persona_kind = 'PROVIDER' AND scope_id = $1`; params.push(s.scope_id); }
    else if (s.persona === "MERCHANT") { where = `persona_kind = 'MERCHANT' AND scope_id = $1`; params.push(s.scope_id); }
    const assignments = await rows<any>("iam", `
      SELECT id::text, user_id::text, persona_kind, COALESCE(scope_id,'') AS scope_id,
             COALESCE(scope_label,'') AS scope_label, is_primary,
             COALESCE(granted_by,'') AS granted_by, granted_at
        FROM user_personas
       WHERE ${where}
       ORDER BY granted_at DESC LIMIT 500
    `, params).catch(() => []);
    return NextResponse.json({ assignments });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
